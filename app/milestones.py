"""里程碑：根据轨迹库计算国/省/市/区 4 级点亮。"""

from __future__ import annotations

import threading
import time
from pathlib import Path

from . import crs
from .geo_admin import AdminGeo

SAMPLE_LIMIT = 160


def _sample_points(points: list, limit: int = SAMPLE_LIMIT) -> list:
    count = len(points)
    if count <= limit:
        return points
    step = count / float(limit)
    indexes = {0, count - 1}
    for i in range(1, limit):
        indexes.add(min(count - 1, int(i * step)))
    return [points[i] for i in sorted(indexes)]


class MilestoneService:
    def __init__(self, geo_dir: Path, library):
        self.library = library
        self.admin = AdminGeo(geo_dir)
        self.lock = threading.RLock()
        self._cache_key = None
        self._payload: dict | None = None
        self._geo_cache: dict[tuple, dict] = {}

    # ---------- 计算 ----------

    def _compute_visited(self) -> dict:
        visited = {"province": set(), "city": set(), "district": set()}
        for track in self.library.iter_tracks():
            for point in _sample_points(track.get("points") or []):
                try:
                    wgs_lng, wgs_lat = float(point[0]), float(point[1])
                except (TypeError, ValueError, IndexError):
                    continue
                gcj_lng, gcj_lat = crs.wgs84_to_gcj02(wgs_lng, wgs_lat)
                location = self.admin.locate(gcj_lng, gcj_lat)
                if not location:
                    continue
                province = location.get("province")
                city = location.get("city")
                district = location.get("district")
                if province:
                    visited["province"].add(province["adcode"])
                if city:
                    visited["city"].add(city["adcode"])
                if district:
                    visited["district"].add(district["adcode"])
        return visited

    def _build_payload(self, visited: dict) -> dict:
        provinces = []
        for province in self.admin.provinces:
            province_visited = province["adcode"] in visited["province"]
            cities = []
            for city in province.get("cities") or []:
                city_visited = city["adcode"] in visited["city"]
                districts = [
                    {
                        "adcode": district["adcode"],
                        "name": district["name"],
                        "visited": district["adcode"] in visited["district"],
                    }
                    for district in city.get("districts") or []
                ]
                cities.append(
                    {
                        "adcode": city["adcode"],
                        "name": city["name"],
                        "visited": city_visited,
                        "districts": districts,
                    }
                )
            provinces.append(
                {
                    "adcode": province["adcode"],
                    "name": province["name"],
                    "visited": province_visited,
                    "cities": cities,
                }
            )
        country_visited = 1 if visited["province"] else 0
        total = self.admin.counts or {}
        return {
            "ok": True,
            "updated_at": self.library.updated_at,
            "computed_at": time.time(),
            "data_source": self.admin.source,
            "counts": {
                "country": {"visited": country_visited, "total": 1},
                "province": {
                    "visited": len(visited["province"]),
                    "total": int(total.get("province") or len(self.admin.provinces)),
                },
                "city": {
                    "visited": len(visited["city"]),
                    "total": int(total.get("city") or sum(len(p.get("cities") or []) for p in self.admin.provinces)),
                },
                "district": {
                    "visited": len(visited["district"]),
                    "total": int(
                        total.get("district")
                        or sum(len(c.get("districts") or []) for p in self.admin.provinces for c in p.get("cities") or [])
                    ),
                },
            },
            "provinces": provinces,
        }

    def payload(self) -> dict:
        key = (self.library.updated_at, self.admin.version)
        with self.lock:
            if self._cache_key == key and self._payload is not None:
                return self._payload
            visited = self._compute_visited()
            payload = self._build_payload(visited)
            self._cache_key = key
            self._payload = payload
            self._geo_cache = {}
            return payload

    def geojson(self, target_crs: str = "GCJ02") -> dict:
        target_crs = "WGS84" if str(target_crs).upper() == "WGS84" else "GCJ02"
        payload = self.payload()
        key = (self._cache_key, target_crs)
        with self.lock:
            cached = self._geo_cache.get(key)
            if cached is not None:
                return cached
            visited_codes = {
                province["adcode"] for province in payload.get("provinces") or [] if province.get("visited")
            }
            data = self.admin.province_geojson(visited_codes, target_crs)
            data["ok"] = True
            data["crs"] = target_crs
            data["data_source"] = self.admin.source
            self._geo_cache[key] = data
            return data
