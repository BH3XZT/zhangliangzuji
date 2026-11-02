"""轨迹文件格式识别与统一解析入口。

对外只暴露 `detect_format` / `parse_file` / `FORMAT_LIST`。
解析结果中的坐标统一转换为 WGS-84。
"""

from __future__ import annotations

import json
import os
import re
import xml.etree.ElementTree as ET

from .. import crs as crs_mod
from .. import geo
from ..models import ParsedFile
from . import csv_parser, fit, geojson_parser, gpx, json_track, kml, nmea, tcx
from .common import ParseError

__all__ = ["FORMAT_LIST", "detect_format", "parse_file", "ParseError"]

FORMAT_LIST = [
    {"id": "gpx", "label": "GPX", "ext": [".gpx"], "crs": "WGS84"},
    {"id": "kml", "label": "KML / KMZ", "ext": [".kml", ".kmz"], "crs": "WGS84"},
    {"id": "tcx", "label": "TCX", "ext": [".tcx"], "crs": "WGS84"},
    {"id": "geojson", "label": "GeoJSON", "ext": [".geojson"], "crs": "WGS84"},
    {"id": "json", "label": "通用 JSON", "ext": [".json"], "crs": "WGS84"},
    {"id": "baidu", "label": "百度地图 JSON", "ext": [".json"], "crs": "BD09"},
    {"id": "amap", "label": "高德地图 JSON", "ext": [".json"], "crs": "GCJ02"},
    {"id": "google", "label": "Google 时间线", "ext": [".json"], "crs": "WGS84"},
    {"id": "csv", "label": "CSV / TSV", "ext": [".csv", ".tsv", ".txt"], "crs": "WGS84"},
    {"id": "nmea", "label": "NMEA 日志", "ext": [".nmea", ".log", ".txt"], "crs": "WGS84"},
    {"id": "fit", "label": "FIT", "ext": [".fit"], "crs": "WGS84"},
]

_PARSERS = {
    "gpx": gpx.parse,
    "kml": kml.parse,
    "tcx": tcx.parse,
    "geojson": geojson_parser.parse,
    "csv": csv_parser.parse,
    "nmea": nmea.parse,
    "fit": fit.parse,
    "baidu": json_track.parse_baidu,
    "amap": json_track.parse_amap,
    "google": json_track.parse_google,
    "json": json_track.parse_generic,
}

_EXT_MAP = {
    ".gpx": "gpx",
    ".kml": "kml",
    ".kmz": "kml",
    ".tcx": "tcx",
    ".geojson": "geojson",
    ".json": "json",
    ".csv": "csv",
    ".tsv": "csv",
    ".nmea": "nmea",
    ".log": "nmea",
    ".fit": "fit",
}

MAX_POINTS = 1_000_000


def _xml_tag(data: bytes) -> str | None:
    match = re.search(rb"<\s*([A-Za-z_][\w:.\-]*)", data[:8192])
    if not match:
        return None
    tag = match.group(1).decode("ascii", errors="ignore")
    if ":" in tag:
        tag = tag.split(":", 1)[1]
    return tag.lower()


def _json_kind(data: bytes, filename: str) -> str:
    try:
        obj = json.loads(data.decode("utf-8-sig", errors="replace"))
    except json.JSONDecodeError:
        try:
            obj = json.loads(data.decode("gb18030", errors="replace"))
        except json.JSONDecodeError as exc:
            raise ParseError(f"JSON 格式错误：{exc}") from exc
    if isinstance(obj, dict) and obj.get("type") in (
        "FeatureCollection", "Feature", "GeometryCollection", "LineString",
        "MultiLineString", "Point", "MultiPoint",
    ):
        return "geojson"
    kind = json_track.detect_json_kind(obj, filename)
    return "json" if kind == "generic" else kind


def _sniff_text(data: bytes) -> str:
    sample = data[:65536]
    text = sample.decode("utf-8", errors="ignore")
    if not text.strip():
        text = sample.decode("gb18030", errors="ignore")
    stripped = text.lstrip("\ufeff \t\r\n")
    if not stripped:
        raise ParseError("文件内容为空或编码无法识别")
    if stripped.startswith("<?xml") or stripped.startswith("<"):
        tag = _xml_tag(data)
        if tag == "gpx":
            return "gpx"
        if tag == "kml":
            return "kml"
        if tag == "trainingcenterdatabase":
            return "tcx"
        raise ParseError(f"不支持的 XML 轨迹格式：<{tag}>")
    if stripped.startswith("{") or stripped.startswith("["):
        return None  # 交给 JSON 探测
    if re.search(r"^\s*\$G[PNLA]", text[:4096], re.MULTILINE):
        return "nmea"
    first_line = stripped.splitlines()[0] if stripped.splitlines() else ""
    for delimiter in (",", ";", "\t", "|"):
        if first_line.count(delimiter) >= 2:
            return "csv"
    raise ParseError("无法识别的文件格式")


def detect_format(data: bytes, filename: str) -> str:
    """根据扩展名 + 文件头侦测格式。"""
    if not data:
        raise ParseError("文件为空")
    ext = os.path.splitext((filename or "").lower())[1]
    if data[:2] == b"PK":
        return "kml"  # KMZ
    if len(data) >= 12 and data[8:12] == b".FIT":
        return "fit"
    if ext == ".fit":
        return "fit"
    if ext in (".gpx", ".kml", ".kmz", ".tcx", ".geojson", ".csv", ".tsv", ".nmea", ".log"):
        return _EXT_MAP[ext]
    if ext == ".json":
        return _json_kind(data, filename)
    sniffed = _sniff_text(data)
    if sniffed:
        return sniffed
    return _json_kind(data, filename)


def _unique_name(name: str, used: set[str], index: int, fallback: str) -> str:
    base = (name or fallback or f"轨迹{index + 1}").strip()
    if base not in used:
        used.add(base)
        return base
    counter = 2
    while f"{base} ({counter})" in used:
        counter += 1
    final = f"{base} ({counter})"
    used.add(final)
    return final


def parse_file(data: bytes, filename: str, crs_override: str = "auto") -> ParsedFile:
    """解析单个文件，返回坐标已转为 WGS-84 的轨迹列表。"""
    if not data:
        raise ParseError("文件为空")
    fmt = detect_format(data, filename)
    parser = _PARSERS.get(fmt)
    if parser is None:
        raise ParseError(f"暂不支持该格式：{fmt}")
    try:
        output = parser(data, filename)
    except ParseError:
        raise
    except (ValueError, KeyError, TypeError, IndexError, AttributeError) as exc:
        raise ParseError(f"解析失败：{exc}") from exc

    override = (crs_override or "auto").strip()
    if override.lower() in ("", "auto"):
        source_crs = output.crs
        crs_auto = True
    else:
        source_crs = crs_mod.normalize_crs(override, default=output.crs)
        crs_auto = False

    stem = os.path.splitext(os.path.basename(filename))[0] or "轨迹"
    tracks: list[dict] = []
    used_names: set[str] = set()
    total_points = 0
    warnings = list(output.warnings)

    for index, raw in enumerate(output.tracks):
        points: list[list] = []
        segments: list[int] = []
        ranges = geo.segment_ranges(raw.segments or [0], len(raw.points))
        for start, end in ranges:
            seg = geo.sanitize_points(raw.points[start:end])
            if not seg:
                continue
            segments.append(len(points))
            points.extend(seg)
        if not points:
            continue
        points = crs_mod.convert_points_to_wgs84(points, source_crs)
        total_points += len(points)
        if total_points > MAX_POINTS:
            raise ParseError(f"轨迹点过多（超过 {MAX_POINTS} 个），请先抽稀或拆分文件")
        name = _unique_name(raw.name, used_names, index, stem)
        track_warnings = list(raw.warnings)
        tracks.append(
            {
                "name": name,
                "points": points,
                "segments": segments or [0],
                "warnings": track_warnings,
            }
        )

    if not tracks:
        raise ParseError("文件中没有有效的轨迹点")

    return ParsedFile(
        tracks=tracks,
        source_crs=source_crs,
        crs_detected=output.crs,
        format=output.format,
        format_label=output.format_label,
        warnings=warnings,
        crs_auto=crs_auto,
    )
