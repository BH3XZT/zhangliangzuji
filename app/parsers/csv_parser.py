"""CSV / TSV 轨迹解析（默认 WGS-84，可按需覆盖坐标系）。"""

from __future__ import annotations

import csv
import io
import re
import statistics

from ..models import ParserOutput, RawTrack
from .common import ParseError, decode_text, parse_speed, parse_time_any, to_float

_ALIASES = {
    "lng": {
        "lng", "lon", "long", "longitude", "x", "jd", "jingdu", "经度", "经度值", "东经",
        "lng_deg", "lon_deg", "longitude_deg", "gps_lng", "gps_lon", "coord_lng",
    },
    "lat": {
        "lat", "latitude", "y", "wd", "weidu", "纬度", "纬度值", "北纬",
        "lat_deg", "latitude_deg", "gps_lat", "coord_lat",
    },
    "time": {
        "time", "timestamp", "datetime", "date", "时间", "日期", "时间戳", "时刻",
        "loc_time", "location_time", "coordinate_time", "gps_time", "utc_time", "create_time",
        "record_time", "date_time", "ts",
    },
    "ele": {
        "ele", "elevation", "altitude", "alt", "height", "海拔", "高度", "高程", "alt_m",
        "elevation_m", "height_m",
    },
    "speed": {
        "speed", "velocity", "速度", "时速", "kmh", "km/h", "m/s", "speed_kmh", "speed_ms",
    },
    "name": {
        "name", "track", "track_name", "轨迹", "轨迹名称", "名称", "文件", "filename",
    },
}


def _norm_cell(value) -> str:
    text = str(value or "").strip().lower()
    text = text.replace("（", "(").replace("）", ")").replace("/", "/")
    text = re.sub(r"\s+", "", text)
    return text


def _match_field(header_cells) -> dict[str, int]:
    mapping: dict[str, int] = {}
    for index, cell in enumerate(header_cells):
        key = _norm_cell(cell)
        if not key:
            continue
        for field, aliases in _ALIASES.items():
            if field in mapping:
                continue
            if key in aliases:
                mapping[field] = index
                break
    return mapping


def _is_header(cells) -> bool:
    mapping = _match_field(cells)
    return "lng" in mapping and "lat" in mapping


def _sniff_delimiter(text: str) -> str:
    first_lines = [line for line in text.splitlines() if line.strip()][:5]
    if not first_lines:
        return ","
    sample = "\n".join(first_lines)
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",;\t|")
        return dialect.delimiter
    except csv.Error:
        pass
    counts = {",": sample.count(","), ";": sample.count(";"), "\t": sample.count("\t"), "|": sample.count("|")}
    best = max(counts, key=counts.get)
    return best if counts[best] > 0 else ","


def _numeric_columns(rows, ncols):
    columns = {}
    for idx in range(ncols):
        values = []
        for row in rows:
            if idx < len(row):
                value = to_float(row[idx])
                if value is not None:
                    values.append(value)
        if len(values) >= max(1, int(len(rows) * 0.6)):
            columns[idx] = values
    return columns


def _guess_columns(rows, ncols):
    """无表头时猜测经纬度/时间列。"""
    numeric = _numeric_columns(rows, ncols)
    # 时间列：数值明显大于 1e9，或字符串日期
    time_idx = None
    for idx in range(ncols):
        hits = 0
        for row in rows:
            if idx >= len(row):
                continue
            value = to_float(row[idx])
            if value is not None and value > 1e9:
                hits += 1
            elif re.search(r"\d{4}[-/]\d{1,2}[-/]\d{1,2}", str(row[idx] or "")):
                hits += 1
        if hits >= max(2, int(len(rows) * 0.6)):
            time_idx = idx
            break

    candidates = [idx for idx in numeric if idx != time_idx]
    scores = []
    for lng_idx in candidates:
        for lat_idx in candidates:
            if lng_idx == lat_idx:
                continue
            sample = [
                (row[lng_idx], row[lat_idx])
                for row in rows
                if lng_idx < len(row) and lat_idx < len(row)
                and to_float(row[lng_idx]) is not None and to_float(row[lat_idx]) is not None
            ]
            if len(sample) < max(2, int(len(rows) * 0.6)):
                continue
            pairs = [(to_float(a), to_float(b)) for a, b in sample]
            if not all(abs(lat) <= 90.0 and abs(lng) <= 180.0 for lng, lat in pairs):
                continue
            lngs = [abs(lng) for lng, _ in pairs]
            lats = [abs(lat) for _, lat in pairs]
            china_lat = all(15.0 <= lat <= 55.0 for lat in lats)
            score = 0.0
            if all(70.0 <= lng <= 180.0 for lng in lngs):
                score += 3.0
            if china_lat:
                score += 2.0
            score += statistics.median(lngs) - statistics.median(lats)
            scores.append({"score": score, "pair": (lng_idx, lat_idx), "china_lat": china_lat})
    if not scores:
        return None, time_idx
    preferred = [item for item in scores if item["china_lat"]]
    best = max(preferred or scores, key=lambda item: item["score"])
    return best["pair"], time_idx


def _parse_rows(rows, mapping, filename, warnings):
    """按列映射把行转换为轨迹。"""
    name_idx = mapping.get("name")
    groups: dict[str, list[list]] = {}
    order: list[str] = []

    def get(row, field):
        idx = mapping.get(field)
        if idx is None or idx >= len(row):
            return None
        return row[idx]

    for row_number, row in enumerate(rows, start=1):
        if not any(str(cell).strip() for cell in row):
            continue
        lng, lat = to_float(get(row, "lng")), to_float(get(row, "lat"))
        if lng is None or lat is None:
            warnings.append(f"第 {row_number} 行经纬度无效，已跳过")
            continue
        if abs(lng) > 180 or abs(lat) > 90:
            warnings.append(f"第 {row_number} 行经纬度超出范围，已跳过")
            continue
        time_value = parse_time_any(get(row, "time"))
        ele = to_float(get(row, "ele"))
        speed = parse_speed(get(row, "speed"), unit="km/h")
        track_name = str(get(row, "name") or "").strip() if name_idx is not None else ""
        if not track_name:
            track_name = filename.rsplit(".", 1)[0]
        if track_name not in groups:
            groups[track_name] = []
            order.append(track_name)
        groups[track_name].append([lng, lat, ele, speed, time_value])

    tracks = []
    for track_name in order:
        points = groups[track_name]
        if points:
            tracks.append(RawTrack(name=track_name, points=points, segments=[0]))
    return tracks


def parse(data: bytes, filename: str) -> ParserOutput:
    text = decode_text(data)
    if not text.strip():
        raise ParseError("文件为空")
    delimiter = _sniff_delimiter(text)
    reader = csv.reader(io.StringIO(text), delimiter=delimiter)
    rows = [row for row in reader if any(str(cell).strip() for cell in row)]
    if not rows:
        raise ParseError("CSV 文件为空")
    ncols = max(len(row) for row in rows)

    warnings: list[str] = []
    if _is_header(rows[0]):
        header = rows[0]
        mapping = _match_field(header)
        data_rows = rows[1:]
    else:
        data_rows = rows
        pair, time_idx = _guess_columns(data_rows, ncols)
        if pair is None:
            raise ParseError("无法识别 CSV 中的经纬度列，请确认包含 lat/lng 或 纬度/经度 表头")
        mapping = {"lng": pair[0], "lat": pair[1]}
        if time_idx is not None:
            mapping["time"] = time_idx
        warnings.append("CSV 没有表头，已自动猜测列：经度列、纬度列" + ("、时间列" if time_idx is not None else ""))

    for required in ("lng", "lat"):
        if required not in mapping:
            raise ParseError("CSV 缺少经纬度列（支持 lat/lng、纬度/经度 等表头）")

    tracks = _parse_rows(data_rows, mapping, filename, warnings)
    if not tracks:
        raise ParseError("CSV 中没有有效轨迹点")
    return ParserOutput(
        tracks=tracks,
        crs="WGS84",
        format="csv",
        format_label="CSV/TSV",
        warnings=warnings[:50],
    )
