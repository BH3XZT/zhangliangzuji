"""NMEA 0183 日志解析（GPRMC / GNRMC / GPGGA，WGS-84）。"""

from __future__ import annotations

from datetime import datetime, timezone

from ..models import ParserOutput, RawTrack
from .common import ParseError, decode_text, to_float


def _dm_to_degrees(value: str | None, hemisphere: str | None) -> float | None:
    value = (value or "").strip()
    hemisphere = (hemisphere or "").strip().upper()
    if not value or "." not in value:
        return None
    dot = value.find(".")
    if dot < 3:
        return None
    degrees = to_float(value[: dot - 2])
    minutes = to_float(value[dot - 2 :])
    if degrees is None or minutes is None:
        return None
    result = degrees + minutes / 60.0
    if hemisphere in ("S", "W"):
        result = -result
    return result


def _utc_from_nmea(date_text: str | None, time_text: str | None) -> float | None:
    date_text = (date_text or "").strip()
    time_text = (time_text or "").strip()
    if len(date_text) < 6 or "." not in time_text:
        return None
    try:
        day = int(date_text[0:2])
        month = int(date_text[2:4])
        year = int(date_text[4:6])
        year += 2000 if year < 70 else 1900
        hour = int(time_text[0:2])
        minute = int(time_text[2:4])
        second_float = float(time_text[4:])
        second = int(second_float)
        micro = int(round((second_float - second) * 1e6))
        dt = datetime(year, month, day, hour, minute, second, micro, tzinfo=timezone.utc)
        return dt.timestamp()
    except (ValueError, IndexError):
        return None


def parse(data: bytes, filename: str) -> ParserOutput:
    text = decode_text(data)
    records: list[dict] = []
    index_by_time: dict[str, int] = {}
    warnings: list[str] = []

    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("$"):
            continue
        if "*" in line:
            line = line.split("*", 1)[0]
        parts = line.split(",")
        if not parts:
            continue
        sentence = parts[0][3:] if len(parts[0]) > 3 else ""
        if sentence == "RMC" and len(parts) >= 10:
            lat = _dm_to_degrees(parts[3], parts[4])
            lng = _dm_to_degrees(parts[5], parts[6])
            if lat is None or lng is None:
                continue
            speed_knots = to_float(parts[7])
            speed = speed_knots * 0.514444 if speed_knots is not None else None
            time_text = parts[1].strip()
            date_text = parts[9].strip()
            timestamp = _utc_from_nmea(date_text, time_text)
            record = {
                "lng": lng,
                "lat": lat,
                "ele": None,
                "speed": speed,
                "time": timestamp,
                "date": date_text,
                "time_text": time_text,
            }
            if time_text and time_text in index_by_time:
                index_by_time[time_text] = index_by_time[time_text]
                records[index_by_time[time_text]].update(
                    {key: value for key, value in record.items() if value is not None}
                )
            else:
                if time_text:
                    index_by_time[time_text] = len(records)
                records.append(record)
        elif sentence in ("GGA",) and len(parts) >= 10:
            lat = _dm_to_degrees(parts[2], parts[3])
            lng = _dm_to_degrees(parts[4], parts[5])
            if lat is None or lng is None:
                continue
            ele = to_float(parts[9])
            time_text = parts[1].strip()
            if time_text and time_text in index_by_time:
                existing = records[index_by_time[time_text]]
                if ele is not None:
                    existing["ele"] = ele
            else:
                record = {
                    "lng": lng,
                    "lat": lat,
                    "ele": ele,
                    "speed": None,
                    "time": None,
                    "date": None,
                    "time_text": time_text,
                }
                if time_text:
                    index_by_time[time_text] = len(records)
                records.append(record)

    if not records:
        raise ParseError("NMEA 日志中没有找到有效的 GPRMC / GPGGA 语句")

    dates = {record["date"] for record in records if record.get("date")}
    only_date = next(iter(dates)) if len(dates) == 1 else None
    for record in records:
        if record.get("time") is None:
            date_text = record.get("date") or only_date
            if date_text:
                record["time"] = _utc_from_nmea(date_text, record.get("time_text"))

    points = [[r["lng"], r["lat"], r["ele"], r["speed"], r["time"]] for r in records]
    if all(p[4] is None for p in points):
        warnings.append("NMEA 日志缺少日期信息（无 RMC 日期），已忽略时间轴")
    elif any(p[4] is None for p in points):
        warnings.append("部分 NMEA 语句缺少日期，已按同一日期补齐")
        points.sort(key=lambda p: (p[4] is None, p[4] if p[4] is not None else 0))

    segments = [0]
    last_time = None
    for index, point in enumerate(points):
        t = point[4]
        if last_time is not None and t is not None and t - last_time > 1800:
            segments.append(index)
        if t is not None:
            last_time = t
    return ParserOutput(
        tracks=[RawTrack(name=filename.rsplit(".", 1)[0], points=points, segments=segments)],
        crs="WGS84",
        format="nmea",
        format_label="NMEA",
        warnings=warnings,
    )
