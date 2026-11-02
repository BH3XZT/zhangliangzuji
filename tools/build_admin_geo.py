"""构建离线中国行政区划边界数据（开发工具，不参与运行时）。

数据来源：阿里云 DataV.GeoAtlas（高德开放平台行政边界）
- 国家级：100000_full.json -> 省级
- 省级：{adcode}_full.json -> 市级 / 直辖市为区级
- 市级：{adcode}_full.json -> 区县级

输出：geo/china_admin.json.gz
结构：
{
  "version": 1,
  "source": "...",
  "generated_at": ...,
  "provinces": [
    {"adcode": 110000, "name": "北京市", "bbox": [...], "polys": [[[lng,lat],...], ...],
     "cities": [
        {"adcode": 110100, "name": "北京市", "bbox": [...], "polys": [...],
         "districts": [{"adcode": 110101, "name": "东城区", "bbox": [...], "polys": [...]}] }
     ]}
  ]
}
坐标保留 GCJ-02（与高德底图一致）；服务端做里程碑计算时把 WGS-84 轨迹点转成 GCJ-02。
"""

from __future__ import annotations

import gzip
import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.request

BASE_URL = "https://geo.datav.aliyun.com/areas_v3/bound/{adcode}_full.json"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE_DIR = os.path.join(ROOT, ".geo_cache")
OUT_DIR = os.path.join(ROOT, "geo")
OUT_FILE = os.path.join(OUT_DIR, "china_admin.json.gz")
SOURCE = "阿里云 DataV.GeoAtlas（高德开放平台行政区划边界）"

TOLERANCE = {"province": 0.0035, "city": 0.0030, "district": 0.0025}

_CTX = ssl._create_unverified_context()
_UA = {"User-Agent": "MapTrackMerger-geo-builder/1.0"}


def log(*args):
    print(*args, flush=True)


def fetch_children(adcode: int):
    """获取某 adcode 的下级行政区（失败返回 None）。"""
    os.makedirs(CACHE_DIR, exist_ok=True)
    cache_path = os.path.join(CACHE_DIR, f"{adcode}_full.json")
    if os.path.exists(cache_path) and os.path.getsize(cache_path) > 100:
        try:
            with open(cache_path, "r", encoding="utf-8") as fh:
                return json.load(fh).get("features", [])
        except (ValueError, OSError):
            pass
    url = BASE_URL.format(adcode=adcode)
    last_error = None
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers=_UA)
            with urllib.request.urlopen(req, context=_CTX, timeout=40) as resp:
                data = resp.read()
            with open(cache_path, "wb") as fh:
                fh.write(data)
            obj = json.loads(data)
            return obj.get("features", [])
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return None
            last_error = exc
        except Exception as exc:  # noqa: BLE001
            last_error = exc
        time.sleep(0.6 * (attempt + 1))
    log(f"  [warn] fetch {adcode} failed: {last_error!r}")
    return None


def _simplify_ring(points: list, tolerance: float) -> list:
    """Douglas-Peucker（度为单位），返回 [[lng,lat], ...]。"""
    if len(points) <= 4:
        return points
    # 去掉闭合重复点
    if points[0] == points[-1]:
        points = points[:-1]
    if len(points) <= 4:
        return points
    tol2 = tolerance * tolerance

    def perp2(p, a, b):
        ax, ay = a
        bx, by = b
        px, py = p
        dx, dy = bx - ax, by - ay
        if dx == 0 and dy == 0:
            return (px - ax) ** 2 + (py - ay) ** 2
        t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)
        t = max(0.0, min(1.0, t))
        qx, qy = ax + t * dx, ay + t * dy
        return (px - qx) ** 2 + (py - qy) ** 2

    stack = [(0, len(points) - 1)]
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    while stack:
        start, end = stack.pop()
        if end - start < 2:
            continue
        max_dist = -1.0
        max_index = start
        for i in range(start + 1, end):
            dist = perp2(points[i], points[start], points[end])
            if dist > max_dist:
                max_dist = dist
                max_index = i
        if max_dist > tol2:
            keep[max_index] = True
            stack.append((start, max_index))
            stack.append((max_index, end))
    return [p for i, p in enumerate(points) if keep[i]]


def _round_point(coord) -> list:
    return [round(float(coord[0]), 4), round(float(coord[1]), 4)]


def geometry_to_polys(geometry: dict, tolerance: float) -> list:
    if not geometry:
        return []
    gtype = geometry.get("type")
    if gtype == "GeometryCollection":
        rings = []
        for item in geometry.get("geometries") or []:
            rings.extend(geometry_to_polys(item, tolerance))
        return rings
    if gtype == "Polygon":
        polygons = [geometry.get("coordinates") or []]
    elif gtype == "MultiPolygon":
        polygons = geometry.get("coordinates") or []
    else:
        return []
    result = []
    for polygon in polygons:
        for ring in polygon:
            if not isinstance(ring, list) or len(ring) < 4:
                continue
            points = [_round_point(c) for c in ring if isinstance(c, (list, tuple)) and len(c) >= 2]
            simplified = _simplify_ring(points, tolerance)
            if len(simplified) >= 3:
                result.append(simplified)
    return result


def bbox_of_polys(polys: list):
    if not polys:
        return None
    xs = [p[0] for ring in polys for p in ring]
    ys = [p[1] for ring in polys for p in ring]
    return [min(xs), min(ys), max(xs), max(ys)]


def _adcode_of(feature) -> int | None:
    props = feature.get("properties") or {}
    code = props.get("adcode")
    try:
        return int(code)
    except (TypeError, ValueError):
        return None


def _name_of(feature) -> str:
    return str((feature.get("properties") or {}).get("name") or "").strip()


def _level_of(feature) -> str:
    return str((feature.get("properties") or {}).get("level") or "").strip()


def make_region(feature, level: str) -> dict | None:
    adcode = _adcode_of(feature)
    if adcode is None:
        return None
    polys = geometry_to_polys(feature.get("geometry") or {}, TOLERANCE[level])
    if not polys:
        return None
    return {
        "adcode": adcode,
        "name": _name_of(feature),
        "bbox": bbox_of_polys(polys),
        "polys": polys,
    }


MUNICIPALITY_CITY = {110000: 110100, 120000: 120100, 310000: 310100, 500000: 500100}


def build():
    os.makedirs(OUT_DIR, exist_ok=True)
    log("fetch country ...")
    country = fetch_children(100000)
    if not country:
        raise SystemExit("无法获取国家级数据")
    provinces = []
    total_cities = 0
    total_districts = 0
    for index, feature in enumerate(country, 1):
        if _level_of(feature) != "province":
            continue
        province = make_region(feature, "province")
        if not province:
            continue
        code = province["adcode"]
        province["cities"] = []
        log(f"[{index}/{len(country)}] {code} {province['name']}")
        children = fetch_children(code) or []
        child_levels = {_level_of(child) for child in children}
        if "district" in child_levels:
            # 直辖市 / 特别行政区：区县直接挂在省级下，合成一个市级节点
            city_code = MUNICIPALITY_CITY.get(code, code)
            city = {
                "adcode": city_code,
                "name": province["name"],
                "bbox": province["bbox"],
                "polys": province["polys"],
                "districts": [],
            }
            for child in children:
                if _level_of(child) != "district":
                    continue
                district = make_region(child, "district")
                if district:
                    city["districts"].append(district)
            if city["districts"]:
                province["cities"].append(city)
        elif "city" in child_levels:
            for city_feature in children:
                if _level_of(city_feature) != "city":
                    continue
                city = make_region(city_feature, "city")
                if not city:
                    continue
                districts_children = fetch_children(city["adcode"]) or []
                city["districts"] = []
                for district_feature in districts_children:
                    if _level_of(district_feature) != "district":
                        continue
                    district = make_region(district_feature, "district")
                    if district:
                        city["districts"].append(district)
                if not city["districts"]:
                    # 兜底：没有下级区县时，把市本身当作一个区县节点
                    city["districts"].append(
                        {
                            "adcode": city["adcode"],
                            "name": city["name"],
                            "bbox": city["bbox"],
                            "polys": city["polys"],
                        }
                    )
                province["cities"].append(city)
        if not province["cities"]:
            # 兜底：省本身作为市级节点
            province["cities"].append(
                {
                    "adcode": province["adcode"],
                    "name": province["name"],
                    "bbox": province["bbox"],
                    "polys": province["polys"],
                    "districts": [
                        {
                            "adcode": province["adcode"],
                            "name": province["name"],
                            "bbox": province["bbox"],
                            "polys": province["polys"],
                        }
                    ],
                }
            )
        total_cities += len(province["cities"])
        total_districts += sum(len(city["districts"]) for city in province["cities"])
        provinces.append(province)

    payload = {
        "version": 1,
        "source": SOURCE,
        "generated_at": int(time.time()),
        "counts": {
            "province": len(provinces),
            "city": total_cities,
            "district": total_districts,
        },
        "provinces": provinces,
    }
    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    with gzip.GzipFile(OUT_FILE, "wb", compresslevel=9, mtime=0) as fh:
        fh.write(raw)
    log(
        f"saved {OUT_FILE} raw={len(raw)/1024/1024:.2f}MB gz={os.path.getsize(OUT_FILE)/1024/1024:.2f}MB "
        f"provinces={len(provinces)} cities={total_cities} districts={total_districts}"
    )


if __name__ == "__main__":
    build()
