"""GeoJSON 读取 / 包围盒 / 要素过滤等通用工具。"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any


# ---------------------------------------------------------------------------
# 读取与基础几何
# ---------------------------------------------------------------------------

def load_feature_collection(path: str | Path) -> list[dict]:
    """读取 GeoJSON FeatureCollection，返回 features 列表；文件不存在返回空列表。"""
    file_path = Path(path)
    if not file_path.is_file():
        return []
    try:
        data = json.loads(file_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    if isinstance(data, dict) and data.get("type") == "FeatureCollection":
        features = data.get("features")
        return features if isinstance(features, list) else []
    return []


def iter_positions(geometry: Any):
    """递归遍历任意 GeoJSON geometry 中的 [lon, lat] 坐标。"""
    if not isinstance(geometry, dict):
        return
    gtype = geometry.get("type")
    coordinates = geometry.get("coordinates")
    if gtype == "GeometryCollection":
        for child in geometry.get("geometries") or []:
            yield from iter_positions(child)
        return
    if gtype == "Point":
        if isinstance(coordinates, (list, tuple)) and len(coordinates) >= 2:
            yield float(coordinates[0]), float(coordinates[1])
        return
    if gtype in ("LineString", "MultiPoint"):
        for item in coordinates or []:
            if isinstance(item, (list, tuple)) and len(item) >= 2:
                yield float(item[0]), float(item[1])
        return
    if gtype in ("Polygon", "MultiLineString"):
        for ring in coordinates or []:
            for item in ring or []:
                if isinstance(item, (list, tuple)) and len(item) >= 2:
                    yield float(item[0]), float(item[1])
        return
    if gtype == "MultiPolygon":
        for polygon in coordinates or []:
            for ring in polygon or []:
                for item in ring or []:
                    if isinstance(item, (list, tuple)) and len(item) >= 2:
                        yield float(item[0]), float(item[1])


def geometry_bbox(geometry: Any) -> list[float] | None:
    """返回 [min_lon, min_lat, max_lon, max_lat]。"""
    xs: list[float] = []
    ys: list[float] = []
    for lon, lat in iter_positions(geometry):
        if not (math.isfinite(lon) and math.isfinite(lat)):
            continue
        if not (-180 <= lon <= 180 and -90 <= lat <= 90):
            continue
        xs.append(lon)
        ys.append(lat)
    if not xs:
        return None
    return [min(xs), min(ys), max(xs), max(ys)]


def bbox_intersects(a: list[float] | None, b: list[float] | None) -> bool:
    if not a or not b:
        return False
    return not (a[2] < b[0] or a[0] > b[2] or a[3] < b[1] or a[1] > b[3])


def bbox_union(boxes: list[list[float]]) -> list[float] | None:
    boxes = [box for box in boxes if box]
    if not boxes:
        return None
    return [
        min(box[0] for box in boxes),
        min(box[1] for box in boxes),
        max(box[2] for box in boxes),
        max(box[3] for box in boxes),
    ]


def point_in_bbox(lon: float, lat: float, bbox: list[float]) -> bool:
    return bbox[0] <= lon <= bbox[2] and bbox[1] <= lat <= bbox[3]


# ---------------------------------------------------------------------------
# 业务过滤
# ---------------------------------------------------------------------------

def filter_water_features(features: list[dict], bbox: list[float], limit: int = 8000) -> list[dict]:
    """保留与等时圈包围盒相交的河流/运河线，附带轻量属性。"""
    result: list[dict] = []
    for feature in features:
        if not isinstance(feature, dict):
            continue
        geometry = feature.get("geometry") or {}
        if geometry.get("type") not in ("LineString", "MultiLineString"):
            continue
        feature_box = geometry_bbox(geometry)
        if not bbox_intersects(feature_box, bbox):
            continue
        props = feature.get("properties") or {}
        name = props.get("name_zh") or props.get("name") or props.get("name:en") or ""
        result.append(
            {
                "type": "Feature",
                "properties": {
                    "layer": "water",
                    "name": str(name)[:80],
                    "waterway": str(props.get("waterway") or "river")[:20],
                },
                "geometry": geometry,
            }
        )
        if len(result) >= limit:
            break
    return result


def filter_city_features(features: list[dict], bbox: list[float], limit: int = 300) -> list[dict]:
    """保留在等时圈范围内的城市点，返回 name/place 等轻量属性。"""
    result: list[dict] = []
    for feature in features:
        if not isinstance(feature, dict):
            continue
        geometry = feature.get("geometry") or {}
        if geometry.get("type") != "Point":
            continue
        coords = geometry.get("coordinates") or []
        if len(coords) < 2:
            continue
        try:
            lon, lat = float(coords[0]), float(coords[1])
        except (TypeError, ValueError):
            continue
        if not point_in_bbox(lon, lat, bbox):
            continue
        props = feature.get("properties") or {}
        name = props.get("name_zh") or props.get("name") or ""
        if not name:
            continue
        result.append(
            {
                "type": "Feature",
                "properties": {
                    "layer": "city",
                    "name": str(name)[:60],
                    "place": str(props.get("place") or "")[:20],
                    "population": str(props.get("population") or "")[:20],
                },
                "geometry": geometry,
            }
        )
        if len(result) >= limit:
            break
    return result
