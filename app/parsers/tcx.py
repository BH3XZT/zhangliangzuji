"""TCX（Garmin Training Center XML）解析（WGS-84）。"""

from __future__ import annotations

from ..models import ParserOutput, RawTrack
from .common import ParseError, localname, parse_speed, parse_time_any, to_float, xml_root


def _trackpoint_points(track_element) -> list[list]:
    points = []
    for tp in track_element.iter():
        if localname(tp.tag) != "Trackpoint":
            continue
        lat = lng = None
        ele = None
        time = None
        speed = None
        for child in tp.iter():
            name = localname(child.tag)
            if name in ("LatDeg", "LatitudeDegrees"):
                lat = to_float(child.text)
            elif name in ("LngDeg", "LongitudeDegrees"):
                lng = to_float(child.text)
            elif name == "AltitudeMeters":
                ele = to_float(child.text)
            elif name == "Time":
                time = parse_time_any(child.text)
            elif name == "Speed":
                speed = parse_speed(child.text, unit="m/s")
        if lng is None or lat is None:
            continue
        points.append([lng, lat, ele, speed, time])
    return points


def parse(data: bytes, filename: str) -> ParserOutput:
    root = xml_root(data)
    if localname(root.tag).lower() != "trainingcenterdatabase":
        raise ParseError("不是有效的 TCX 文件")

    tracks: list[RawTrack] = []
    for activity in root.iter():
        if localname(activity.tag) != "Activity":
            continue
        name = None
        for child in activity:
            if localname(child.tag) in ("Id", "Name"):
                name = (child.text or "").strip() or name
        points: list[list] = []
        starts: list[int] = []
        for element in activity.iter():
            if localname(element.tag) != "Track":
                continue
            seg = _trackpoint_points(element)
            if seg:
                starts.append(len(points))
                points.extend(seg)
        if points:
            tracks.append(
                RawTrack(
                    name=name or filename.rsplit(".", 1)[0],
                    points=points,
                    segments=starts or [0],
                )
            )
    if not tracks:
        raise ParseError("TCX 文件中没有找到轨迹点")
    return ParserOutput(tracks=tracks, crs="WGS84", format="tcx", format_label="TCX")
