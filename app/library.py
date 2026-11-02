"""持久化轨迹库：把导入/同步的轨迹保存到 data/library/。

存储结构：
data/library/index.json           # 索引与元数据（原子写入）
data/library/tracks/<id>.json.gz  # 轨迹点（gzip JSON）
"""

from __future__ import annotations

import gzip
import hashlib
import json
import os
import re
import threading
import time
import uuid
from pathlib import Path

from . import geo

COLORS = [
    "#0ea5e9", "#f59e0b", "#22c55e", "#ef4444", "#8b5cf6",
    "#14b8a6", "#ec4899", "#84cc16", "#f97316", "#06b6d4",
    "#6366f1", "#eab308",
]

MAX_POINTS_PER_TRACK = 500_000
_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")

SUMMARY_FIELDS = (
    "id", "name", "color", "source_format", "source_label", "source_crs", "filename",
    "point_count", "distance_m", "duration_s", "time_start", "time_end", "created_at",
    "bbox", "hash",
)


class LibraryError(Exception):
    pass


class Library:
    def __init__(self, data_dir: Path):
        self.data_dir = Path(data_dir)
        self.root = self.data_dir / "library"
        self.tracks_dir = self.root / "tracks"
        self.index_path = self.root / "index.json"
        self.lock = threading.RLock()
        self.tracks_dir.mkdir(parents=True, exist_ok=True)
        self._index = self._load_index()

    # ---------- 索引 ----------

    def _load_index(self) -> dict:
        if self.index_path.is_file():
            try:
                with open(self.index_path, "r", encoding="utf-8") as fh:
                    data = json.load(fh)
                if isinstance(data, dict) and isinstance(data.get("tracks"), list):
                    data.setdefault("updated_at", 0.0)
                    return data
            except (OSError, ValueError):
                pass
        return {"version": 1, "updated_at": 0.0, "tracks": []}

    def _save_index_locked(self) -> None:
        tmp = self.index_path.with_suffix(".json.tmp")
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(self._index, fh, ensure_ascii=False, separators=(",", ":"))
        os.replace(tmp, self.index_path)

    # ---------- 轨迹文件 ----------

    def _track_path(self, track_id: str) -> Path:
        return self.tracks_dir / f"{track_id}.json.gz"

    def _write_track_file(self, track_id: str, points: list, segments: list) -> None:
        payload = {"id": track_id, "points": points, "segments": segments}
        path = self._track_path(track_id)
        tmp = path.with_suffix(".json.gz.tmp")
        with gzip.open(tmp, "wt", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, separators=(",", ":"))
        os.replace(tmp, path)

    def _read_track_file(self, track_id: str) -> dict:
        path = self._track_path(track_id)
        if not path.is_file():
            raise LibraryError("轨迹不存在或已被删除")
        with gzip.open(path, "rt", encoding="utf-8") as fh:
            return json.load(fh)

    # ---------- 工具 ----------

    @staticmethod
    def _hash_points(points: list) -> str:
        digest = hashlib.sha256()
        for point in points:
            lng = float(point[0]) if point[0] is not None else 0.0
            lat = float(point[1]) if point[1] is not None else 0.0
            ele = float(point[2]) if len(point) > 2 and point[2] is not None else 0.0
            speed = float(point[3]) if len(point) > 3 and point[3] is not None else 0.0
            ts = float(point[4]) if len(point) > 4 and point[4] is not None else 0.0
            digest.update(f"{lng:.7f},{lat:.7f},{ele:.2f},{speed:.3f},{ts:.3f};".encode())
        return digest.hexdigest()

    def _summaries(self) -> list[dict]:
        return self._index.get("tracks", [])

    def _find_by_hash(self, content_hash: str):
        for summary in self._summaries():
            if summary.get("hash") == content_hash:
                return summary
        return None

    # ---------- 对外接口 ----------

    @property
    def updated_at(self) -> float:
        return float(self._index.get("updated_at") or 0.0)

    def list_tracks(self) -> list[dict]:
        with self.lock:
            items = [dict(item) for item in self._summaries()]
        items.sort(key=lambda item: item.get("created_at") or 0, reverse=True)
        return items

    def get_track(self, track_id: str) -> dict:
        with self.lock:
            summary = next((item for item in self._summaries() if item.get("id") == track_id), None)
            if summary is None:
                raise LibraryError("轨迹不存在或已被删除")
            payload = self._read_track_file(track_id)
        result = dict(summary)
        result["points"] = payload.get("points") or []
        result["segments"] = payload.get("segments") or [0]
        return result

    def add_track(self, name: str, points: list, segments: list | None = None, meta: dict | None = None) -> tuple[dict, bool]:
        """返回 (summary, is_duplicate)。"""
        points = geo.sanitize_points(points or [])
        if not points:
            raise LibraryError("轨迹没有有效点")
        if len(points) > MAX_POINTS_PER_TRACK:
            raise LibraryError(f"单条轨迹点过多（上限 {MAX_POINTS_PER_TRACK}）")
        segments = segments or [0]
        segments = sorted({int(s) for s in segments if isinstance(s, (int, float)) and 0 <= int(s) < len(points)})
        if not segments or segments[0] != 0:
            segments.insert(0, 0)
        content_hash = self._hash_points(points)
        with self.lock:
            existing = self._find_by_hash(content_hash)
            if existing is not None:
                return dict(existing), True
            track_id = uuid.uuid4().hex[:8]
            while self._track_path(track_id).exists():
                track_id = uuid.uuid4().hex[:8]
            stats = geo.compute_stats(points, segments)
            meta = meta or {}
            created_at = time.time()
            color = COLORS[len(self._summaries()) % len(COLORS)]
            summary = {
                "id": track_id,
                "name": str(name or "未命名轨迹").strip()[:120] or "未命名轨迹",
                "color": color,
                "source_format": str(meta.get("format") or "")[:32],
                "source_label": str(meta.get("format_label") or "")[:64],
                "source_crs": str(meta.get("source_crs") or "WGS84")[:16],
                "filename": str(meta.get("filename") or "")[:200],
                "point_count": stats["point_count"],
                "distance_m": stats["distance_m"],
                "duration_s": stats["duration_s"],
                "time_start": stats["time_start"],
                "time_end": stats["time_end"],
                "created_at": created_at,
                "bbox": geo.bbox(points),
                "hash": content_hash,
            }
            self._write_track_file(track_id, points, segments)
            self._index.setdefault("tracks", []).append(summary)
            self._index["updated_at"] = created_at
            self._save_index_locked()
            return dict(summary), False

    def update_track(self, track_id: str, name: str | None = None, color: str | None = None) -> dict:
        with self.lock:
            summary = next((item for item in self._summaries() if item.get("id") == track_id), None)
            if summary is None:
                raise LibraryError("轨迹不存在或已被删除")
            if name is not None:
                name = str(name).strip()[:120]
                if name:
                    summary["name"] = name
            if color is not None:
                if not _COLOR_RE.match(str(color)):
                    raise LibraryError("颜色格式应为 #RRGGBB")
                summary["color"] = str(color)
            self._index["updated_at"] = time.time()
            self._save_index_locked()
            return dict(summary)

    def delete_track(self, track_id: str) -> None:
        with self.lock:
            before = len(self._summaries())
            self._index["tracks"] = [item for item in self._summaries() if item.get("id") != track_id]
            if len(self._index["tracks"]) == before:
                raise LibraryError("轨迹不存在或已被删除")
            try:
                self._track_path(track_id).unlink(missing_ok=True)
            except OSError:
                pass
            self._index["updated_at"] = time.time()
            self._save_index_locked()

    def clear(self) -> int:
        with self.lock:
            count = len(self._summaries())
            for path in self.tracks_dir.glob("*.json.gz"):
                try:
                    path.unlink()
                except OSError:
                    pass
            self._index = {"version": 1, "updated_at": time.time(), "tracks": []}
            self._save_index_locked()
            return count

    def stats(self) -> dict:
        with self.lock:
            items = [dict(item) for item in self._summaries()]
        distance = 0.0
        points = 0
        sources = set()
        time_start = None
        time_end = None
        boxes = []
        for item in items:
            points += int(item.get("point_count") or 0)
            distance += float(item.get("distance_m") or 0)
            if item.get("source_format"):
                sources.add(item["source_format"])
            if item.get("time_start") is not None:
                time_start = item["time_start"] if time_start is None else min(time_start, item["time_start"])
            if item.get("time_end") is not None:
                time_end = item["time_end"] if time_end is None else max(time_end, item["time_end"])
            if item.get("bbox"):
                boxes.append(item["bbox"])
        bbox = None
        if boxes:
            bbox = [
                min(b[0] for b in boxes), min(b[1] for b in boxes),
                max(b[2] for b in boxes), max(b[3] for b in boxes),
            ]
        return {
            "track_count": len(items),
            "point_count": points,
            "distance_m": round(distance, 2),
            "source_count": len(sources),
            "time_start": time_start,
            "time_end": time_end,
            "bbox": bbox,
        }

    def iter_tracks(self):
        """逐个 yield 完整轨迹（含 points），供里程碑计算。"""
        with self.lock:
            summaries = [dict(item) for item in self._summaries()]
        for summary in summaries:
            try:
                payload = self._read_track_file(summary["id"])
            except (OSError, ValueError):
                continue
            yield {
                "id": summary["id"],
                "name": summary.get("name"),
                "points": payload.get("points") or [],
                "segments": payload.get("segments") or [0],
            }
