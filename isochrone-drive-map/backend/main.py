"""城市自驾旅行时间等时圈 API。

功能：
- 接收起点 lat/lon 与分钟数列表；
- 调用 Valhalla /isochrone 获取自驾可达范围；
- 合并本地 OSM 提取的水系线段和城市点；
- 返回一个统一的 GeoJSON FeatureCollection（用 properties.layer 区分图层）；
- 对相同起点/时间做内存 LRU 缓存，避免重复请求 Valhalla。
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from collections import OrderedDict
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, field_validator

from utils import (
    bbox_union,
    filter_city_features,
    filter_water_features,
    geometry_bbox,
    load_feature_collection,
)
from valhalla_client import CONTOUR_COLORS, VALHALLA_URL, ValhallaError, fetch_isochrone

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("isochrone-api")

DATA_DIR = Path(os.getenv("DATA_DIR", "/data"))
WATER_FILE = DATA_DIR / "water.geojson"
PLACES_FILE = DATA_DIR / "places.geojson"

DEFAULT_CENTER = {"lat": 37.8706, "lon": 112.5489, "name": "太原市"}
DEFAULT_MINUTES = [60, 120, 180, 240]
CONTOUR_HEX = {minute: "#" + color for minute, color in CONTOUR_COLORS.items()}
CACHE_MAX = 64


class IsochroneRequest(BaseModel):
    lat: float = Field(..., ge=-90, le=90, description="起点纬度")
    lon: float = Field(..., ge=-180, le=180, description="起点经度")
    minutes: list[int] = Field(default_factory=lambda: list(DEFAULT_MINUTES), description="等时圈分钟数，最多 4 个")

    @field_validator("minutes")
    @classmethod
    def validate_minutes(cls, value: list[int]) -> list[int]:
        minutes = sorted({int(item) for item in value})
        if not minutes:
            raise ValueError("minutes 不能为空")
        if len(minutes) > 4:
            raise ValueError("最多同时请求 4 个等时圈")
        if any(minute < 1 or minute > 480 for minute in minutes):
            raise ValueError("分钟数必须在 1~480 之间")
        return minutes


class CacheStore:
    """简单的线程/协程安全 LRU。"""

    def __init__(self, capacity: int = CACHE_MAX):
        self.capacity = capacity
        self._data: OrderedDict[tuple, dict] = OrderedDict()
        self._lock = asyncio.Lock()

    async def get(self, key: tuple) -> dict | None:
        async with self._lock:
            if key not in self._data:
                return None
            value = self._data.pop(key)
            self._data[key] = value
            return value

    async def put(self, key: tuple, value: dict) -> None:
        async with self._lock:
            self._data[key] = value
            self._data.move_to_end(key)
            while len(self._data) > self.capacity:
                self._data.popitem(last=False)


cache = CacheStore()


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.water_features = load_feature_collection(WATER_FILE)
    app.state.place_features = load_feature_collection(PLACES_FILE)
    app.state.http = httpx.AsyncClient(
        base_url=VALHALLA_URL,
        timeout=httpx.Timeout(180.0, connect=10.0),
    )
    logger.info("Valhalla URL: %s", VALHALLA_URL)
    logger.info("水系要素：%s（%s）", len(app.state.water_features), WATER_FILE)
    logger.info("城市点：%s（%s）", len(app.state.place_features), PLACES_FILE)
    if not app.state.water_features:
        logger.warning("未找到水系数据，请先运行 scripts/extract_water_places.sh")
    if not app.state.place_features:
        logger.warning("未找到城市点数据，请先运行 scripts/extract_water_places.sh")
    yield
    await app.state.http.aclose()


app = FastAPI(
    title="城市自驾等时圈地图 API",
    description="Valhalla 自驾等时圈 + OSM 水系/城市点合并服务",
    version="1.0.0",
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _extract_minutes(feature: dict, index: int, requested: list[int]) -> int | None:
    props = feature.get("properties") or {}
    for key in ("contour", "time", "minutes"):
        if key in props:
            try:
                return int(round(float(props[key])))
            except (TypeError, ValueError):
                pass
    # 兜底：Valhalla 正常会返回 contour，这里按顺序对应
    if index < len(requested):
        return requested[index]
    return None


def assemble_response(
    lat: float,
    lon: float,
    minutes: list[int],
    isochrone_data: dict,
    water_features: list[dict],
    place_features: list[dict],
) -> dict:
    """把 Valhalla 等时圈、本地水系、城市点合并成一个 FeatureCollection。"""
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
        feature_box = geometry_bbox(geometry)
        if not feature_box:
            continue
        boxes.append(feature_box)
        color = CONTOUR_HEX.get(minute, "#0ea5e9")
        iso_features.append(
            {
                "type": "Feature",
                "properties": {
                    "layer": "isochrone",
                    "minutes": minute,
                    "color": color,
                    "stroke": color,
                },
                "geometry": geometry,
            }
        )

    if not iso_features:
        raise ValhallaError("没有生成有效的等时圈多边形")

    # 等时圈按分钟从小到大；前端按分钟分层过滤，绘制顺序由前端控制
    iso_features.sort(key=lambda item: item["properties"]["minutes"])
    outer_bbox = bbox_union(boxes)
    if not outer_bbox:
        raise ValhallaError("无法计算等时圈包围盒")

    water = filter_water_features(water_features, outer_bbox)
    cities = filter_city_features(place_features, outer_bbox)

    return {
        "type": "FeatureCollection",
        "features": iso_features + water + cities,
        "meta": {
            "center": {"lat": lat, "lon": lon},
            "minutes": requested,
            "bbox": outer_bbox,
            "isochrone_count": len(iso_features),
            "water_count": len(water),
            "city_count": len(cities),
            "generated_at": int(time.time()),
            "attribution": "等时圈：Valhalla / OSM；底图：OpenStreetMap contributors",
        },
    }


@app.get("/api/health")
async def health(request: Request):
    """轻量健康检查；不主动请求 Valhalla，避免拖慢 Docker healthcheck。"""
    return {
        "status": "ok",
        "service": "isochrone-api",
        "version": "1.0.0",
        "valhalla_url": VALHALLA_URL,
        "water_features": len(request.app.state.water_features),
        "place_features": len(request.app.state.place_features),
    }


@app.get("/api/config")
async def config():
    return {
        "center": DEFAULT_CENTER,
        "minutes": DEFAULT_MINUTES,
        "colors": CONTOUR_HEX,
        "valhalla_url": VALHALLA_URL,
    }


@app.post("/api/isochrone")
async def isochrone(payload: IsochroneRequest, request: Request):
    """计算等时圈并返回合并后的 GeoJSON。"""
    lat = round(payload.lat, 5)
    lon = round(payload.lon, 5)
    minutes = sorted(set(payload.minutes))
    key = (lat, lon, tuple(minutes))

    cached = await cache.get(key)
    if cached is not None:
        logger.info("缓存命中 %s", key)
        return cached

    try:
        isochrone_data = await fetch_isochrone(request.app.state.http, lat, lon, minutes)
    except ValhallaError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        logger.exception("请求 Valhalla 失败")
        raise HTTPException(status_code=502, detail=f"请求 Valhalla 失败：{exc}") from exc

    try:
        result = assemble_response(
            lat,
            lon,
            minutes,
            isochrone_data,
            request.app.state.water_features,
            request.app.state.place_features,
        )
    except ValhallaError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    await cache.put(key, result)
    logger.info("生成等时圈 %s：水系 %s / 城市 %s", key, result["meta"]["water_count"], result["meta"]["city_count"])
    return result


@app.get("/")
async def root():
    return {"name": "城市自驾等时圈地图 API", "docs": "/docs", "health": "/api/health"}
