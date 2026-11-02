"""内部数据模型。"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class RawTrack:
    """解析器输出的原始轨迹（坐标仍为文件原始坐标系）。"""

    name: str
    points: list  # [[lng, lat, ele, speed, time], ...]
    segments: list[int] = field(default_factory=lambda: [0])
    warnings: list[str] = field(default_factory=list)


@dataclass
class ParserOutput:
    """单个文件解析结果（坐标仍为文件原始坐标系）。"""

    tracks: list[RawTrack]
    crs: str  # 该格式默认坐标系
    format: str
    format_label: str
    warnings: list[str] = field(default_factory=list)


@dataclass
class ParsedFile:
    """最终解析结果：坐标已统一为 WGS-84。"""

    tracks: list[dict]  # [{"name":..., "points":[...], "segments":[...]}]
    source_crs: str
    crs_detected: str
    format: str
    format_label: str
    warnings: list[str] = field(default_factory=list)
    crs_auto: bool = True
