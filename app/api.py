"""业务接口实现：解析、合并、导出、元信息。"""

from __future__ import annotations

import os
import time
import uuid
from urllib.parse import quote

from . import exporters, geo, isochrone, merge
from .crs import CRS_IDS, CRS_LABELS, normalize_crs
from .geo_admin import AdminGeoError
from .library import LibraryError
from .parsers import FORMAT_LIST, ParseError, parse_file
from .parsers.common import iso_utc
from .state import get_library, get_milestones, get_sync

VERSION = "1.6.0"
MAX_FILES = 30
MAX_TOTAL_POINTS = 2_000_000


class ApiError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status
        self.message = message


def health_payload() -> dict:
    return {
        "ok": True,
        "name": "MapTrackMerger",
        "version": VERSION,
        "time": int(time.time()),
    }


def formats_payload() -> dict:
    return {
        "ok": True,
        "crs": [{"id": crs, "label": CRS_LABELS[crs]} for crs in CRS_IDS],
        "formats": FORMAT_LIST,
        "export_formats": exporters.EXPORT_FORMATS,
        "max_file_mb": 32,
        "max_request_mb": 64,
    }


def _round_point(point: list) -> list:
    return [
        round(float(point[0]), 7),
        round(float(point[1]), 7),
        round(float(point[2]), 2) if point[2] is not None else None,
        round(float(point[3]), 3) if point[3] is not None else None,
        round(float(point[4]), 3) if point[4] is not None else None,
    ]


def _track_payload(track: dict, filename: str, parsed) -> dict:
    points = track["points"]
    segments = track.get("segments") or [0]
    stats = geo.compute_stats(points, segments)
    warnings = list(parsed.warnings) + list(track.get("warnings") or [])
    return {
        "id": uuid.uuid4().hex[:8],
        "name": track["name"],
        "filename": filename,
        "format": parsed.format,
        "format_label": parsed.format_label,
        "source_crs": parsed.source_crs,
        "crs_detected": parsed.crs_detected,
        "crs_auto": parsed.crs_auto,
        "point_count": stats["point_count"],
        "time_start": stats["time_start"],
        "time_end": stats["time_end"],
        "distance_m": stats["distance_m"],
        "duration_s": stats["duration_s"],
        "bbox": geo.bbox(points),
        "points": [_round_point(point) for point in points],
        "warnings": warnings,
    }


def parse_upload(files: list[dict], crs_override: str = "auto") -> dict:
    if not files:
        raise ApiError("请选择要导入的轨迹文件")
    if len(files) > MAX_FILES:
        raise ApiError(f"一次最多上传 {MAX_FILES} 个文件")
    override = (crs_override or "auto").strip()
    if override.lower() not in ("", "auto"):
        if override.upper() not in CRS_IDS and normalize_crs(override, default="") == "":
            raise ApiError(f"坐标系参数无效：{override}")

    tracks: list[dict] = []
    errors: list[dict] = []
    total_points = 0
    for item in files:
        filename = item.get("filename") or "轨迹文件"
        try:
            parsed = parse_file(item.get("content") or b"", filename, override)
        except ParseError as exc:
            errors.append({"filename": filename, "error": str(exc)})
            continue
        except Exception as exc:  # noqa: BLE001
            errors.append({"filename": filename, "error": f"解析失败：{exc}"})
            continue
        for track in parsed.tracks:
            total_points += len(track["points"])
            if total_points > MAX_TOTAL_POINTS:
                raise ApiError("轨迹点总数过多，请分批导入或先抽稀")
            tracks.append(_track_payload(track, filename, parsed))

    return {"ok": True, "tracks": tracks, "errors": errors}


def merge_payload(payload: dict) -> dict:
    if not isinstance(payload, dict):
        raise ApiError("请求体必须是 JSON 对象")
    tracks = payload.get("tracks")
    if not isinstance(tracks, list) or not tracks:
        raise ApiError("请先选择要合并的轨迹")
    if len(tracks) > 100:
        raise ApiError("单次最多合并 100 条轨迹")
    normalized = []
    total_points = 0
    for index, track in enumerate(tracks):
        if not isinstance(track, dict):
            continue
        points = track.get("points")
        if not isinstance(points, list) or len(points) < 1:
            continue
        total_points += len(points)
        if total_points > MAX_TOTAL_POINTS:
            raise ApiError("轨迹点总数过多，请先抽稀后再合并")
        normalized.append(
            {
                "name": str(track.get("name") or f"轨迹{index + 1}"),
                "points": points,
            }
        )
    if not normalized:
        raise ApiError("所选轨迹没有有效点")
    try:
        merged, stats = merge.merge_tracks(normalized, payload.get("options") or {})
    except ValueError as exc:
        raise ApiError(str(exc)) from exc
    for index, track in enumerate(merged):
        track["stats"]["time_start_iso"] = iso_utc(track["stats"]["time_start"])
        track["stats"]["time_end_iso"] = iso_utc(track["stats"]["time_end"])
        track["id"] = f"m{index + 1}"
    stats["time_start_iso"] = iso_utc(stats["time_start"])
    stats["time_end_iso"] = iso_utc(stats["time_end"])
    return {"ok": True, "tracks": merged, "stats": stats}


def export_payload(payload: dict) -> dict:
    if not isinstance(payload, dict):
        raise ApiError("请求体必须是 JSON 对象")
    fmt = str(payload.get("format") or "gpx").strip().lower()
    if fmt not in exporters.MIME_TYPES:
        raise ApiError(f"不支持的导出格式：{fmt}")
    crs = normalize_crs(payload.get("crs") or "WGS84", default="WGS84")
    tracks = payload.get("tracks")
    if not isinstance(tracks, list) or not tracks:
        raise ApiError("没有可导出的轨迹")
    total_points = 0
    for track in tracks:
        if isinstance(track, dict) and isinstance(track.get("points"), list):
            total_points += len(track["points"])
    if total_points > MAX_TOTAL_POINTS:
        raise ApiError("轨迹点总数过多，无法导出")
    filename = str(payload.get("filename") or "轨迹合并").strip() or "轨迹合并"
    try:
        data, mime, download_name = exporters.export_tracks(fmt, crs, tracks, filename)
    except ValueError as exc:
        raise ApiError(str(exc)) from exc
    return {"data": data, "mime": mime, "filename": download_name}


_SAMPLE_EXT = {
    ".gpx": ("gpx", "GPX", "WGS84"),
    ".kml": ("kml", "KML/KMZ", "WGS84"),
    ".kmz": ("kml", "KML/KMZ", "WGS84"),
    ".tcx": ("tcx", "TCX", "WGS84"),
    ".geojson": ("geojson", "GeoJSON", "WGS84"),
    ".csv": ("csv", "CSV/TSV", "WGS84"),
    ".tsv": ("csv", "CSV/TSV", "WGS84"),
    ".nmea": ("nmea", "NMEA", "WGS84"),
    ".log": ("nmea", "NMEA", "WGS84"),
    ".fit": ("fit", "FIT", "WGS84"),
    ".json": ("json", "通用 JSON", "WGS84"),
}


def samples_payload(samples_dir) -> dict:
    files = []
    directory = str(samples_dir)
    if os.path.isdir(directory):
        for name in sorted(os.listdir(directory)):
            path = os.path.join(directory, name)
            if not os.path.isfile(path) or name.startswith("."):
                continue
            ext = os.path.splitext(name)[1].lower()
            if ext not in _SAMPLE_EXT:
                continue
            fmt, label, crs = _SAMPLE_EXT[ext]
            if ext == ".json":
                if any(token in name for token in ("百度", "baidu")):
                    fmt, label, crs = "baidu", "百度地图 JSON", "BD09"
                elif any(token in name for token in ("高德", "amap", "gaode")):
                    fmt, label, crs = "amap", "高德地图 JSON", "GCJ02"
                elif any(token in name.lower() for token in ("google", "时间线")):
                    fmt, label, crs = "google", "Google 时间线", "WGS84"
            try:
                size = os.path.getsize(path)
            except OSError:
                size = 0
            files.append(
                {
                    "name": name,
                    "url": "/samples/" + quote(name),
                    "format": fmt,
                    "format_label": label,
                    "crs": crs,
                    "size": size,
                }
            )
    return {"ok": True, "files": files}


# ----------------------------------------------------------------------
# v2：轨迹库 / 同步中心 / 里程碑
# ----------------------------------------------------------------------


def library_payload() -> dict:
    library = get_library()
    return {
        "ok": True,
        "updated_at": library.updated_at,
        "tracks": library.list_tracks(),
        "stats": library.stats(),
    }


def library_track_payload(track_id: str) -> dict:
    try:
        track = get_library().get_track(track_id)
    except LibraryError as exc:
        raise ApiError(str(exc), 404) from exc
    return {"ok": True, "track": track}


def library_add_payload(payload: dict) -> dict:
    if not isinstance(payload, dict):
        raise ApiError("请求体必须是 JSON 对象")
    tracks = payload.get("tracks")
    if not isinstance(tracks, list) or not tracks:
        raise ApiError("没有要保存的轨迹")
    if len(tracks) > 200:
        raise ApiError("一次最多保存 200 条轨迹")
    library = get_library()
    added = []
    duplicates = []
    errors = []
    total_points = 0
    for index, item in enumerate(tracks):
        if not isinstance(item, dict):
            errors.append({"name": f"第 {index + 1} 条", "error": "数据格式错误"})
            continue
        name = str(item.get("name") or f"轨迹{index + 1}")
        points = item.get("points")
        if not isinstance(points, list) or not points:
            errors.append({"name": name, "error": "轨迹没有有效点"})
            continue
        total_points += len(points)
        if total_points > MAX_TOTAL_POINTS:
            raise ApiError("轨迹点总数过多，无法保存")
        source = item.get("source") if isinstance(item.get("source"), dict) else {}
        try:
            summary, is_duplicate = library.add_track(
                name,
                points,
                item.get("segments"),
                {
                    "format": source.get("format"),
                    "format_label": source.get("format_label"),
                    "source_crs": source.get("source_crs"),
                    "filename": source.get("filename"),
                },
            )
        except LibraryError as exc:
            errors.append({"name": name, "error": str(exc)})
            continue
        (duplicates if is_duplicate else added).append(summary)
    return {
        "ok": True,
        "added": added,
        "duplicates": duplicates,
        "errors": errors,
        "stats": library.stats(),
    }


def library_update_payload(track_id: str, payload: dict) -> dict:
    if not isinstance(payload, dict):
        raise ApiError("请求体必须是 JSON 对象")
    try:
        summary = get_library().update_track(track_id, payload.get("name"), payload.get("color"))
    except LibraryError as exc:
        raise ApiError(str(exc), 400) from exc
    return {"ok": True, "track": summary}


def library_delete_payload(track_id: str) -> dict:
    try:
        get_library().delete_track(track_id)
    except LibraryError as exc:
        raise ApiError(str(exc), 404) from exc
    return {"ok": True}


def library_clear_payload() -> dict:
    count = get_library().clear()
    return {"ok": True, "deleted": count}


def sync_status_payload() -> dict:
    result = {"ok": True}
    result.update(get_sync().status())
    return result


def sync_token_payload() -> dict:
    sync = get_sync()
    token, expires_at = sync.new_token()
    return {
        "ok": True,
        "token": token,
        "expires_at": expires_at,
        "ttl": max(0, int(expires_at - time.time())),
        "mobile_path": sync.mobile_path(token),
    }


def sync_scan_payload() -> dict:
    sync = get_sync()
    result = sync.scan()
    result["ok"] = True
    result["inbox"] = sync.list_inbox()
    result["pending"] = len(result["inbox"])
    result["stats"] = get_library().stats()
    return result


def sync_upload_payload(files: list[dict], token: str, auto_import: bool = True) -> dict:
    sync = get_sync()
    if not sync.check_token(token):
        raise ApiError("二维码已过期或无效，请在电脑上刷新二维码后重试", 403)
    if not files:
        raise ApiError("没有收到上传文件")
    result = sync.upload_and_scan(files, auto_import)
    result["ok"] = True
    result["inbox"] = sync.list_inbox()
    result["pending"] = len(result["inbox"])
    result["stats"] = get_library().stats()
    return result


def milestones_payload() -> dict:
    try:
        return get_milestones().payload()
    except AdminGeoError as exc:
        raise ApiError(str(exc), 503) from exc


def milestones_geojson_payload(crs_name: str = "GCJ02") -> dict:
    try:
        return get_milestones().geojson(crs_name)
    except AdminGeoError as exc:
        raise ApiError(str(exc), 503) from exc


# ----------------------------------------------------------------------
# v1.3：城市自驾等时圈
# ----------------------------------------------------------------------


def isochrone_status_payload() -> dict:
    return isochrone.status_payload()


def isochrone_config_payload() -> dict:
    return isochrone.config_payload()


def isochrone_payload(payload: dict) -> dict:
    try:
        return isochrone.isochrone_payload(payload)
    except isochrone.IsochroneError as exc:
        raise ApiError(exc.message, exc.status) from exc
