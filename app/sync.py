"""同步中心：扫码上传收件箱 + NAS 文件夹扫描入库。"""

from __future__ import annotations

import os
import re
import secrets
import threading
import time
from pathlib import Path
from urllib.parse import quote

from .parsers import ParseError, parse_file

MAX_FILE_BYTES = 32 * 1024 * 1024
TOKEN_TTL = 30 * 60
_BAD_NAME = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


class SyncError(Exception):
    pass


def _safe_filename(filename: str) -> str:
    name = os.path.basename(str(filename or "").replace("\\", "/")).strip()
    name = _BAD_NAME.sub("_", name).strip(" .")
    return (name or "track.dat")[:160]


def _move_to(src: Path, target_dir: Path) -> Path:
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / src.name
    if target.exists():
        stem = target.stem
        suffix = target.suffix
        counter = 1
        while target.exists():
            target = target_dir / f"{stem}-{counter}{suffix}"
            counter += 1
    os.replace(src, target)
    return target


class SyncManager:
    def __init__(self, data_dir: Path, library):
        self.data_dir = Path(data_dir)
        self.inbox = self.data_dir / "inbox"
        self.processed = self.inbox / "processed"
        self.failed = self.inbox / "failed"
        for path in (self.inbox, self.processed, self.failed):
            path.mkdir(parents=True, exist_ok=True)
        self.library = library
        self.lock = threading.RLock()
        self._tokens: dict[str, float] = {}

    # ---------- token ----------

    def _prune_tokens_locked(self) -> None:
        now = time.time()
        for token in [t for t, exp in self._tokens.items() if exp <= now]:
            self._tokens.pop(token, None)

    def new_token(self, ttl: int = TOKEN_TTL) -> tuple[str, float]:
        token = secrets.token_urlsafe(24)
        expires_at = time.time() + ttl
        with self.lock:
            self._prune_tokens_locked()
            self._tokens[token] = expires_at
        return token, expires_at

    def check_token(self, token: str | None) -> bool:
        if not token:
            return False
        with self.lock:
            self._prune_tokens_locked()
            expires_at = self._tokens.get(token)
            return bool(expires_at and expires_at > time.time())

    @staticmethod
    def mobile_path(token: str) -> str:
        return "/mobile.html?token=" + quote(token)

    # ---------- 收件箱 ----------

    def list_inbox(self) -> list[dict]:
        items = []
        for path in sorted(self.inbox.iterdir()):
            if not path.is_file() or path.name.startswith("."):
                continue
            try:
                stat = path.stat()
                items.append({"name": path.name, "size": stat.st_size, "mtime": stat.st_mtime})
            except OSError:
                continue
        return items

    def status(self) -> dict:
        def count(directory: Path) -> int:
            try:
                return sum(1 for path in directory.iterdir() if path.is_file())
            except OSError:
                return 0

        inbox = self.list_inbox()
        return {
            "inbox": inbox,
            "pending": len(inbox),
            "processed": count(self.processed),
            "failed": count(self.failed),
            "inbox_path": str(self.inbox),
            "mobile_path": "/mobile.html",
        }

    def save_upload(self, filename: str, content: bytes) -> str:
        if not content:
            raise SyncError("上传文件为空")
        if len(content) > MAX_FILE_BYTES:
            raise SyncError(f"文件「{filename}」超过 32MB 限制")
        name = time.strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(3) + "-" + _safe_filename(filename)
        path = self.inbox / name
        path.write_bytes(content)
        return name

    # ---------- 扫描入库 ----------

    def scan(self, only_names: list[str] | None = None) -> dict:
        with self.lock:
            if only_names is None:
                files = [path for path in sorted(self.inbox.iterdir()) if path.is_file() and not path.name.startswith(".")]
            else:
                wanted = set(only_names)
                files = [self.inbox / name for name in only_names if (self.inbox / name).is_file()]
                files = [path for path in files if path.name in wanted]
            imported = 0
            duplicates = 0
            tracks: list[dict] = []
            errors: list[dict] = []
            for path in files:
                try:
                    if path.stat().st_size > MAX_FILE_BYTES:
                        raise ParseError("文件超过 32MB 限制")
                    data = path.read_bytes()
                    parsed = parse_file(data, path.name, "auto")
                except (ParseError, OSError) as exc:
                    message = str(exc) or "解析失败"
                    errors.append({"filename": path.name, "error": message})
                    try:
                        moved = _move_to(path, self.failed)
                        moved.with_name(moved.name + ".error.txt").write_text(message, encoding="utf-8")
                    except OSError:
                        pass
                    continue
                file_imported = False
                for track in parsed.tracks:
                    try:
                        summary, is_duplicate = self.library.add_track(
                            track["name"],
                            track["points"],
                            track.get("segments"),
                            {
                                "format": parsed.format,
                                "format_label": parsed.format_label,
                                "source_crs": parsed.source_crs,
                                "filename": path.name,
                            },
                        )
                    except Exception as exc:  # noqa: BLE001
                        errors.append({"filename": path.name, "error": f"入库失败：{exc}"})
                        continue
                    file_imported = True
                    if is_duplicate:
                        duplicates += 1
                    else:
                        imported += 1
                    tracks.append(summary)
                if file_imported:
                    try:
                        _move_to(path, self.processed)
                    except OSError:
                        pass
            return {
                "files": len(files),
                "imported": imported,
                "duplicates": duplicates,
                "tracks": tracks,
                "errors": errors,
            }

    def upload_and_scan(self, files: list[dict], auto_import: bool = True) -> dict:
        saved = []
        for item in files:
            saved.append(self.save_upload(item.get("filename") or "track.dat", item.get("content") or b""))
        result = {"saved": saved, "imported": 0, "duplicates": 0, "tracks": [], "errors": []}
        if auto_import and saved:
            scan_result = self.scan(only_names=saved)
            result.update(
                {
                    "imported": scan_result["imported"],
                    "duplicates": scan_result["duplicates"],
                    "tracks": scan_result["tracks"],
                    "errors": scan_result["errors"],
                }
            )
        return result
