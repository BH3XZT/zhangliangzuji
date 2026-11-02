"""JSON 类轨迹解析：百度地图、高德地图、Google 时间线、通用 JSON。

各格式坐标默认：
- 百度（BD-09）
- 高德（GCJ-02）
- Google 时间线（WGS-84）
- 通用 JSON（WGS-84；文件名含 baidu/百度 或 amap/gaode/高德 时自动匹配）
"""

from __future__ import annotations

import json
import re

from ..models import ParserOutput, RawTrack
from .common import ParseError, decode_text, parse_speed, parse_time_any, to_float

_LAT_KEYS = (
    "latitude", "lat", "lat_deg", "latitude_deg", "wd", "y", "纬度", "lati", "gps_lat",
)
_LNG_KEYS = (
    "longitude", "lng", "lon", "long", "lng_deg", "longitude_deg", "jd", "x", "经度",
    "gps_lng", "gps_lon",
)
_TIME_KEYS = (
    "loc_time", "location_time", "time", "timestamp", "timestamp_ms", "ts", "gps_time",
    "coordinate_time", "coord_time", "create_time", "record_time", "datetime", "date",
    "时间", "采集时间", "定位时间",
)
_ELE_KEYS = ("height", "altitude", "alt", "ele", "elevation", "海拔", "高度")
_SPEED_KEYS = ("speed", "velocity", "spd", "速度")
_NAME_KEYS = ("name", "title", "entity_name", "track_name", "label", "备注", "名称", "轨迹名称")
_NESTED_KEYS = ("location", "position", "coord", "coordinates", "point", "gps", "position_info")


def _lower_map(node: dict) -> dict:
    return {str(key).lower(): key for key in node.keys()}


def _lookup(node: dict, keys, lower: dict | None = None):
    if not isinstance(node, dict):
        return None
    for key in keys:
        if key in node:
            return node[key]
    if lower is None:
        lower = _lower_map(node)
    for key in keys:
        real = lower.get(key.lower())
        if real is not None:
            return node[real]
    return None


def _dict_name(node: dict) -> str | None:
    value = _lookup(node, _NAME_KEYS)
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _looks_like_pair(value) -> bool:
    text = str(value or "").strip()
    return bool(re.fullmatch(r"[-+]?\d+(\.\d+)?\s*[, ]\s*[-+]?\d+(\.\d+)?", text))


def _split_pair(value) -> list | None:
    text = str(value or "").strip()
    parts = re.split(r"[, ]+", text)
    if len(parts) < 2:
        return None
    lng, lat = to_float(parts[0]), to_float(parts[1])
    if lng is None or lat is None:
        return None
    if abs(lat) > 90 and abs(lng) <= 90:
        lng, lat = lat, lng
    if abs(lng) > 180 or abs(lat) > 90:
        return None
    return [lng, lat, None, None, None]


def _point_from_list(values) -> list | None:
    if not isinstance(values, (list, tuple)) or len(values) < 2:
        return None
    first, second = to_float(values[0]), to_float(values[1])
    if first is None or second is None:
        return None
    if abs(first) > 180 or abs(second) > 180:
        return None
    # 判断经纬度顺序
    if abs(first) <= 90 and abs(second) <= 90:
        # 中国范围内经度通常大于纬度
        if 70.0 <= abs(first) <= 140.0 and 10.0 <= abs(second) <= 60.0:
            lng, lat = first, second
        elif 70.0 <= abs(second) <= 140.0 and 10.0 <= abs(first) <= 60.0:
            lng, lat = second, first
        elif abs(first) <= 90 and abs(second) > 90:
            lng, lat = second, first
        else:
            lng, lat = first, second
    elif abs(first) > 90 and abs(second) <= 90:
        lng, lat = first, second
    elif abs(second) > 90 and abs(first) <= 90:
        lng, lat = second, first
    else:
        lng, lat = first, second
    if abs(lng) > 180 or abs(lat) > 90:
        return None
    ele = None
    time_value = None
    if len(values) >= 3:
        third = to_float(values[2])
        if third is not None:
            if third > 1e9:
                time_value = parse_time_any(third)
            else:
                ele = third
    return [lng, lat, ele, None, time_value]


def _point_from_dict(node: dict, speed_unit: str = "km/h") -> list | None:
    if not isinstance(node, dict):
        return None
    lower = _lower_map(node)
    lat = to_float(_lookup(node, _LAT_KEYS, lower))
    lng = to_float(_lookup(node, _LNG_KEYS, lower))
    if lng is None or lat is None:
        for nested_key in _NESTED_KEYS:
            nested = _lookup(node, (nested_key,), lower)
            if isinstance(nested, dict):
                point = _point_from_dict(nested, speed_unit)
                if point:
                    return point
            elif isinstance(nested, str) and _looks_like_pair(nested):
                point = _split_pair(nested)
                if point:
                    return point
            elif isinstance(nested, (list, tuple)):
                point = _point_from_list(nested)
                if point:
                    return point
        return None
    if abs(lng) > 180 or abs(lat) > 90:
        return None
    ele = to_float(_lookup(node, _ELE_KEYS, lower))
    time_value = parse_time_any(_lookup(node, _TIME_KEYS, lower))
    speed = parse_speed(_lookup(node, _SPEED_KEYS, lower), unit=speed_unit)
    return [lng, lat, ele, speed, time_value]


def _points_from_list(items) -> list[list] | None:
    if not isinstance(items, (list, tuple)) or not items:
        return None
    points = []
    for item in items:
        if isinstance(item, dict):
            point = _point_from_dict(item)
        elif isinstance(item, (list, tuple)):
            point = _point_from_list(item)
        elif isinstance(item, str) and _looks_like_pair(item):
            point = _split_pair(item)
        else:
            return None
        if not point:
            return None
        points.append(point)
    return points


def _polyline_points(text: str) -> list[list]:
    points = []
    for chunk in re.split(r"[;|\n]+", text or ""):
        chunk = chunk.strip()
        if not chunk:
            continue
        point = _split_pair(chunk)
        if point:
            points.append(point)
    return points


def _looks_like_polyline(text) -> bool:
    if not isinstance(text, str) or ";" not in text:
        return False
    return bool(re.search(r"\d", text))


def extract_tracks(obj, filename: str) -> list[RawTrack]:
    """通用结构提取：识别任意嵌套中的点数组 / 折线字符串。"""
    tracks: list[RawTrack] = []

    def add(name, points):
        if points:
            tracks.append(
                RawTrack(name=(name or filename.rsplit(".", 1)[0]).strip(), points=points, segments=[0])
            )

    def walk(node, name_hint: str, depth: int = 0):
        if depth > 14:
            return
        if isinstance(node, dict):
            name = _dict_name(node) or name_hint
            consumed_keys = set()
            for key, value in node.items():
                key_lower = str(key).lower()
                if isinstance(value, str) and _looks_like_polyline(value):
                    points = _polyline_points(value)
                    if points:
                        add(name, points)
                        consumed_keys.add(key)
                elif isinstance(value, list):
                    points = _points_from_list(value)
                    if points:
                        add(name, points)
                        consumed_keys.add(key)
            for key, value in node.items():
                if key in consumed_keys:
                    continue
                if isinstance(value, (dict, list)):
                    walk(value, name, depth + 1)
        elif isinstance(node, list):
            points = _points_from_list(node)
            if points:
                add(name_hint, points)
                return
            for item in node:
                if isinstance(item, (dict, list)):
                    walk(item, name_hint, depth + 1)

    walk(obj, "")
    # 去重（同一轨迹被多处引用时）
    unique: list[RawTrack] = []
    seen = set()
    for track in tracks:
        signature = (track.name, len(track.points), round(track.points[0][0], 6), round(track.points[0][1], 6))
        if signature in seen:
            continue
        seen.add(signature)
        unique.append(track)
    # 重名处理
    counts: dict[str, int] = {}
    for index, track in enumerate(unique):
        base = track.name or f"轨迹{index + 1}"
        counts[base] = counts.get(base, 0) + 1
        if counts[base] > 1:
            track.name = f"{base} {counts[base]}"
    return unique


def _load_json(data: bytes):
    try:
        return json.loads(decode_text(data))
    except json.JSONDecodeError as exc:
        raise ParseError(f"JSON 格式错误：{exc}") from exc


def _e7(value) -> float | None:
    number = to_float(value)
    if number is None:
        return None
    return number / 1e7


def _google_tracks(obj, filename: str) -> list[RawTrack]:
    tracks: list[RawTrack] = []
    if isinstance(obj, dict) and isinstance(obj.get("locations"), list):
        points = []
        for item in obj["locations"]:
            if not isinstance(item, dict):
                continue
            lat = _e7(item.get("latitudeE7", item.get("latitude")))
            lng = _e7(item.get("longitudeE7", item.get("longitude")))
            if lat is None or lng is None:
                continue
            timestamp = parse_time_any(item.get("timestampMs") or item.get("timestamp"))
            points.append([lng, lat, to_float(item.get("altitude")), None, timestamp])
        if points:
            points.sort(key=lambda p: (p[4] is None, p[4] if p[4] is not None else 0))
            tracks.append(RawTrack(name=filename.rsplit(".", 1)[0], points=points, segments=[0]))
    if isinstance(obj, dict) and isinstance(obj.get("semanticSegments"), list):
        for index, segment in enumerate(obj["semanticSegments"]):
            if not isinstance(segment, dict):
                continue
            path = segment.get("timelinePath") or []
            points = []
            for item in path:
                if not isinstance(item, dict):
                    continue
                raw = str(item.get("point", ""))
                match = re.search(r"geo:?\s*([-+]?\d+(?:\.\d+)?),([-+]?\d+(?:\.\d+)?)", raw)
                if not match:
                    continue
                lat, lng = to_float(match.group(1)), to_float(match.group(2))
                if lat is None or lng is None:
                    continue
                points.append([lng, lat, None, None, parse_time_any(item.get("time"))])
            if points:
                tracks.append(
                    RawTrack(name=f"Google 时间线 {index + 1}", points=points, segments=[0])
                )
    if isinstance(obj, dict) and isinstance(obj.get("timelineObjects"), list):
        for index, item in enumerate(obj["timelineObjects"]):
            if not isinstance(item, dict):
                continue
            activity = item.get("activitySegment") or {}
            points = []
            for key, time_key in (("startLocation", "startTimestampMs"), ("endLocation", "endTimestampMs")):
                location = activity.get(key)
                if not isinstance(location, dict):
                    continue
                lat = _e7(location.get("latitudeE7"))
                lng = _e7(location.get("longitudeE7"))
                if lat is None or lng is None:
                    continue
                timestamp = parse_time_any(activity.get(time_key) or activity.get("duration", {}).get(time_key))
                points.append([lng, lat, None, None, timestamp])
            if len(points) >= 1:
                tracks.append(RawTrack(name=f"Google 活动 {index + 1}", points=points, segments=[0]))
    return tracks


def _detect_filename_crs(filename: str) -> str | None:
    name = (filename or "").lower()
    if any(token in name for token in ("baidu", "百度", "bd09")):
        return "BD09"
    if any(token in name for token in ("amap", "gaode", "高德", "gcj")):
        return "GCJ02"
    return None


def detect_json_kind(obj, filename: str) -> str:
    """识别 JSON 属于哪种轨迹来源：google / baidu / amap / generic。"""
    name = (filename or "").lower()
    if isinstance(obj, dict):
        if "semanticSegments" in obj or "timelineObjects" in obj:
            return "google"
        if isinstance(obj.get("locations"), list):
            sample = next((item for item in obj["locations"] if isinstance(item, dict)), {})
            if "latitudeE7" in sample or "longitudeE7" in sample:
                return "google"
        serialized_keys = set()
        if isinstance(obj.get("entities"), list):
            serialized_keys.add("entities")
        text = json.dumps(obj, ensure_ascii=False)[:4000]
        if "entities" in serialized_keys or '"track_points"' in text or '"loc_time"' in text:
            return "baidu"
        if '"polyline"' in text or '"points":"' in text.replace(" ", ""):
            return "amap"
    if any(token in name for token in ("baidu", "百度")):
        return "baidu"
    if any(token in name for token in ("amap", "gaode", "高德")):
        return "amap"
    if any(token in name for token in ("google", "timeline", "时间线")):
        return "google"
    return "generic"


def parse_baidu(data: bytes, filename: str) -> ParserOutput:
    obj = _load_json(data)
    tracks = extract_tracks(obj, filename)
    if not tracks:
        raise ParseError("百度地图 JSON 中没有找到轨迹点（支持鹰眼 track_points / points / entities 等结构）")
    return ParserOutput(
        tracks=tracks,
        crs="BD09",
        format="baidu",
        format_label="百度地图 JSON",
        warnings=["百度坐标（BD-09）已自动转换为 WGS-84，可与其他地图轨迹对齐"],
    )


def parse_amap(data: bytes, filename: str) -> ParserOutput:
    obj = _load_json(data)
    tracks = extract_tracks(obj, filename)
    if not tracks:
        raise ParseError("高德地图 JSON 中没有找到轨迹点（支持 tracks.points / polyline 等结构）")
    return ParserOutput(
        tracks=tracks,
        crs="GCJ02",
        format="amap",
        format_label="高德地图 JSON",
        warnings=["高德坐标（GCJ-02）已自动转换为 WGS-84，可与其他地图轨迹对齐"],
    )


def parse_google(data: bytes, filename: str) -> ParserOutput:
    obj = _load_json(data)
    tracks = _google_tracks(obj, filename)
    if not tracks:
        tracks = extract_tracks(obj, filename)
    if not tracks:
        raise ParseError("Google 时间线 JSON 中没有找到轨迹点")
    return ParserOutput(
        tracks=tracks,
        crs="WGS84",
        format="google",
        format_label="Google 时间线",
    )


def parse_generic(data: bytes, filename: str) -> ParserOutput:
    obj = _load_json(data)
    tracks = extract_tracks(obj, filename)
    if not tracks:
        raise ParseError("JSON 中没有找到轨迹点数据")
    crs = _detect_filename_crs(filename) or "WGS84"
    return ParserOutput(
        tracks=tracks,
        crs=crs,
        format="json",
        format_label="通用 JSON",
        warnings=[f"已按文件名推断为 {crs} 坐标，如显示偏移可在界面中修改坐标系"],
    )
