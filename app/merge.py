"""轨迹合并引擎：排序、去重、分段、抽稀、限速过滤、统计。"""

from __future__ import annotations

from . import geo

DEFAULT_OPTIONS = {
    "mode": "single",
    "sort_by_time": True,
    "join_tracks": True,
    "gap_seconds": 600,
    "dedupe_meters": 1.0,
    "simplify_meters": 0.0,
    "max_speed_kmh": 0.0,
}


def _as_bool(value, default: bool) -> bool:
    if value is None:
        return default
    if isinstance(value, str):
        return value.strip().lower() in ("1", "true", "yes", "on", "是")
    return bool(value)


def normalize_options(options: dict | None) -> dict:
    options = options or {}
    if not isinstance(options, dict):
        options = {}
    mode = str(options.get("mode") or "single").strip().lower()
    if mode not in ("single", "separate"):
        mode = "single"
    normalized = dict(DEFAULT_OPTIONS)
    normalized["mode"] = mode
    normalized["sort_by_time"] = _as_bool(options.get("sort_by_time"), True)
    normalized["join_tracks"] = _as_bool(options.get("join_tracks"), True)
    for key, minimum, maximum in (
        ("gap_seconds", 0.0, 30 * 24 * 3600.0),
        ("dedupe_meters", 0.0, 10000.0),
        ("simplify_meters", 0.0, 10000.0),
        ("max_speed_kmh", 0.0, 1000.0),
    ):
        value = options.get(key, normalized[key])
        try:
            value = float(value)
        except (TypeError, ValueError):
            value = normalized[key]
        if value != value or value < minimum:
            value = normalized[key]
        normalized[key] = min(value, maximum)
    return normalized


def _gap_starts(points: list, gap_seconds: float) -> list[int]:
    if gap_seconds <= 0 or len(points) < 2:
        return [0]
    starts = [0]
    last_time = geo.point_time(points[0])
    for index in range(1, len(points)):
        current = geo.point_time(points[index])
        if last_time is not None and current is not None and current - last_time > gap_seconds:
            starts.append(index)
        if current is not None:
            last_time = current
    return starts


def _filter_speed(points: list, max_speed_kmh: float) -> list:
    if max_speed_kmh <= 0 or len(points) < 3:
        return points
    kept = [points[0]]
    for point in points[1:]:
        previous = kept[-1]
        t0, t1 = geo.point_time(previous), geo.point_time(point)
        if t0 is not None and t1 is not None:
            dt = t1 - t0
            if dt > 0:
                speed_kmh = geo.point_distance(previous, point) / dt * 3.6
                if speed_kmh > max_speed_kmh:
                    continue
        kept.append(point)
    return kept


def _process_points(points: list, options: dict) -> tuple[list, list[int]]:
    """单条轨迹内部：过滤 → 分段 → 去重 → 抽稀。"""
    points = geo.sanitize_points(points)
    if not points:
        return [], [0]
    starts = _gap_starts(points, options["gap_seconds"])
    output: list[list] = []
    segments: list[int] = []
    for start, end in geo.segment_ranges(starts, len(points)):
        segment = points[start:end]
        segment = _filter_speed(segment, options["max_speed_kmh"])
        segment = geo.dedupe_consecutive(segment, options["dedupe_meters"])
        segment = geo.simplify_points(segment, options["simplify_meters"])
        if not segment:
            continue
        segments.append(len(output))
        output.extend(segment)
    return output, segments or [0]


def _fill_speeds_in_segments(points: list, segments: list[int]) -> None:
    for start, end in geo.segment_ranges(segments, len(points)):
        geo.fill_missing_speeds(points[start:end])


def _round_points(points: list) -> list:
    rounded = []
    for point in points:
        lng = round(float(point[0]), 7)
        lat = round(float(point[1]), 7)
        ele = round(float(point[2]), 2) if point[2] is not None else None
        speed = round(float(point[3]), 3) if point[3] is not None else None
        time_value = round(float(point[4]), 3) if point[4] is not None else None
        rounded.append([lng, lat, ele, speed, time_value])
    return rounded


def _track_stats(points: list, segments: list[int]) -> dict:
    _fill_speeds_in_segments(points, segments)
    return geo.compute_stats(points, segments)


def _make_result_track(index: int, name: str, points: list, segments: list[int]) -> dict:
    stats = _track_stats(points, segments)
    points = _round_points(points)
    segments = sorted({int(s) for s in segments if 0 <= int(s) < len(points)})
    if not segments:
        segments = [0]
    if segments[0] != 0:
        segments.insert(0, 0)
    return {
        "id": f"m{index + 1}",
        "name": name,
        "points": points,
        "segments": segments,
        "point_count": stats["point_count"],
        "distance_m": stats["distance_m"],
        "duration_s": stats["duration_s"],
        "moving_duration_s": stats["moving_duration_s"],
        "time_start": stats["time_start"],
        "time_end": stats["time_end"],
        "bbox": geo.bbox(points),
        "stats": stats,
    }


def _aggregate(tracks: list[dict]) -> dict:
    distance = 0.0
    duration = 0.0
    moving = 0.0
    max_speed = 0.0
    point_count = 0
    segment_count = 0
    time_start = None
    time_end = None
    all_points: list[list] = []
    for track in tracks:
        stats = track["stats"]
        distance += stats["distance_m"]
        duration += stats["duration_s"]
        moving += stats["moving_duration_s"]
        max_speed = max(max_speed, stats["max_speed_kmh"])
        point_count += stats["point_count"]
        segment_count += stats["segment_count"]
        if stats["time_start"] is not None:
            time_start = stats["time_start"] if time_start is None else min(time_start, stats["time_start"])
        if stats["time_end"] is not None:
            time_end = stats["time_end"] if time_end is None else max(time_end, stats["time_end"])
        all_points.extend(track["points"])
    avg_speed = distance / duration * 3.6 if duration > 0 else 0.0
    return {
        "track_count": len(tracks),
        "segment_count": segment_count,
        "point_count": point_count,
        "distance_m": round(distance, 2),
        "duration_s": round(duration, 2),
        "moving_duration_s": round(moving, 2),
        "avg_speed_kmh": round(avg_speed, 2),
        "max_speed_kmh": round(max_speed, 2),
        "time_start": time_start,
        "time_end": time_end,
        "bbox": geo.bbox(all_points),
    }


def _sort_key(track: dict):
    times = [geo.point_time(p) for p in track.get("points") or []]
    times = [t for t in times if t is not None]
    if times:
        return (0, min(times))
    return (1, 0.0)


def merge_tracks(tracks: list[dict], options: dict | None = None) -> tuple[list[dict], dict]:
    """合并轨迹。输入 points 必须是 WGS-84。

    返回 (合并后的轨迹列表, 汇总统计)。
    """
    options = normalize_options(options)
    prepared: list[dict] = []
    for index, track in enumerate(tracks or []):
        if not isinstance(track, dict):
            continue
        points = track.get("points")
        if not isinstance(points, list):
            continue
        prepared.append(
            {
                "name": str(track.get("name") or f"轨迹{index + 1}"),
                "points": points,
            }
        )
    if not prepared:
        raise ValueError("没有可合并的轨迹数据")

    if options["mode"] == "separate":
        results = []
        for index, track in enumerate(prepared):
            points, segments = _process_points(track["points"], options)
            if not points:
                continue
            results.append(_make_result_track(index, track["name"], points, segments))
        if not results:
            raise ValueError("所选轨迹中没有有效点")
        return results, _aggregate(results)

    ordered = prepared
    if options["sort_by_time"]:
        ordered = sorted(prepared, key=_sort_key)

    combined: list[list] = []
    segments: list[int] = [0]
    previous_last_time = None
    for track in ordered:
        points, starts = _process_points(track["points"], options)
        if not points:
            continue
        if not combined:
            segments = [0]
            for start in starts[1:]:
                segments.append(start)
        else:
            first_time = geo.point_time(points[0])
            joinable = bool(
                options["join_tracks"]
                and options["gap_seconds"] > 0
                and previous_last_time is not None
                and first_time is not None
                and 0 <= first_time - previous_last_time <= options["gap_seconds"]
            )
            if joinable:
                for start in starts[1:]:
                    segments.append(len(combined) + start)
            else:
                for start in starts:
                    segments.append(len(combined) + start)
        combined.extend(points)
        previous_last_time = geo.point_time(points[-1])

    if not combined:
        raise ValueError("所选轨迹中没有有效点")
    result = _make_result_track(0, "合并轨迹", combined, segments)
    return [result], _aggregate([result])
