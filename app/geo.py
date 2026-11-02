"""地理计算工具：距离、包围盒、抽稀、统计。"""

from __future__ import annotations

import math

EARTH_RADIUS = 6371008.8  # 米（IUGG 平均半径）

Point = list  # [lng, lat, ele, speed, time]


def is_valid_lnglat(lng, lat) -> bool:
    try:
        lng = float(lng)
        lat = float(lat)
    except (TypeError, ValueError):
        return False
    if not (math.isfinite(lng) and math.isfinite(lat)):
        return False
    return -180.0 <= lng <= 180.0 and -90.0 <= lat <= 90.0


def haversine(lng1: float, lat1: float, lng2: float, lat2: float) -> float:
    """两点球面距离（米）。"""
    rlat1 = math.radians(lat1)
    rlat2 = math.radians(lat2)
    dlat = rlat2 - rlat1
    dlng = math.radians(lng2 - lng1)
    a = math.sin(dlat / 2.0) ** 2 + math.cos(rlat1) * math.cos(rlat2) * math.sin(dlng / 2.0) ** 2
    a = min(1.0, max(0.0, a))
    return 2.0 * EARTH_RADIUS * math.asin(math.sqrt(a))


def _get(point, index):
    try:
        return point[index]
    except (IndexError, TypeError):
        return None


def point_distance(p1, p2) -> float:
    return haversine(float(p1[0]), float(p1[1]), float(p2[0]), float(p2[1]))


def point_time(point) -> float | None:
    t = _get(point, 4)
    if t is None:
        return None
    try:
        t = float(t)
    except (TypeError, ValueError):
        return None
    return t if math.isfinite(t) else None


def point_speed(point) -> float | None:
    s = _get(point, 3)
    if s is None:
        return None
    try:
        s = float(s)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(s) or s < 0:
        return None
    return s


def sanitize_points(points: list) -> list:
    """过滤非法点，统一补齐为 5 元数组 [lng, lat, ele, speed, time]。"""
    cleaned = []
    for p in points or []:
        if not p or len(p) < 2:
            continue
        lng, lat = p[0], p[1]
        if not is_valid_lnglat(lng, lat):
            continue
        ele = _get(p, 2)
        speed = _get(p, 3)
        time = _get(p, 4)
        try:
            ele = float(ele) if ele is not None and math.isfinite(float(ele)) else None
        except (TypeError, ValueError):
            ele = None
        try:
            speed = float(speed) if speed is not None and math.isfinite(float(speed)) and float(speed) >= 0 else None
        except (TypeError, ValueError):
            speed = None
        try:
            time = float(time) if time is not None and math.isfinite(float(time)) else None
        except (TypeError, ValueError):
            time = None
        cleaned.append([float(lng), float(lat), ele, speed, time])
    return cleaned


def dedupe_consecutive(points: list, min_meters: float) -> list:
    """去掉与上一个保留点距离过近的连续重复点（保留首尾）。"""
    if min_meters is None or min_meters <= 0 or len(points) <= 2:
        return list(points)
    out = [points[0]]
    for p in points[1:-1]:
        if point_distance(out[-1], p) >= min_meters:
            out.append(p)
    last = points[-1]
    if last is not out[-1]:
        out.append(last)
    return out


def segment_ranges(segments: list, count: int):
    """把 segments 起点数组展开为 [(start, end), ...]。"""
    if count <= 0:
        return []
    starts = sorted({int(s) for s in (segments or [0]) if isinstance(s, (int, float)) and 0 <= int(s) < count})
    if not starts or starts[0] != 0:
        starts.insert(0, 0)
    ranges = []
    for i, start in enumerate(starts):
        end = starts[i + 1] if i + 1 < len(starts) else count
        if end > start:
            ranges.append((start, end))
    return ranges


def simplify_points(points: list, tolerance_m: float) -> list:
    """Douglas-Peucker 抽稀；容差单位米。"""
    if not tolerance_m or tolerance_m <= 0 or len(points) <= 2:
        return list(points)
    lng0 = float(points[0][0])
    lat0 = float(points[0][1])
    scale_x = EARTH_RADIUS * math.cos(math.radians(lat0)) * math.pi / 180.0
    scale_y = EARTH_RADIUS * math.pi / 180.0

    def project(p):
        return ((float(p[0]) - lng0) * scale_x, (float(p[1]) - lat0) * scale_y)

    pts = [project(p) for p in points]
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    tol2 = float(tolerance_m) ** 2
    while stack:
        start, end = stack.pop()
        if end - start < 2:
            continue
        ax, ay = pts[start]
        bx, by = pts[end]
        dx, dy = bx - ax, by - ay
        seg_len2 = dx * dx + dy * dy
        max_dist2 = -1.0
        max_index = start
        for i in range(start + 1, end):
            px, py = pts[i]
            if seg_len2 == 0:
                dist2 = (px - ax) ** 2 + (py - ay) ** 2
            else:
                t = ((px - ax) * dx + (py - ay) * dy) / seg_len2
                t = max(0.0, min(1.0, t))
                qx, qy = ax + t * dx, ay + t * dy
                dist2 = (px - qx) ** 2 + (py - qy) ** 2
            if dist2 > max_dist2:
                max_dist2 = dist2
                max_index = i
        if max_dist2 > tol2:
            keep[max_index] = True
            stack.append((start, max_index))
            stack.append((max_index, end))
    return [p for i, p in enumerate(points) if keep[i]]


def fill_missing_speeds(points: list) -> list:
    """对缺失 speed 的点用相邻点距离/时间补全（仅同段内，需先分段后再调用）。"""
    for i, p in enumerate(points):
        if point_speed(p) is not None:
            continue
        if i == 0 or i + 1 >= len(points):
            continue
        prev, nxt = points[i - 1], points[i + 1]
        t0, t1 = point_time(prev), point_time(nxt)
        if t0 is None or t1 is None or t1 <= t0:
            continue
        d = point_distance(prev, nxt)
        p[3] = d / (t1 - t0)
    return points


def bbox(points: list) -> list | None:
    """返回 [min_lng, min_lat, max_lng, max_lat]。"""
    min_lng = min_lat = float("inf")
    max_lng = max_lat = float("-inf")
    found = False
    for p in points or []:
        if not p or len(p) < 2 or not is_valid_lnglat(p[0], p[1]):
            continue
        lng, lat = float(p[0]), float(p[1])
        min_lng = min(min_lng, lng)
        max_lng = max(max_lng, lng)
        min_lat = min(min_lat, lat)
        max_lat = max(max_lat, lat)
        found = True
    if not found:
        return None
    return [min_lng, min_lat, max_lng, max_lat]


def compute_stats(points: list, segments: list) -> dict:
    """计算轨迹统计信息。points 需为 WGS-84。"""
    points = points or []
    ranges = segment_ranges(segments or [0], len(points))
    distance_m = 0.0
    moving_duration = 0.0
    duration = 0.0
    max_speed = 0.0
    have_speed = False
    time_start = None
    time_end = None

    for start, end in ranges:
        seg = points[start:end]
        if not seg:
            continue
        for i in range(1, len(seg)):
            p0, p1 = seg[i - 1], seg[i]
            d = point_distance(p0, p1)
            distance_m += d
            t0, t1 = point_time(p0), point_time(p1)
            if t0 is not None and t1 is not None:
                dt = t1 - t0
                if dt > 0:
                    speed = d / dt
                    if speed >= 0.5:
                        moving_duration += dt
                    if speed > max_speed and speed < 200.0:  # 过滤明显 GPS 跳点
                        max_speed = speed
        for p in seg:
            t = point_time(p)
            if t is not None:
                time_start = t if time_start is None else min(time_start, t)
                time_end = t if time_end is None else max(time_end, t)
            s = point_speed(p)
            if s is not None:
                have_speed = True
                if s > max_speed and s < 200.0:
                    max_speed = s

    if time_start is not None and time_end is not None:
        # 分段轨迹时长按段内首尾时间累加，避免把中间空档算进运动时间
        for start, end in ranges:
            seg = points[start:end]
            ts = [point_time(p) for p in seg]
            ts = [t for t in ts if t is not None]
            if len(ts) >= 2:
                duration += max(ts) - min(ts)

    avg_speed = distance_m / duration if duration > 0 else 0.0
    return {
        "point_count": len(points),
        "distance_m": round(distance_m, 2),
        "duration_s": round(duration, 2),
        "moving_duration_s": round(moving_duration, 2),
        "avg_speed_kmh": round(avg_speed * 3.6, 2),
        "max_speed_kmh": round(max_speed * 3.6, 2) if have_speed or max_speed > 0 else 0.0,
        "segment_count": len(ranges),
        "time_start": time_start,
        "time_end": time_end,
    }
