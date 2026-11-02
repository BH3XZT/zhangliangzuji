"""GPX 1.0 / 1.1 解析（WGS-84）。"""

from __future__ import annotations

from ..models import ParserOutput, RawTrack
from .common import ParseError, child_text, localname, parse_speed, parse_time_any, to_float, xml_root


def _point_from_trkpt(element) -> list | None:
    lat = to_float(element.get("lat"))
    lng = to_float(element.get("lon"))
    if lng is None or lat is None:
        return None
    ele = to_float(child_text(element, "ele"))
    time = parse_time_any(child_text(element, "time"))
    speed = None
    for child in element.iter():
        name = localname(child.tag)
        if name == "speed":
            speed = parse_speed(child.text, unit="m/s")
            break
        if name == "hr":
            continue
    return [lng, lat, ele, speed, time]


def _tracks_from_container(root, filename: str) -> list[RawTrack]:
    tracks: list[RawTrack] = []
    for trk in root.iter():
        if localname(trk.tag) != "trk":
            continue
        name = child_text(trk, "name") or child_text(trk, "desc")
        points: list[list] = []
        segments: list[int] = []
        for seg in trk:
            if localname(seg.tag) != "trkseg":
                continue
            seg_points = []
            for trkpt in seg:
                if localname(trkpt.tag) != "trkpt":
                    continue
                point = _point_from_trkpt(trkpt)
                if point:
                    seg_points.append(point)
            if seg_points:
                segments.append(len(points))
                points.extend(seg_points)
        if points:
            tracks.append(
                RawTrack(
                    name=name or filename.rsplit(".", 1)[0],
                    points=points,
                    segments=segments or [0],
                )
            )

    # 路线（rte）兜底
    for rte in root.iter():
        if localname(rte.tag) != "rte":
            continue
        points = []
        for rtept in rte:
            if localname(rtept.tag) != "rtept":
                continue
            point = _point_from_trkpt(rtept)
            if point:
                points.append(point)
        if points:
            name = child_text(rte, "name") or filename.rsplit(".", 1)[0]
            tracks.append(RawTrack(name=name, points=points, segments=[0]))

    # 只有航点时也尽量呈现
    if not tracks:
        points = []
        for wpt in root.iter():
            if localname(wpt.tag) != "wpt":
                continue
            point = _point_from_trkpt(wpt)
            if point:
                points.append(point)
        if points:
            tracks.append(
                RawTrack(
                    name=filename.rsplit(".", 1)[0],
                    points=points,
                    segments=[0],
                    warnings=["文件只包含航点（wpt），已按点位显示"],
                )
            )
    return tracks


def parse(data: bytes, filename: str) -> ParserOutput:
    root = xml_root(data)
    if localname(root.tag).lower() != "gpx":
        raise ParseError("不是有效的 GPX 文件")
    tracks = _tracks_from_container(root, filename)
    if not tracks:
        raise ParseError("GPX 文件中没有找到轨迹点")
    return ParserOutput(tracks=tracks, crs="WGS84", format="gpx", format_label="GPX")
