"""KML / KMZ 解析（默认 WGS-84，可覆盖为 GCJ-02 / BD-09）。"""

from __future__ import annotations

import io
import zipfile

from ..models import ParserOutput, RawTrack
from .common import ParseError, child_text, localname, parse_time_any, to_float, xml_root


def _extract_kml(data: bytes) -> bytes:
    if data[:2] == b"PK":
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as zf:
                names = [n for n in zf.namelist() if n.lower().endswith(".kml")]
                if not names:
                    raise ParseError("KMZ 压缩包中没有 .kml 文件")
                names.sort(key=lambda n: (not n.lower().endswith("doc.kml"), len(n)))
                return zf.read(names[0])
        except zipfile.BadZipFile as exc:
            raise ParseError(f"KMZ 压缩包损坏：{exc}") from exc
    return data


def _parse_coordinates(text: str) -> list[list]:
    points = []
    for token in (text or "").replace("\n", " ").replace("\t", " ").split():
        parts = token.split(",")
        if len(parts) < 2:
            continue
        lng, lat = to_float(parts[0]), to_float(parts[1])
        if lng is None or lat is None:
            continue
        ele = to_float(parts[2]) if len(parts) > 2 else None
        points.append([lng, lat, ele, None, None])
    return points


def _parse_gx_track(track_element) -> list[list]:
    whens = []
    coords = []
    for child in track_element:
        name = localname(child.tag)
        if name == "when":
            whens.append(parse_time_any(child.text))
        elif name == "coord":
            parts = (child.text or "").split()
            if len(parts) >= 2:
                lng, lat = to_float(parts[0]), to_float(parts[1])
                if lng is not None and lat is not None:
                    ele = to_float(parts[2]) if len(parts) > 2 else None
                    coords.append([lng, lat, ele, None, None])
            else:
                coords.append(None)
    points = []
    for i, coord in enumerate(coords):
        if coord is None:
            continue
        if i < len(whens):
            coord[4] = whens[i]
        points.append(coord)
    return points


def _segments_from_placemark(placemark) -> list[list]:
    """一个 Placemark 里可能有多个几何，按出现顺序收集成多个段。"""
    segments: list[list] = []
    for element in placemark.iter():
        name = localname(element.tag)
        if name == "LineString":
            coords_text = None
            for child in element.iter():
                if localname(child.tag) == "coordinates":
                    coords_text = child.text
                    break
            points = _parse_coordinates(coords_text or "")
            if len(points) >= 1:
                segments.append(points)
        elif name == "Track":  # gx:Track
            points = _parse_gx_track(element)
            if len(points) >= 2:
                segments.append(points)
    return segments


def parse(data: bytes, filename: str) -> ParserOutput:
    kml_data = _extract_kml(data)
    root = xml_root(kml_data)
    if localname(root.tag).lower() not in ("kml", "document", "folder", "placemark"):
        raise ParseError("不是有效的 KML 文件")

    placemarks = [el for el in root.iter() if localname(el.tag) == "Placemark"]
    tracks: list[RawTrack] = []
    warnings: list[str] = []

    if placemarks:
        for placemark in placemarks:
            name = child_text(placemark, "name") or filename.rsplit(".", 1)[0]
            segments = _segments_from_placemark(placemark)
            if not segments:
                continue
            points: list[list] = []
            starts: list[int] = []
            for seg in segments:
                starts.append(len(points))
                points.extend(seg)
            tracks.append(RawTrack(name=name, points=points, segments=starts or [0]))
    else:
        # 没有 Placemark 时，收集全部 LineString
        points: list[list] = []
        starts = []
        for element in root.iter():
            if localname(element.tag) != "LineString":
                continue
            coords_text = None
            for child in element.iter():
                if localname(child.tag) == "coordinates":
                    coords_text = child.text
                    break
            seg = _parse_coordinates(coords_text or "")
            if seg:
                starts.append(len(points))
                points.extend(seg)
        if points:
            tracks.append(
                RawTrack(
                    name=filename.rsplit(".", 1)[0],
                    points=points,
                    segments=starts,
                    warnings=["KML 未包含 Placemark 名称，已按坐标序列导入"],
                )
            )
        else:
            raise ParseError("KML 文件中没有找到轨迹（LineString / gx:Track）")

    if not tracks:
        raise ParseError("KML 文件中没有找到轨迹点")
    return ParserOutput(
        tracks=tracks,
        crs="WGS84",
        format="kml",
        format_label="KML/KMZ",
        warnings=warnings,
    )
