"""轨迹导出：GPX / KML / GeoJSON / CSV / JSON。"""

from __future__ import annotations

import csv
import io
import json
import math

from . import geo
from .crs import convert_points_from_wgs84, normalize_crs
from .parsers.common import iso_utc

__all__ = ["EXPORT_FORMATS", "MIME_TYPES", "export_tracks"]

EXPORT_FORMATS = [
    {"id": "gpx", "label": "GPX", "ext": ".gpx", "mime": "application/gpx+xml"},
    {"id": "kml", "label": "KML", "ext": ".kml", "mime": "application/vnd.google-earth.kml+xml"},
    {"id": "geojson", "label": "GeoJSON", "ext": ".geojson", "mime": "application/geo+json"},
    {"id": "csv", "label": "CSV", "ext": ".csv", "mime": "text/csv; charset=utf-8"},
    {"id": "json", "label": "JSON", "ext": ".json", "mime": "application/json; charset=utf-8"},
]

MIME_TYPES = {item["id"]: item["mime"] for item in EXPORT_FORMATS}
_EXTENSIONS = {item["id"]: item["ext"] for item in EXPORT_FORMATS}


def _fmt(value: float, digits: int = 7) -> str:
    if value is None:
        return ""
    text = f"{float(value):.{digits}f}"
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text or "0"


def _escape_xml(value: str) -> str:
    return (
        str(value)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def _segments_of(points: list, segments: list[int]) -> list[list]:
    ranges = geo.segment_ranges(segments or [0], len(points))
    return [points[start:end] for start, end in ranges if end > start]


def _prepare_tracks(tracks: list[dict], crs: str) -> list[dict]:
    prepared = []
    for index, track in enumerate(tracks or []):
        if not isinstance(track, dict):
            continue
        points = track.get("points")
        if not isinstance(points, list) or not points:
            continue
        points = geo.sanitize_points(points)
        if not points:
            continue
        points = convert_points_from_wgs84(points, crs)
        segments = track.get("segments") or [0]
        prepared.append(
            {
                "name": str(track.get("name") or f"轨迹{index + 1}"),
                "points": points,
                "segments": segments,
            }
        )
    if not prepared:
        raise ValueError("没有可导出的轨迹")
    return prepared


def _gpx(tracks: list[dict]) -> bytes:
    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<gpx xmlns="http://www.topografix.com/GPX/1/1" version="1.1" '
        'creator="MapTrackMerger 1.1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" '
        'xsi:schemaLocation="http://www.topografix.com/GPX/1/1 '
        'http://www.topografix.com/GPX/1/1/gpx.xsd">',
        "<metadata>",
        f"  <name>{_escape_xml('地图轨迹合并导出')}</name>",
        "  <time>" + iso_utc(__import__("time").time()) + "</time>",
        "</metadata>",
    ]
    for track in tracks:
        lines.append("<trk>")
        lines.append(f"  <name>{_escape_xml(track['name'])}</name>")
        lines.append("  <type>track</type>")
        for segment in _segments_of(track["points"], track["segments"]):
            lines.append("  <trkseg>")
            for point in segment:
                lng, lat = float(point[0]), float(point[1])
                lines.append(f'    <trkpt lat="{_fmt(lat)}" lon="{_fmt(lng)}">')
                if point[2] is not None:
                    lines.append(f"      <ele>{_fmt(point[2], 2)}</ele>")
                timestamp = iso_utc(point[4])
                if timestamp:
                    lines.append(f"      <time>{timestamp}</time>")
                lines.append("    </trkpt>")
            lines.append("  </trkseg>")
        lines.append("</trk>")
    lines.append("</gpx>")
    return ("\n".join(lines) + "\n").encode("utf-8")


def _kml(tracks: list[dict]) -> bytes:
    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">',
        "<Document>",
        "  <name>地图轨迹合并导出</name>",
        "  <open>1</open>",
    ]

    def geometry_lines(segment) -> list[str]:
        result = []
        with_time = all(point[4] is not None for point in segment)
        if with_time:
            result.append("        <gx:Track>")
            result.append("          <altitudeMode>absolute</altitudeMode>")
            for point in segment:
                result.append(f"          <when>{iso_utc(point[4])}</when>")
            for point in segment:
                alt = point[2] if point[2] is not None else 0
                result.append(
                    f"          <gx:coord>{_fmt(point[0])} {_fmt(point[1])} {_fmt(alt, 1)}</gx:coord>"
                )
            result.append("        </gx:Track>")
        else:
            coordinates = []
            for point in segment:
                if point[2] is not None:
                    coordinates.append(f"{_fmt(point[0])},{_fmt(point[1])},{_fmt(point[2], 1)}")
                else:
                    coordinates.append(f"{_fmt(point[0])},{_fmt(point[1])}")
            result.append("        <LineString>")
            result.append("          <tessellate>1</tessellate>")
            result.append("          <altitudeMode>clampToGround</altitudeMode>")
            result.append("          <coordinates>" + " ".join(coordinates) + "</coordinates>")
            result.append("        </LineString>")
        return result

    for track in tracks:
        segments = _segments_of(track["points"], track["segments"])
        if not segments:
            continue
        stats = geo.compute_stats(track["points"], track["segments"])
        lines.append("  <Placemark>")
        lines.append(f"    <name>{_escape_xml(track['name'])}</name>")
        description = (
            f"点数：{stats['point_count']}；里程：{stats['distance_m'] / 1000:.2f} km；"
            f"时长：{stats['duration_s'] / 60:.1f} 分钟"
        )
        lines.append(f"    <description>{_escape_xml(description)}</description>")
        if len(segments) == 1:
            lines.extend(geometry_lines(segments[0]))
        else:
            lines.append("    <MultiGeometry>")
            for segment in segments:
                lines.extend(geometry_lines(segment))
            lines.append("    </MultiGeometry>")
        lines.append("  </Placemark>")
    lines.append("</Document>")
    lines.append("</kml>")
    return ("\n".join(lines) + "\n").encode("utf-8")


def _geojson(tracks: list[dict], crs: str) -> bytes:
    features = []
    for track_index, track in enumerate(tracks):
        segments = _segments_of(track["points"], track["segments"])
        if not segments:
            continue
        has_ele = any(point[2] is not None for segment in segments for point in segment)
        line_coordinates = []
        all_times = []
        for segment in segments:
            coordinates = []
            for point in segment:
                if has_ele:
                    coordinates.append(
                        [round(float(point[0]), 7), round(float(point[1]), 7), round(float(point[2] or 0), 2)]
                    )
                else:
                    coordinates.append([round(float(point[0]), 7), round(float(point[1]), 7)])
                all_times.append(point[4])
            line_coordinates.append(coordinates)
        stats = geo.compute_stats(track["points"], track["segments"])
        properties = {
            "name": track["name"],
            "track_index": track_index,
            "point_count": stats["point_count"],
            "distance_m": stats["distance_m"],
            "duration_s": stats["duration_s"],
            "time_start": stats["time_start"],
            "time_end": stats["time_end"],
        }
        if any(t is not None for t in all_times):
            properties["times"] = all_times
        if len(line_coordinates) == 1:
            geometry = {"type": "LineString", "coordinates": line_coordinates[0]}
        else:
            geometry = {"type": "MultiLineString", "coordinates": line_coordinates}
        features.append(
            {
                "type": "Feature",
                "properties": properties,
                "geometry": geometry,
            }
        )
    payload = {
        "type": "FeatureCollection",
        "name": "MapTrackMerger",
        "crs_note": crs,
        "features": features,
    }
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def _csv(tracks: list[dict]) -> bytes:
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\r\n")
    writer.writerow(["track", "segment", "time", "time_iso", "lng", "lat", "ele", "speed_kmh"])
    for track in tracks:
        segments = _segments_of(track["points"], track["segments"])
        for seg_index, segment in enumerate(segments):
            for point in segment:
                speed = point[3]
                writer.writerow(
                    [
                        track["name"],
                        seg_index + 1,
                        _fmt(point[4], 3),
                        iso_utc(point[4]) or "",
                        _fmt(point[0]),
                        _fmt(point[1]),
                        _fmt(point[2], 2),
                        _fmt(speed * 3.6, 2) if speed is not None else "",
                    ]
                )
    return ("\ufeff" + buffer.getvalue()).encode("utf-8")


def _json_export(tracks: list[dict], crs: str) -> bytes:
    payload = {
        "crs": crs,
        "generator": "MapTrackMerger 1.1",
        "tracks": [
            {
                "name": track["name"],
                "points": [
                    [
                        round(float(point[0]), 7),
                        round(float(point[1]), 7),
                        round(float(point[2]), 2) if point[2] is not None else None,
                        round(float(point[3]), 3) if point[3] is not None else None,
                        round(float(point[4]), 3) if point[4] is not None else None,
                    ]
                    for point in track["points"]
                ],
                "segments": [int(s) for s in track["segments"]],
            }
            for track in tracks
        ],
    }
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def export_tracks(fmt: str, crs: str, tracks: list[dict], base_name: str = "轨迹合并") -> tuple[bytes, str, str]:
    """返回 (文件字节, MIME, 建议文件名)。"""
    fmt = str(fmt or "gpx").strip().lower()
    if fmt not in MIME_TYPES:
        raise ValueError(f"不支持的导出格式：{fmt}")
    crs = normalize_crs(crs, default="WGS84")
    prepared = _prepare_tracks(tracks, crs)

    if fmt == "gpx":
        data = _gpx(prepared)
    elif fmt == "kml":
        data = _kml(prepared)
    elif fmt == "geojson":
        data = _geojson(prepared, crs)
    elif fmt == "csv":
        data = _csv(prepared)
    else:
        data = _json_export(prepared, crs)

    safe_base = _safe_filename(base_name or "轨迹合并")
    filename = f"{safe_base}{_EXTENSIONS[fmt]}"
    return data, MIME_TYPES[fmt], filename


def _safe_filename(value: str) -> str:
    text = str(value or "").strip()
    for char in '<>:"/\\|?*\r\n\t':
        text = text.replace(char, "_")
    text = text.strip(" ._")
    if not text:
        text = "轨迹合并"
    return text[:100]
