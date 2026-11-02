"""解析器公用工具：文本解码、XML 命名空间、时间与数值解析。"""

from __future__ import annotations

import math
import re
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone

# 中文导出的“无时区时间”普遍是北京时间
CN_TZ = timezone(timedelta(hours=8))

_TIME_FORMATS = (
    "%Y-%m-%d %H:%M:%S",
    "%Y-%m-%dT%H:%M:%S",
    "%Y-%m-%d %H:%M",
    "%Y/%m/%d %H:%M:%S",
    "%Y/%m/%d %H:%M",
    "%Y%m%d%H%M%S",
    "%Y-%m-%d",
)


class ParseError(Exception):
    """无法解析文件时抛出。"""


def decode_text(data: bytes) -> str:
    """尽量用正确编码把字节解码为文本。"""
    if isinstance(data, str):
        return data
    if data.startswith(b"\xef\xbb\xbf"):
        return data.decode("utf-8-sig", errors="replace")
    if data.startswith(b"\xff\xfe") or data.startswith(b"\xfe\xff"):
        return data.decode("utf-16", errors="replace")
    for enc in ("utf-8", "gb18030", "gbk", "big5", "latin-1"):
        try:
            return data.decode(enc)
        except (UnicodeDecodeError, LookupError):
            continue
    return data.decode("utf-8", errors="replace")


def localname(tag) -> str:
    if tag is None:
        return ""
    if isinstance(tag, str) and "}" in tag:
        return tag.rsplit("}", 1)[1]
    return str(tag)


def iter_local(element, name: str):
    for child in element.iter():
        if localname(child.tag) == name:
            yield child


def child_elements(element):
    return list(element) if element is not None else []


def child_text(element, *names: str):
    """按 localname 找到第一个子元素并返回其文本。"""
    if element is None:
        return None
    wanted = set(names)
    for child in element:
        if localname(child.tag) in wanted:
            return (child.text or "").strip() or None
    return None


def deep_text(element, *names: str):
    """深度优先查找第一个匹配 localname 的文本。"""
    if element is None:
        return None
    wanted = set(names)
    for child in element.iter():
        if localname(child.tag) in wanted:
            text = (child.text or "").strip()
            if text:
                return text
    return None


def to_float(value) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        value = float(value)
        return value if math.isfinite(value) else None
    text = str(value).strip().replace(",", "")
    if not text:
        return None
    try:
        number = float(text)
    except ValueError:
        return None
    return number if math.isfinite(number) else None


def parse_time_any(value) -> float | None:
    """把 Unix 秒/毫秒、ISO8601、常见日期时间字符串解析为 Unix 秒（UTC）。"""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
        if not math.isfinite(number) or number <= 0:
            return None
        if number > 1e17:  # 纳秒
            number /= 1e9
        elif number > 1e14:  # 微秒
            number /= 1e6
        elif number > 1e12:  # 毫秒
            number /= 1e3
        return number

    text = str(value).strip()
    if not text:
        return None
    # 纯数字时间戳
    if re.fullmatch(r"[-+]?\d+(\.\d+)?", text):
        number = float(text)
        if number <= 0:
            return None
        if number > 1e17:
            number /= 1e9
        elif number > 1e14:
            number /= 1e6
        elif number > 1e12:
            number /= 1e3
        return number

    normalized = text.replace("Z", "+00:00").replace("z", "+00:00")
    if "/" in normalized and "-" not in normalized:
        normalized = normalized.replace("/", "-")
    try:
        dt = datetime.fromisoformat(normalized)
    except ValueError:
        dt = None
    if dt is None:
        for fmt in _TIME_FORMATS:
            try:
                dt = datetime.strptime(text, fmt)
                break
            except ValueError:
                dt = None
    if dt is None:
        # 处理 "2023-01-02 12:00:00.123" 之类
        match = re.match(r"^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?", text)
        if match:
            year, month, day, hour, minute, second = (int(x) if x else 0 for x in match.groups())
            dt = datetime(year, month, day, hour, minute, second, tzinfo=CN_TZ)
        else:
            return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=CN_TZ)
    return dt.timestamp()


def iso_utc(timestamp: float | None) -> str | None:
    if timestamp is None:
        return None
    try:
        dt = datetime.fromtimestamp(float(timestamp), tz=timezone.utc)
    except (OverflowError, OSError, ValueError):
        return None
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_speed(value, *, unit: str = "m/s") -> float | None:
    """解析速度，统一为 m/s。unit: m/s 或 km/h。"""
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    detected = unit
    lowered = text.lower()
    if "km/h" in lowered or "kmh" in lowered or "公里/小时" in text or "公里每小时" in text:
        detected = "km/h"
        text = re.sub(r"(?i)km/?h|公里/小时|公里每小时", "", text)
    elif "m/s" in lowered or "米/秒" in text:
        detected = "m/s"
        text = re.sub(r"(?i)m/s|米/秒", "", text)
    number = to_float(text)
    if number is None or number < 0:
        return None
    if detected == "km/h":
        number /= 3.6
    return number


def xml_root(data: bytes):
    try:
        return ET.fromstring(data)
    except ET.ParseError as exc:
        raise ParseError(f"XML 解析失败：{exc}") from exc
