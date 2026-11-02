"""GeoJSON 解析（RFC 7946，默认 WGS-84）。"""

from __future__ import annotations

import json

from ..models import ParserOutput, RawTrack
from .common import ParseError, decode_text, parse_time_any, to_float


def _coord_point(coord, time_value=None) -> list | None:
    if not isinstance(coord, (list, tuple)) or len(coord) < 2:
        return None
    lng, lat = to_float(coord[0]), to_float(coord[1])
    if lng is None or lat is None:
        return None
    ele = to_float(coord[2]) if len(coord) > 2 else None
    return [lng, lat, ele, None, time_value]


def _times_from_props(props, count, prefix):
    for key in ("coordTimes", "times", "timestamps", "coordinateTimes"):
        values = props.get(key) if isinstance(props, dict) else None
        if isinstance(values, list) and len(values) >= count:
            return [parse_time_any(v) for v in values[:count]]
    return [None] * count


def _line_track(coords, name, props) -> RawTrack | None:
    times = _times_from_props(props, len(coords), "line")
    points = []
    for i, coord in enumerate(coords):
        point = _coord_point(coord, times[i] if i < len(times) else None)
        if point:
            points.append(point)
    if not points:
        return None
    return RawTrack(name=name, points=points, segments=[0])


def _collect(node, name_hint, tracks: list[RawTrack], loose_points: list[list], props=None) -> None:
    if not isinstance(node, dict):
        return
    node_type = node.get("type")
    if node_type == "FeatureCollection":
        for feature in node.get("features") or []:
            _collect(feature, name_hint, tracks, loose_points)
        return
    if node_type == "Feature":
        feature_props = node.get("properties") or {}
        name = None
        if isinstance(feature_props, dict):
            name = feature_props.get("name") or feature_props.get("title") or feature_props.get("NAME")
        _collect(node.get("geometry"), name or name_hint, tracks, loose_points, feature_props)
        return
    if node_type == "GeometryCollection":
        segments: list[list] = []
        for geometry in node.get("geometries") or []:
            if not isinstance(geometry, dict):
                continue
            gtype = geometry.get("type")
            if gtype == "LineString":
                track = _line_track(geometry.get("coordinates") or [], name_hint or "轨迹", props or {})
                if track:
                    segments.append(track.points)
            elif gtype == "MultiLineString":
                for line in geometry.get("coordinates") or []:
                    track = _line_track(line, name_hint or "轨迹", {})
                    if track:
                        segments.append(track.points)
            elif gtype == "Point":
                point = _coord_point(geometry.get("coordinates"))
                if point:
                    loose_points.append(point)
        if segments:
            points: list[list] = []
            starts = []
            for seg in segments:
                starts.append(len(points))
                points.extend(seg)
            tracks.append(RawTrack(name=name_hint or "轨迹", points=points, segments=starts))
        return
    if node_type == "LineString":
        track = _line_track(node.get("coordinates") or [], name_hint or "轨迹", props or {})
        if track:
            tracks.append(track)
        return
    if node_type == "MultiLineString":
        lines = node.get("coordinates") or []
        flat_points = 0
        for line in lines:
            flat_points += len(line or [])
        times = _times_from_props(props or {}, flat_points, "multi")
        points: list[list] = []
        starts: list[int] = []
        index = 0
        for line in lines:
            starts.append(len(points))
            for coord in line or []:
                time_value = times[index] if index < len(times) else None
                point = _coord_point(coord, time_value)
                if point:
                    points.append(point)
                index += 1
        if points:
            tracks.append(RawTrack(name=name_hint or "轨迹", points=points, segments=starts))
        return
    if node_type == "Point":
        point = _coord_point(node.get("coordinates"))
        if point:
            loose_points.append(point)
        return
    if node_type == "MultiPoint":
        for coord in node.get("coordinates") or []:
            point = _coord_point(coord)
            if point:
                loose_points.append(point)


def parse(data: bytes, filename: str) -> ParserOutput:
    try:
        obj = json.loads(decode_text(data))
    except json.JSONDecodeError as exc:
        raise ParseError(f"JSON 解析失败：{exc}") from exc

    tracks: list[RawTrack] = []
    loose_points: list[list] = []
    _collect(obj, None, tracks, loose_points)
    if loose_points:
        tracks.append(
            RawTrack(
                name="点位",
                points=loose_points,
                segments=[0],
                warnings=["GeoJSON 中的 Point 已按点位导入"],
            )
        )
    if not tracks:
        raise ParseError("GeoJSON 中没有找到线状轨迹")
    for index, track in enumerate(tracks):
        if not track.name:
            track.name = f"{filename.rsplit('.', 1)[0]}-{index + 1}"
    return ParserOutput(tracks=tracks, crs="WGS84", format="geojson", format_label="GeoJSON")
