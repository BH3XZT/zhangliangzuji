"""FIT（Garmin / 佳明 / 各类运动手表）二进制轨迹解析（WGS-84）。

只依赖标准库，支持普通消息与压缩时间戳消息，提取 record（消息号 20）中的
经纬度、海拔、速度、时间。
"""

from __future__ import annotations

import struct

from ..models import ParserOutput, RawTrack
from .common import ParseError

_FIT_EPOCH = 631065600  # 1989-12-31T00:00:00Z

# 基础类型号 -> 默认字节数
_BASE_SIZE = {
    0: 1,
    1: 1,
    2: 1,
    3: 2,
    4: 2,
    5: 4,
    6: 4,
    7: 1,
    8: 4,
    9: 8,
    10: 1,
    11: 2,
    12: 4,
    13: 1,
    14: 8,
    15: 8,
}
_SIGNED_TYPES = {1, 3, 5, 14}


def _decode_value(raw: bytes, base_type: int, endian: str):
    if not raw:
        return None
    if base_type == 8 and len(raw) == 4:
        return struct.unpack(("<f" if endian == "little" else ">f"), raw)[0]
    if base_type == 9 and len(raw) == 8:
        return struct.unpack(("<d" if endian == "little" else ">d"), raw)[0]
    signed = base_type in _SIGNED_TYPES
    return int.from_bytes(raw, "little" if endian == "little" else "big", signed=signed)


def _read_fields(data: bytes, pos: int, fields, endian: str, skip_timestamp: bool = False):
    values = {}
    consumed = 0
    for field_num, field_size, base_type in fields:
        if skip_timestamp and field_num == 253:
            continue
        end = pos + consumed + field_size
        if end > len(data):
            raise ParseError("FIT 数据在记录中间意外结束")
        raw = data[pos + consumed : end]
        consumed += field_size
        if field_num in (253, 0, 1, 2, 6):
            values[field_num] = _decode_value(raw, base_type, endian)
    return values, consumed


def _parse_definition(data: bytes, pos: int, header: int, definitions: dict) -> int:
    if pos + 3 > len(data):
        raise ParseError("FIT 定义消息不完整")
    pos += 1  # reserved
    architecture = data[pos]
    pos += 1
    endian = "big" if architecture == 1 else "little"
    global_num = int.from_bytes(data[pos : pos + 2], endian)
    pos += 2
    if pos >= len(data):
        raise ParseError("FIT 定义消息不完整")
    field_count = data[pos]
    pos += 1
    fields = []
    for _ in range(field_count):
        if pos + 3 > len(data):
            raise ParseError("FIT 字段定义不完整")
        field_num = data[pos]
        field_size = data[pos + 1]
        base_type = data[pos + 2] & 0x1F
        pos += 3
        fields.append((field_num, field_size, base_type))
    if header & 0x20:  # 开发者字段
        if pos >= len(data):
            raise ParseError("FIT 开发者字段不完整")
        dev_count = data[pos]
        pos += 1
        for _ in range(dev_count):
            if pos + 3 > len(data):
                raise ParseError("FIT 开发者字段不完整")
            pos += 3
    local_type = header & 0x0F
    definitions[local_type] = (global_num, fields, endian)
    return pos


def parse(data: bytes, filename: str) -> ParserOutput:
    if len(data) < 12 or data[8:12] != b".FIT":
        raise ParseError("不是有效的 FIT 文件（缺少 .FIT 标识）")
    header_size = data[0]
    if header_size not in (12, 14):
        raise ParseError(f"不支持的 FIT 头长度：{header_size}")
    data_size = int.from_bytes(data[4:8], "little")
    end = min(len(data), header_size + data_size)

    definitions: dict[int, tuple] = {}
    points: list[list] = []
    pos = header_size
    last_timestamp = None

    while pos < end:
        header = data[pos]
        pos += 1
        if header & 0x80:  # 压缩时间戳数据消息
            local_type = (header >> 5) & 0x03
            offset = header & 0x1F
            definition = definitions.get(local_type)
            if definition is None:
                raise ParseError("FIT 压缩消息引用了未定义的消息类型")
            global_num, fields, endian = definition
            if last_timestamp is None:
                last_timestamp = offset
            else:
                last_timestamp += (offset - (last_timestamp % 32)) & 0x1F
            timestamp = last_timestamp
            values, consumed = _read_fields(data, pos, fields, endian, skip_timestamp=True)
            pos += consumed
            if global_num != 20:
                continue
            lat = values.get(0)
            lng = values.get(1)
        elif header & 0x40:  # 定义消息
            pos = _parse_definition(data, pos, header, definitions)
            continue
        else:  # 普通数据消息
            local_type = header & 0x0F
            definition = definitions.get(local_type)
            if definition is None:
                raise ParseError("FIT 数据消息引用了未定义的消息类型")
            global_num, fields, endian = definition
            values, consumed = _read_fields(data, pos, fields, endian)
            pos += consumed
            if global_num != 20:
                continue
            timestamp = values.get(253)
            if timestamp is not None and timestamp != 0xFFFFFFFF:
                last_timestamp = timestamp
            else:
                timestamp = last_timestamp
            lat = values.get(0)
            lng = values.get(1)

        # 组装记录点（消息号 20：record）
        if lat is None or lng is None or lat == 0x7FFFFFFF or lng == 0x7FFFFFFF:
            continue
        lat_deg = lat * (180.0 / 2147483648.0)
        lng_deg = lng * (180.0 / 2147483648.0)
        if not (-90.0 <= lat_deg <= 90.0 and -180.0 <= lng_deg <= 180.0):
            continue
        altitude = values.get(2)
        speed_raw = values.get(6)
        if altitude is not None and altitude != 0xFFFF:
            altitude = altitude / 5.0 - 500.0
        else:
            altitude = None
        if speed_raw is not None and speed_raw != 0xFFFF:
            speed = speed_raw / 1000.0
        else:
            speed = None
        time_value = timestamp + _FIT_EPOCH if timestamp is not None else None
        points.append([lng_deg, lat_deg, altitude, speed, time_value])

    if not points:
        raise ParseError("FIT 文件中没有找到轨迹记录点")
    return ParserOutput(
        tracks=[RawTrack(name=filename.rsplit(".", 1)[0], points=points, segments=[0])],
        crs="WGS84",
        format="fit",
        format_label="FIT",
    )
