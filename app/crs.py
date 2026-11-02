"""坐标系转换：WGS-84 / GCJ-02（火星坐标）/ BD-09（百度坐标）。

所有函数参数均为 (lng, lat)，返回 (lng, lat)。
- WGS-84：GPS 原始坐标，GPX/KML/GeoJSON/TCX 等国际格式的标准坐标系。
- GCJ-02：中国国测局加密坐标，高德、腾讯、Google 中国地图使用。
- BD-09：百度在 GCJ-02 基础上再次偏移的坐标，百度地图使用。
中国境外坐标不做偏移。
"""

from __future__ import annotations

import math

__all__ = [
    "CRS_IDS",
    "CRS_LABELS",
    "normalize_crs",
    "crs_label",
    "out_of_china",
    "wgs84_to_gcj02",
    "gcj02_to_wgs84",
    "gcj02_to_bd09",
    "bd09_to_gcj02",
    "wgs84_to_bd09",
    "bd09_to_wgs84",
    "to_wgs84",
    "from_wgs84",
    "convert_point_to_wgs84",
    "convert_point_from_wgs84",
    "convert_points_to_wgs84",
    "convert_points_from_wgs84",
]

CRS_IDS = ("WGS84", "GCJ02", "BD09")

CRS_LABELS = {
    "WGS84": "WGS-84（GPS / GPX / KML 标准坐标）",
    "GCJ02": "GCJ-02（高德 / 腾讯 / Google 中国）",
    "BD09": "BD-09（百度地图）",
}

# 常见别名（大小写不敏感）
_ALIASES = {
    "WGS84": "WGS84",
    "WGS-84": "WGS84",
    "WGS_84": "WGS84",
    "WGS 84": "WGS84",
    "WGS": "WGS84",
    "GPS": "WGS84",
    "EPSG:4326": "WGS84",
    "4326": "WGS84",
    "GCJ02": "GCJ02",
    "GCJ-02": "GCJ02",
    "GCJ_02": "GCJ02",
    "GCJ": "GCJ02",
    "火星": "GCJ02",
    "火星坐标": "GCJ02",
    "AMAP": "GCJ02",
    "高德": "GCJ02",
    "TENCENT": "GCJ02",
    "腾讯": "GCJ02",
    "BD09": "BD09",
    "BD-09": "BD09",
    "BD_09": "BD09",
    "BD": "BD09",
    "百度": "BD09",
    "BAIDU": "BD09",
}

_A = 6378245.0
_EE = 0.00669342162296594323
_X_PI = math.pi * 3000.0 / 180.0
_PI = math.pi


def normalize_crs(value: str | None, default: str = "WGS84") -> str:
    """把用户/文件里的坐标系列名归一化为 WGS84 / GCJ02 / BD09。"""
    if value is None:
        return default
    key = str(value).strip().upper().replace(" ", "")
    if key in _ALIASES:
        return _ALIASES[key]
    raw = str(value).strip()
    if raw in _ALIASES:
        return _ALIASES[raw]
    return default


def crs_label(crs: str) -> str:
    return CRS_LABELS.get(normalize_crs(crs), CRS_LABELS["WGS84"])


def out_of_china(lng: float, lat: float) -> bool:
    """粗略判断是否在中国境外（境外不做偏移）。"""
    return not (72.004 <= lng <= 137.8347 and 0.8293 <= lat <= 55.8271)


def _transform_lat(x: float, y: float) -> float:
    ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * math.sqrt(abs(x))
    ret += (20.0 * math.sin(6.0 * x * _PI) + 20.0 * math.sin(2.0 * x * _PI)) * 2.0 / 3.0
    ret += (20.0 * math.sin(y * _PI) + 40.0 * math.sin(y / 3.0 * _PI)) * 2.0 / 3.0
    ret += (160.0 * math.sin(y / 12.0 * _PI) + 320.0 * math.sin(y * _PI / 30.0)) * 2.0 / 3.0
    return ret


def _transform_lng(x: float, y: float) -> float:
    ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * math.sqrt(abs(x))
    ret += (20.0 * math.sin(6.0 * x * _PI) + 20.0 * math.sin(2.0 * x * _PI)) * 2.0 / 3.0
    ret += (20.0 * math.sin(x * _PI) + 40.0 * math.sin(x / 3.0 * _PI)) * 2.0 / 3.0
    ret += (150.0 * math.sin(x / 12.0 * _PI) + 300.0 * math.sin(x / 30.0 * _PI)) * 2.0 / 3.0
    return ret


def _delta(lng: float, lat: float) -> tuple[float, float]:
    dlat = _transform_lat(lng - 105.0, lat - 35.0)
    dlng = _transform_lng(lng - 105.0, lat - 35.0)
    rad_lat = lat / 180.0 * _PI
    magic = math.sin(rad_lat)
    magic = 1 - _EE * magic * magic
    sqrt_magic = math.sqrt(magic)
    dlat = (dlat * 180.0) / ((_A * (1 - _EE)) / (magic * sqrt_magic) * _PI)
    dlng = (dlng * 180.0) / (_A / sqrt_magic * math.cos(rad_lat) * _PI)
    return dlng, dlat


def wgs84_to_gcj02(lng: float, lat: float) -> tuple[float, float]:
    """WGS-84 → GCJ-02。"""
    if out_of_china(lng, lat):
        return lng, lat
    dlng, dlat = _delta(lng, lat)
    return lng + dlng, lat + dlat


def gcj02_to_wgs84(lng: float, lat: float, iterations: int = 8) -> tuple[float, float]:
    """GCJ-02 → WGS-84（迭代逼近，精度 < 1e-9 度，约 0.1 毫米）。"""
    if out_of_china(lng, lat):
        return lng, lat
    wlng, wlat = lng, lat
    for _ in range(iterations):
        glng, glat = wgs84_to_gcj02(wlng, wlat)
        dlng = lng - glng
        dlat = lat - glat
        wlng += dlng
        wlat += dlat
        if abs(dlng) < 1e-12 and abs(dlat) < 1e-12:
            break
    return wlng, wlat


def bd09_to_gcj02(lng: float, lat: float) -> tuple[float, float]:
    """BD-09 → GCJ-02（近似解 + 迭代逼近，与 gcj02_to_bd09 严格互逆）。"""
    if out_of_china(lng, lat):
        return lng, lat
    x = lng - 0.0065
    y = lat - 0.006
    z = math.sqrt(x * x + y * y) - 0.00002 * math.sin(y * _X_PI)
    theta = math.atan2(y, x) - 0.000003 * math.cos(x * _X_PI)
    glng, glat = z * math.cos(theta), z * math.sin(theta)
    for _ in range(6):
        blng, blat = gcj02_to_bd09(glng, glat)
        dlng = lng - blng
        dlat = lat - blat
        glng += dlng
        glat += dlat
        if abs(dlng) < 1e-12 and abs(dlat) < 1e-12:
            break
    return glng, glat


def gcj02_to_bd09(lng: float, lat: float) -> tuple[float, float]:
    """GCJ-02 → BD-09。"""
    if out_of_china(lng, lat):
        return lng, lat
    z = math.sqrt(lng * lng + lat * lat) + 0.00002 * math.sin(lat * _X_PI)
    theta = math.atan2(lat, lng) + 0.000003 * math.cos(lng * _X_PI)
    return z * math.cos(theta) + 0.0065, z * math.sin(theta) + 0.006


def wgs84_to_bd09(lng: float, lat: float) -> tuple[float, float]:
    glng, glat = wgs84_to_gcj02(lng, lat)
    return gcj02_to_bd09(glng, glat)


def bd09_to_wgs84(lng: float, lat: float) -> tuple[float, float]:
    glng, glat = bd09_to_gcj02(lng, lat)
    return gcj02_to_wgs84(glng, glat)


def to_wgs84(lng: float, lat: float, crs: str) -> tuple[float, float]:
    """任意坐标系 → WGS-84。"""
    crs = normalize_crs(crs)
    if crs == "GCJ02":
        return gcj02_to_wgs84(lng, lat)
    if crs == "BD09":
        return bd09_to_wgs84(lng, lat)
    return lng, lat


def from_wgs84(lng: float, lat: float, crs: str) -> tuple[float, float]:
    """WGS-84 → 任意坐标系。"""
    crs = normalize_crs(crs)
    if crs == "GCJ02":
        return wgs84_to_gcj02(lng, lat)
    if crs == "BD09":
        return wgs84_to_bd09(lng, lat)
    return lng, lat


def _finite(value) -> bool:
    try:
        return value is not None and math.isfinite(float(value))
    except (TypeError, ValueError):
        return False


def convert_point_to_wgs84(point: list, crs: str) -> list:
    """把 [lng, lat, ele, speed, time] 从 crs 转换到 WGS-84，返回新列表。"""
    lng, lat = point[0], point[1]
    if not (_finite(lng) and _finite(lat)):
        return point
    if normalize_crs(crs) == "WGS84":
        return point
    nlng, nlat = to_wgs84(float(lng), float(lat), crs)
    out = list(point)
    out[0], out[1] = nlng, nlat
    return out


def convert_point_from_wgs84(point: list, crs: str) -> list:
    """把 [lng, lat, ele, speed, time] 从 WGS-84 转换到 crs，返回新列表。"""
    lng, lat = point[0], point[1]
    if not (_finite(lng) and _finite(lat)):
        return point
    if normalize_crs(crs) == "WGS84":
        return point
    nlng, nlat = from_wgs84(float(lng), float(lat), crs)
    out = list(point)
    out[0], out[1] = nlng, nlat
    return out


def convert_points_to_wgs84(points: list, crs: str) -> list:
    crs = normalize_crs(crs)
    if crs == "WGS84":
        return points
    return [convert_point_to_wgs84(p, crs) for p in points]


def convert_points_from_wgs84(points: list, crs: str) -> list:
    crs = normalize_crs(crs)
    if crs == "WGS84":
        return points
    return [convert_point_from_wgs84(p, crs) for p in points]
