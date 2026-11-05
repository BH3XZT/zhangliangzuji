#!/usr/bin/env bash
# 使用 Valhalla 官方 scripted 镜像构建路由 tiles。
#
# 首次构建会消耗较多 CPU/内存，约 5-15 分钟；请确保 Docker 可用，
# 并且 data/isochrone/osm 已通过 scripts/isochrone/download_osm.sh 下载了 PBF。
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [ -f "$ROOT_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT_DIR/.env"
  set +a
fi
DATA_DIR="${DATA_DIR:-$ROOT_DIR/data/isochrone}"
SOURCE_DIR="$DATA_DIR/osm"
VALHALLA_DIR="$DATA_DIR/valhalla"
IMAGE="${VALHALLA_IMAGE:-ghcr.io/valhalla/valhalla-scripted:latest}"
THREADS="${VALHALLA_THREADS:-2}"
MEMORY="${VALHALLA_BUILD_MEMORY:-4g}"
# 时区库需要从 GitHub 下载 shapefile；国内 NAS 可能无法访问 GitHub，
# 等时圈不依赖时区，默认关闭。需要时在 .env 中设为 True。
BUILD_TIMEZONES="${VALHALLA_BUILD_TIMEZONES:-False}"

if ! command -v docker >/dev/null 2>&1; then
  echo "错误：未找到 docker 命令，请先在飞牛 NAS 应用中心安装 Docker。" >&2
  exit 1
fi

DOCKER="docker"
if ! docker info >/dev/null 2>&1; then
  echo "当前用户没有直接访问 Docker 的权限，尝试使用 sudo。"
  DOCKER="sudo docker"
  if ! sudo docker info >/dev/null 2>&1; then
    echo "错误：sudo docker 也不可用，请检查 Docker 服务是否启动。" >&2
    exit 1
  fi
fi

mkdir -p "$SOURCE_DIR" "$VALHALLA_DIR"

# 兼容旧版本：PBF 曾下载在 valhalla/ 下，自动迁移到 osm/
if ! ls "$SOURCE_DIR"/*.osm.pbf >/dev/null 2>&1 && ls "$VALHALLA_DIR"/*.osm.pbf >/dev/null 2>&1; then
  echo "检测到旧版 PBF 位于 valhalla/，迁移到 osm/ ..."
  mv "$VALHALLA_DIR"/*.osm.pbf "$SOURCE_DIR"/
fi

if ! ls "$SOURCE_DIR"/*.osm.pbf >/dev/null 2>&1; then
  echo "错误：$SOURCE_DIR 下没有 .osm.pbf 文件。" >&2
  echo "请先运行：bash scripts/isochrone/download_osm.sh" >&2
  exit 1
fi

echo "============================================================"
echo " 合并省级 PBF（避免多 extract 在河北等边界产生接缝异常）"
echo " 源目录：$SOURCE_DIR"
echo " 输出：  $VALHALLA_DIR/region.osm.pbf"
echo "============================================================"
rm -f "$VALHALLA_DIR"/*.osm.pbf
$DOCKER run --rm \
  --memory="$MEMORY" \
  -v "$SOURCE_DIR:/src:ro" \
  -v "$VALHALLA_DIR:/out" \
  python:3.12-slim bash -euc '
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq >/dev/null
    apt-get install -y -qq --no-install-recommends osmium-tool >/dev/null
    osmium merge /src/*.osm.pbf -o /out/region.osm.pbf --overwrite
    ls -lh /out/region.osm.pbf
  '

echo "============================================================"
echo " 构建 Valhalla 路由 tiles（单文件 region.osm.pbf）"
echo " 镜像：$IMAGE"
echo " 内存限制：$MEMORY；线程：$THREADS"
echo " 首次构建约 5-15 分钟，请耐心等待（不要关闭终端）。"
echo "============================================================"

$DOCKER run --rm \
  --name isochrone-valhalla-build \
  --memory="$MEMORY" \
  -v "$VALHALLA_DIR:/custom_files" \
  -e "serve_tiles=False" \
  -e "force_rebuild=True" \
  -e "use_tiles_ignore_pbf=False" \
  -e "build_tar=True" \
  -e "build_admins=True" \
  -e "build_time_zones=$BUILD_TIMEZONES" \
  -e "server_threads=$THREADS" \
  "$IMAGE"

if [ ! -f "$VALHALLA_DIR/valhalla_tiles.tar" ]; then
  echo "错误：构建结束但没有找到 $VALHALLA_DIR/valhalla_tiles.tar。" >&2
  echo "请查看上方 Valhalla 日志；如果是 OOM，请减少 REGIONS 或调低 VALHALLA_THREADS。" >&2
  exit 1
fi

# Valhalla 默认 isochrone max_time/max_time_contour 只有 120 分钟，
# 这里自动放宽到 660 分钟、12 个轮廓，确保 1~10 小时等时圈可计算。
echo ""
echo "=== 调整等时圈时间上限为 660 分钟 / 12 个轮廓 ==="
$DOCKER run --rm -i \
  -v "$VALHALLA_DIR:/data" \
  python:3.12-slim python - <<'PY'
import json

path = "/data/valhalla.json"
with open(path, encoding="utf-8") as fh:
    data = json.load(fh)
limits = data.setdefault("service_limits", {}).setdefault("isochrone", {})
limits["max_time"] = 660
limits["max_time_contour"] = 660
limits["max_contours"] = 12
with open(path, "w", encoding="utf-8") as fh:
    json.dump(data, fh, ensure_ascii=False, indent=2)
print("isochrone limits:", limits)
PY

echo ""
echo "构建完成："
ls -lh "$VALHALLA_DIR"/valhalla_tiles.tar "$VALHALLA_DIR"/valhalla.json 2>/dev/null || true
echo ""
echo "下一步：sudo bash scripts/isochrone/extract_water_places.sh"
