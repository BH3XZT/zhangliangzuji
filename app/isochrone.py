"""城市自驾等时圈：Valhalla 代理 + OSM 水系/城市点合并。

本模块使用 Python 标准库实现，直接挂在现有 maptrack-merger HTTP 服务上，
不引入 FastAPI/MapLibre 等额外运行时依赖。
"""

from __future__ import annotations

import json
import math
import os
import threading
import time
import urllib.error
import urllib.request
from collections import OrderedDict
from pathlib import Path
from typing import Any

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("ISOCHRONE_DATA_DIR", str(BASE_DIR / "data" / "isochrone")))
WATER_FILE = DATA_DIR / "water.geojson"
PLACES_FILE = DATA_DIR / "places.geojson"
VALHALLA_URL = os.environ.get("VALHALLA_URL", "http://valhalla:8002").rstrip("/")

DEFAULT_CENTER = {"lat": 37.8706, "lon": 112.5489, "name": "太原市"}
DEFAULT_MINUTES = [60, 120, 180, 240]
CONTOUR_HEX = {
    60: "#0b3d91",
    120: "#1d4ed8",
    180: "#3b82f6",
    240: "#7dd3fc",
}
VALHALLA_COLORS = {minute: color.lstrip("#") for minute, color in CONTOUR_HEX.items()}
CACHE_MAX = 32

# 交通方式与 Valhalla costing 的映射
MODE_LABELS = {
    "walk": "步行",
    "bike": "自行车",
    "motorcycle": "摩托车",
    "car": "汽车",
}
MODE_COSTING = {
    "walk": "pedestrian",
    "bike": "bicycle",
    "motorcycle": "motorcycle",
    "car": "auto",
}

# 道路偏好：Valhalla 没有“国道/省道”独立分类，这里用高速/收费道路权重近似表达
ROAD_PREF_LABELS = {
    "highway": "高速优先",
    "national": "国道/主干优先",
    "balanced": "均衡",
    "avoid_highway": "避开高速",
}
ROAD_PREF_OPTIONS = {
    "highway": {"use_highways": 1.0, "use_tolls": 1.0},
    "national": {"use_highways": 0.7, "use_tolls": 0.8},
    "balanced": {"use_highways": 0.5, "use_tolls": 0.5},
    "avoid_highway": {"use_highways": 0.0, "use_tolls": 0.0},
}


class IsochroneError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.message = message
        self.status = status


# ---------------------------------------------------------------------------
# GeoJSON 工具
# ---------------------------------------------------------------------------

def _iter_positions(geometry: Any):
    if not isinstance(geometry, dict):
        return
    gtype = geometry.get("type")
    coords = geometry.get("coordinates")
    if gtype == "GeometryCollection":
        for child in geometry.get("geometries") or []:
            yield from _iter_positions(child)
        return
    if gtype == "Point":
        if isinstance(coords, (list, tuple)) and len(coords) >= 2:
            yield float(coords[0]), float(coords[1])
        return
    if gtype in ("LineString", "MultiPoint"):
        for item in coords or []:
            if isinstance(item, (list, tuple)) and len(item) >= 2:
                yield float(item[0]), float(item[1])
        return
    if gtype in ("Polygon", "MultiLineString"):
        for ring in coords or []:
            for item in ring or []:
                if isinstance(item, (list, tuple)) and len(item) >= 2:
                    yield float(item[0]), float(item[1])
        return
    if gtype == "MultiPolygon":
        for polygon in coords or []:
            for ring in polygon or []:
                for item in ring or []:
                    if isinstance(item, (list, tuple)) and len(item) >= 2:
                        yield float(item[0]), float(item[1])


def _geometry_bbox(geometry: Any) -> list[float] | None:
    xs: list[float] = []
    ys: list[float] = []
    for lon, lat in _iter_positions(geometry):
        if not (math.isfinite(lon) and math.isfinite(lat)):
            continue
        if not (-180 <= lon <= 180 and -90 <= lat <= 90):
            continue
        xs.append(lon)
        ys.append(lat)
    if not xs:
        return None
    return [min(xs), min(ys), max(xs), max(ys)]


def _bbox_intersects(a: list[float] | None, b: list[float] | None) -> bool:
    if not a or not b:
        return False
    return not (a[2] < b[0] or a[0] > b[2] or a[3] < b[1] or a[1] > b[3])


def _bbox_union(boxes: list[list[float]]) -> list[float] | None:
    boxes = [box for box in boxes if box]
    if not boxes:
        return None
    return [
        min(box[0] for box in boxes),
        min(box[1] for box in boxes),
        max(box[2] for box in boxes),
        max(box[3] for box in boxes),
    ]


def _point_in_bbox(lon: float, lat: float, bbox: list[float]) -> bool:
    return bbox[0] <= lon <= bbox[2] and bbox[1] <= lat <= bbox[3]


def _load_features(path: Path) -> list[dict]:
    if not path.is_file():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    if isinstance(data, dict) and data.get("type") == "FeatureCollection":
        return data.get("features") if isinstance(data.get("features"), list) else []
    return []


# 缓存水系/城市点，按 mtime 自动失效，无需重启即可重新提取
_layer_lock = threading.Lock()
_layer_cache: dict[str, tuple[float, list[dict]]] = {}


def _get_layer(path: Path) -> list[dict]:
    try:
        mtime = path.stat().st_mtime
    except OSError:
        return []
    with _layer_lock:
        cached = _layer_cache.get(str(path))
        if cached and cached[0] == mtime:
            return cached[1]
    features = _load_features(path)
    with _layer_lock:
        _layer_cache[str(path)] = (mtime, features)
    return features


def _filter_water(features: list[dict], bbox: list[float]) -> list[dict]:
    result: list[dict] = []
    for feature in features:
        geometry = feature.get("geometry") or {}
        if geometry.get("type") not in ("LineString", "MultiLineString"):
            continue
        if not _bbox_intersects(_geometry_bbox(geometry), bbox):
            continue
        props = feature.get("properties") or {}
        name = props.get("name_zh") or props.get("name") or ""
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
        if len(result) >= 8000:
            break
    return result


def _filter_cities(features: list[dict], bbox: list[float]) -> list[dict]:
    result: list[dict] = []
    for feature in features:
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
        if not _point_in_bbox(lon, lat, bbox):
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
        if len(result) >= 300:
            break
    return result


# ---------------------------------------------------------------------------
# Valhalla 请求 + 内存 LRU
# ---------------------------------------------------------------------------

_cache_lock = threading.Lock()
_cache: OrderedDict[tuple, dict] = OrderedDict()


def _cache_get(key: tuple) -> dict | None:
    with _cache_lock:
        if key not in _cache:
            return None
        value = _cache.pop(key)
        _cache[key] = value
        return value


def _cache_put(key: tuple, value: dict) -> None:
    with _cache_lock:
        _cache[key] = value
        _cache.move_to_end(key)
        while len(_cache) > CACHE_MAX:
            _cache.popitem(last=False)


def _as_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in ("1", "true", "yes", "on")
    if value is None:
        return default
    return bool(value)


def _costing_options(
    mode: str,
    road_pref: str,
    avoid_tolls: bool,
    avoid_ferries: bool,
    avoid_unpaved: bool,
) -> dict:
    """把 UI 的道路偏好/避让选项翻译成 Valhalla costing_options。"""
    options: dict = {}
    if mode in ("car", "motorcycle"):
        options.update(ROAD_PREF_OPTIONS[road_pref])
        if avoid_tolls:
            options["use_tolls"] = 0.0
        options["use_ferry"] = 0.0 if avoid_ferries else 0.5
        if avoid_unpaved:
            options["exclude_unpaved"] = True
    elif mode == "bike":
        # 自行车不使用高速权重，改为道路/坡度偏好；收费/轮渡仍可控制
        options["use_roads"] = 0.7
        options["use_hills"] = 0.4
        options["use_ferry"] = 0.0 if avoid_ferries else 0.5
    else:  # walk
        if avoid_ferries:
            options["use_ferry"] = 0.0
    return options


def _valhalla_request(
    lat: float,
    lon: float,
    minutes: list[int],
    mode: str,
    road_pref: str,
    avoid_tolls: bool,
    avoid_ferries: bool,
    avoid_unpaved: bool,
) -> dict:
    costing = MODE_COSTING[mode]
    options = _costing_options(mode, road_pref, avoid_tolls, avoid_ferries, avoid_unpaved)
    payload = {
        "locations": [{"lat": lat, "lon": lon}],
        "costing": costing,
        "contours": [
            {"time": float(minute), "color": VALHALLA_COLORS.get(minute, "0ea5e9")}
            for minute in minutes
        ],
        "polygons": True,
        "denoise": 1,
        "generalize": 80,
        "show_locations": False,
    }
    if options:
        payload["costing_options"] = {costing: options}
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        f"{VALHALLA_URL}/isochrone",
        data=body,
        headers={"Content-Type": "application/json", "User-Agent": "MapTrackMerger/1.4"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            raw = response.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:500].replace("\n", " ")
        raise IsochroneError(f"Valhalla 返回 {exc.code}：{detail}", 502) from exc
    except urllib.error.URLError as exc:
        raise IsochroneError(
            "等时圈路由服务未启动。请先在 NAS 上执行：sudo docker compose --profile isochrone up -d",
            503,
        ) from exc
    except TimeoutError as exc:
        raise IsochroneError("Valhalla 等时圈计算超时，请稍后重试", 504) from exc

    try:
        data = json.loads(raw.decode("utf-8"))
    except ValueError as exc:
        raise IsochroneError("Valhalla 返回的不是合法 JSON", 502) from exc
    if not isinstance(data, dict) or data.get("type") != "FeatureCollection":
        raise IsochroneError("Valhalla 返回结果缺少 FeatureCollection", 502)
    if not data.get("features"):
        raise IsochroneError("Valhalla 没有返回等时圈要素，起点可能不在路网附近", 502)
    return data


def _extract_minutes(feature: dict, index: int, requested: list[int]) -> int | None:
    props = feature.get("properties") or {}
    for key in ("contour", "time", "minutes"):
        if key in props:
            try:
                return int(round(float(props[key])))
            except (TypeError, ValueError):
                pass
    return requested[index] if index < len(requested) else None


def _assemble(
    lat: float,
    lon: float,
    minutes: list[int],
    isochrone_data: dict,
    mode: str,
    road_pref: str,
    avoid_tolls: bool,
    avoid_ferries: bool,
    avoid_unpaved: bool,
    include_water: bool = False,
) -> dict:
    requested = sorted(minutes)
    iso_features: list[dict] = []
    boxes: list[list[float]] = []
    for index, feature in enumerate(isochrone_data.get("features") or []):
        geometry = feature.get("geometry") or {}
        if geometry.get("type") not in ("Polygon", "MultiPolygon"):
            continue
        minute = _extract_minutes(feature, index, requested)
        if minute is None:
            continue
        box = _geometry_bbox(geometry)
        if not box:
            continue
        boxes.append(box)
        color = CONTOUR_HEX.get(minute, "#0ea5e9")
        iso_features.append(
            {
                "type": "Feature",
                "properties": {"layer": "isochrone", "minutes": minute, "color": color},
                "geometry": geometry,
            }
        )
    if not iso_features:
        raise IsochroneError("没有生成有效的等时圈多边形", 502)

    iso_features.sort(key=lambda item: item["properties"]["minutes"])
    bbox = _bbox_union(boxes)
    if not bbox:
        raise IsochroneError("无法计算等时圈包围盒", 502)

    water = _filter_water(_get_layer(WATER_FILE), bbox) if include_water else []
    cities = _filter_cities(_get_layer(PLACES_FILE), bbox)
    return {
        "ok": True,
        "type": "FeatureCollection",
        "features": iso_features + water + cities,
        "meta": {
            "center": {"lat": lat, "lon": lon},
            "minutes": requested,
            "mode": mode,
            "mode_label": MODE_LABELS.get(mode, mode),
            "road_pref": road_pref,
            "road_pref_label": ROAD_PREF_LABELS.get(road_pref, road_pref),
            "avoid_tolls": avoid_tolls,
            "avoid_ferries": avoid_ferries,
            "avoid_unpaved": avoid_unpaved,
            "include_water": include_water,
            "bbox": bbox,
            "isochrone_count": len(iso_features),
            "water_count": len(water),
            "city_count": len(cities),
            "generated_at": int(time.time()),
            "attribution": "等时圈：Valhalla / OSM；底图：OpenStreetMap contributors",
        },
    }


# ---------------------------------------------------------------------------
# 对 API 层暴露的接口
# ---------------------------------------------------------------------------

def status_payload() -> dict:
    water = _get_layer(WATER_FILE)
    places = _get_layer(PLACES_FILE)
    return {
        "ok": True,
        "service": "isochrone",
        "valhalla_url": VALHALLA_URL,
        "data_dir": str(DATA_DIR),
        "water_features": len(water),
        "place_features": len(places),
        "available": bool(water and places),
        "center": DEFAULT_CENTER,
        "minutes": DEFAULT_MINUTES,
        "modes": [{"id": mode, "label": MODE_LABELS[mode]} for mode in MODE_COSTING],
        "road_prefs": [{"id": key, "label": ROAD_PREF_LABELS[key]} for key in ROAD_PREF_OPTIONS],
    }


def config_payload() -> dict:
    return {
        "ok": True,
        "center": DEFAULT_CENTER,
        "minutes": DEFAULT_MINUTES,
        "colors": CONTOUR_HEX,
        "valhalla_url": VALHALLA_URL,
        "modes": [{"id": mode, "label": MODE_LABELS[mode]} for mode in MODE_COSTING],
        "road_prefs": [{"id": key, "label": ROAD_PREF_LABELS[key]} for key in ROAD_PREF_OPTIONS],
    }


def isochrone_payload(payload: dict) -> dict:
    if not isinstance(payload, dict):
        raise IsochroneError("请求体必须是 JSON 对象")
    try:
        lat = float(payload.get("lat"))
        lon = float(payload.get("lon"))
    except (TypeError, ValueError) as exc:
        raise IsochroneError("lat / lon 必须是数字") from exc
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        raise IsochroneError("lat 或 lon 超出范围")

    mode = str(payload.get("mode") or "car").strip().lower()
    if mode not in MODE_COSTING:
        raise IsochroneError("交通方式无效，可选：步行、自行车、摩托车、汽车")
    road_pref = str(payload.get("road_pref") or "balanced").strip().lower()
    if road_pref not in ROAD_PREF_OPTIONS:
        raise IsochroneError("道路偏好无效，可选：高速优先、国道/主干优先、均衡、避开高速")
    avoid_tolls = _as_bool(payload.get("avoid_tolls"))
    avoid_ferries = _as_bool(payload.get("avoid_ferries"))
    avoid_unpaved = _as_bool(payload.get("avoid_unpaved"))
    # 默认不返回水系，减小响应体积；需要时显式传 include_water=true
    include_water = _as_bool(payload.get("include_water"), False)

    raw_minutes = payload.get("minutes") or DEFAULT_MINUTES
    if not isinstance(raw_minutes, list):
        raise IsochroneError("minutes 必须是数组")
    try:
        minutes = sorted({int(item) for item in raw_minutes})
    except (TypeError, ValueError) as exc:
        raise IsochroneError("minutes 必须是整数数组") from exc
    if not minutes or len(minutes) > 4:
        raise IsochroneError("minutes 必须包含 1~4 个时间")
    if any(minute < 1 or minute > 480 for minute in minutes):
        raise IsochroneError("minutes 必须在 1~480 之间")

    if not WATER_FILE.is_file() or not PLACES_FILE.is_file():
        raise IsochroneError(
            "等时圈数据未生成。请先运行 scripts/isochrone/extract_water_places.sh",
            503,
        )

    lat = round(lat, 5)
    lon = round(lon, 5)
    key = (
        lat,
        lon,
        tuple(minutes),
        mode,
        road_pref,
        avoid_tolls,
        avoid_ferries,
        avoid_unpaved,
        include_water,
    )
    cached = _cache_get(key)
    if cached is not None:
        return cached

    data = _valhalla_request(
        lat,
        lon,
        minutes,
        mode,
        road_pref,
        avoid_tolls,
        avoid_ferries,
        avoid_unpaved,
    )
    result = _assemble(
        lat,
        lon,
        minutes,
        data,
        mode,
        road_pref,
        avoid_tolls,
        avoid_ferries,
        avoid_unpaved,
        include_water,
    )
    _cache_put(key, result)
    return result
