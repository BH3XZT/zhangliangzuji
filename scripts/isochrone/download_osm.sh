#!/usr/bin/env bash
# 下载太原周边 300km 范围的 OSM 数据（默认山西/河北/河南/陕西 4 省，约 276MB）
#
# 用法：
#   bash scripts/isochrone/download_osm.sh
#   REGIONS="shanxi hebei henan shaanxi inner-mongolia" bash scripts/isochrone/download_osm.sh
#
# 说明：Geofabrik 不提供“按半径裁剪”的接口，这里用省级小范围 PBF，避免全国数据。
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [ -f "$ROOT_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT_DIR/.env"
  set +a
fi
DATA_DIR="${DATA_DIR:-$ROOT_DIR/data/isochrone}"
OSM_DIR="$DATA_DIR/valhalla"
REGIONS="${REGIONS:-shanxi hebei henan shaanxi}"
GEOFABRIK_BASE="${GEOFABRIK_BASE:-https://download.geofabrik.de/asia/china}"

mkdir -p "$OSM_DIR"

if ! command -v wget >/dev/null 2>&1; then
  echo "错误：未找到 wget，请先在飞牛 NAS 上安装 wget（fnOS 通常自带）。" >&2
  exit 1
fi

echo "============================================================"
echo " 下载 OSM 数据（区域：$REGIONS）"
echo " 保存目录：$OSM_DIR"
echo " 说明：首次下载约 276MB（4 省），请耐心等待。"
echo "============================================================"

for region in $REGIONS; do
  url="$GEOFABRIK_BASE/$region-latest.osm.pbf"
  target="$OSM_DIR/$region-latest.osm.pbf"
  if [ -s "$target" ]; then
    echo "[跳过] $region 已存在：$(du -h "$target" | cut -f1)"
    continue
  fi
  echo ""
  echo "[下载] $region -> $target"
  echo "       $url"
  if ! wget -c --progress=dot:giga -O "$target" "$url"; then
    echo "错误：下载 $region 失败，请检查网络或稍后重试。" >&2
    rm -f "$target"
    exit 1
  fi
  if [ ! -s "$target" ]; then
    echo "错误：$region 下载后文件为空。" >&2
    exit 1
  fi
done

echo ""
echo "下载完成："
du -sh "$OSM_DIR"/*.osm.pbf 2>/dev/null || true
echo ""
echo "下一步：sudo bash scripts/isochrone/build_tiles.sh"
