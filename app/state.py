"""进程级单例（惰性初始化），便于测试与部署时替换数据目录。"""

from __future__ import annotations

import threading

from .library import Library
from .milestones import MilestoneService
from .paths import DATA_DIR, GEO_DIR
from .sync import SyncManager

_lock = threading.RLock()
_library: Library | None = None
_sync: SyncManager | None = None
_milestones: MilestoneService | None = None


def get_library() -> Library:
    global _library
    with _lock:
        if _library is None:
            _library = Library(DATA_DIR)
        return _library


def get_sync() -> SyncManager:
    global _sync
    with _lock:
        if _sync is None:
            _sync = SyncManager(DATA_DIR, get_library())
        return _sync


def get_milestones() -> MilestoneService:
    global _milestones
    with _lock:
        if _milestones is None:
            _milestones = MilestoneService(GEO_DIR, get_library())
        return _milestones
