"""Valhalla 等时圈服务客户端。"""

from __future__ import annotations

import os
from typing import Iterable

import httpx

VALHALLA_URL = os.getenv("VALHALLA_URL", "http://valhalla:8002").rstrip("/")

# 60/120/180/240 分钟，由深到浅的蓝色；Valhalla 接口里的 color 不带 #
CONTOUR_COLORS: dict[int, str] = {
    60: "0b3d91",
    120: "1d4ed8",
    180: "3b82f6",
    240: "7dd3fc",
}


class ValhallaError(RuntimeError):
    pass


async def fetch_isochrone(
    client: httpx.AsyncClient,
    lat: float,
    lon: float,
    minutes: Iterable[int],
) -> dict:
    """请求 Valhalla /isochrone，返回原始 GeoJSON（FeatureCollection）。"""
    minute_list = [int(m) for m in minutes]
    payload = {
        "locations": [{"lat": lat, "lon": lon}],
        "costing": "auto",
        "contours": [
            {"time": float(minute), "color": CONTOUR_COLORS.get(minute, "0ea5e9")}
            for minute in minute_list
        ],
        "polygons": True,
        "denoise": 1,
        "generalize": 80,
        "show_locations": False,
    }
    try:
        response = await client.post("/isochrone", json=payload)
    except httpx.HTTPError as exc:
        raise ValhallaError(f"无法连接 Valhalla 路由引擎：{exc}") from exc

    if response.status_code != 200:
        detail = response.text[:500].replace("\n", " ")
        raise ValhallaError(f"Valhalla 返回 {response.status_code}：{detail}")

    try:
        data = response.json()
    except ValueError as exc:
        raise ValhallaError("Valhalla 返回的不是合法 JSON") from exc

    if not isinstance(data, dict) or data.get("type") != "FeatureCollection":
        raise ValhallaError("Valhalla 返回结果缺少 FeatureCollection")
    if not data.get("features"):
        raise ValhallaError("Valhalla 没有返回等时圈要素，起点可能不在路网附近")
    return data
