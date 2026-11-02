"""运行路径配置。"""

from __future__ import annotations

import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("MAPTRACK_DATA_DIR") or (BASE_DIR / "data"))
GEO_DIR = Path(os.environ.get("MAPTRACK_GEO_DIR") or (BASE_DIR / "geo"))
WEB_DIR = BASE_DIR / "web"
SAMPLES_DIR = BASE_DIR / "samples"
