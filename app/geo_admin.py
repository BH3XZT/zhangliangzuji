"""离线中国行政区划边界：加载、点定位。

数据为 GCJ-02（高德坐标），由 tools/build_admin_geo.py 生成。
"""

from __future__ import annotations

import gzip
import json
import threading
from pathlib import Path

from . import crs


class AdminGeoError(Exception):
    pass


def _bbox_contains(bbox, lng: float, lat: float) -> bool:
    return bool(bbox) and bbox[0] <= lng <= bbox[2] and bbox[1] <= lat <= bbox[3]


def _point_in_ring(lng: float, lat: float, ring: list) -> bool:
    inside = False
    count = len(ring)
    if count < 3:
        return False
    j = count - 1
    for i in range(count):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > lat) != (yj > lat):
            x_cross = (xj - xi) * (lat - yi) / (yj - yi) + xi
            if lng < x_cross:
                inside = not inside
        j = i
    return inside


def _point_in_polys(lng: float, lat: float, polys: list) -> bool:
    for ring in polys or []:
        if _point_in_ring(lng, lat, ring):
            return True
    return False


class AdminGeo:
    def __init__(self, geo_dir: Path):
        path = Path(geo_dir) / "china_admin.json.gz"
        if not path.is_file():
            raise AdminGeoError(f"缺少行政区划数据：{path}")
        with gzip.open(path, "rt", encoding="utf-8") as fh:
            data = json.load(fh)
        self.data = data
        self.provinces = data.get("provinces") or []
        self.counts = data.get("counts") or {}
        self.source = data.get("source") or "DataV.GeoAtlas"
        self.version = data.get("generated_at") or 0
        self._cache: dict[tuple, dict | None] = {}
        self._lock = threading.Lock()

    def _province_hit(self, province: dict, lng: float, lat: float) -> bool:
        if not _bbox_contains(province.get("bbox"), lng, lat):
            return False
        return _point_in_polys(lng, lat, province.get("polys"))

    def locate(self, lng: float, lat: float) -> dict | None:
        """按 GCJ-02 坐标定位省/市/区，返回 {province, city, district} 或 None。"""
        key = (round(lng, 3), round(lat, 3))
        with self._lock:
            if key in self._cache:
                return self._cache[key]
        result = None
        for province in self.provinces:
            if not self._province_hit(province, lng, lat):
                continue
            result = {
                "province": {"adcode": province["adcode"], "name": province["name"]},
                "city": None,
                "district": None,
            }
            for city in province.get("cities") or []:
                city_hit = _bbox_contains(city.get("bbox"), lng, lat) and _point_in_polys(lng, lat, city.get("polys"))
                if not city_hit:
                    continue
                result["city"] = {"adcode": city["adcode"], "name": city["name"]}
                for district in city.get("districts") or []:
                    if _bbox_contains(district.get("bbox"), lng, lat) and _point_in_polys(lng, lat, district.get("polys")):
                        result["district"] = {"adcode": district["adcode"], "name": district["name"]}
                        break
                break
            break
        with self._lock:
            if len(self._cache) > 200_000:
                self._cache.clear()
            self._cache[key] = result
        return result

    def province_geojson(self, visited_codes: set[int], target_crs: str = "GCJ02") -> dict:
        """省级面 GeoJSON；target_crs=WGS84 时把 GCJ-02 转为 WGS-84。"""
        to_wgs = target_crs.upper() == "WGS84"
        features = []
        for province in self.provinces:
            coordinates = []
            for ring in province.get("polys") or []:
                converted = []
                for point in ring:
                    lng, lat = float(point[0]), float(point[1])
                    if to_wgs:
                        lng, lat = crs.gcj02_to_wgs84(lng, lat)
                    converted.append([round(lng, 6), round(lat, 6)])
                if len(converted) >= 3:
                    coordinates.append([converted])
            if not coordinates:
                continue
            features.append(
                {
                    "type": "Feature",
                    "properties": {
                        "adcode": province["adcode"],
                        "name": province["name"],
                        "visited": province["adcode"] in visited_codes,
                    },
                    "geometry": {"type": "MultiPolygon", "coordinates": coordinates},
                }
            )
        return {
            "type": "FeatureCollection",
            "features": features,
            "source": self.source,
        }
