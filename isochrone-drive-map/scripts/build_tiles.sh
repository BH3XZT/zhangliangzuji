#!/usr/bin/env bash
# 使用 Valhalla 官方 scripted 镜像构建路由 tiles。
#
# 首次构建会消耗较多 CPU/内存，约 5-15 分钟；请确保 Docker 可用，
# 并且 data/valhalla 已通过 scripts/download_osm.sh 下载了 PBF。
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -f "$ROOT_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT_DIR/.env"
  set +a
fi
DATA_DIR="${DATA_DIR:-$ROOT_DIR/data}"
OSM_DIR="$DATA_DIR/valhalla"
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

if ! ls "$OSM_DIR"/*.osm.pbf >/dev/null 2>&1; then
  echo "错误：$OSM_DIR 下没有 .osm.pbf 文件。" >&2
  echo "请先运行：bash scripts/download_osm.sh" >&2
  exit 1
fi

echo "============================================================"
echo " 构建 Valhalla 路由 tiles"
echo " 镜像：$IMAGE"
echo " PBF： $(ls "$OSM_DIR"/*.osm.pbf | wc -l) 个"
echo " 内存限制：$MEMORY；线程：$THREADS"
echo " 首次构建约 5-15 分钟，请耐心等待（不要关闭终端）。"
echo "============================================================"

$DOCKER run --rm \
  --name isochrone-valhalla-build \
  --memory="$MEMORY" \
  -v "$OSM_DIR:/custom_files" \
  -e "serve_tiles=False" \
  -e "force_rebuild=True" \
  -e "use_tiles_ignore_pbf=False" \
  -e "build_tar=True" \
  -e "build_admins=True" \
  -e "build_time_zones=$BUILD_TIMEZONES" \
  -e "server_threads=$THREADS" \
  "$IMAGE"

if [ ! -f "$OSM_DIR/valhalla_tiles.tar" ]; then
  echo "错误：构建结束但没有找到 $OSM_DIR/valhalla_tiles.tar。" >&2
  echo "请查看上方 Valhalla 日志；如果是 OOM，请减少 REGIONS 或调低 VALHALLA_THREADS。" >&2
  exit 1
fi

# Valhalla 默认 isochrone max_time/max_time_contour 只有 120 分钟，
# 这里自动放宽到 300 分钟，确保 180/240 分钟等时圈可计算。
echo ""
echo "=== 调整等时圈时间上限为 300 分钟 ==="
$DOCKER run --rm -i \
  -v "$OSM_DIR:/data" \
  python:3.12-slim python - <<'PY'
import json

path = "/data/valhalla.json"
with open(path, encoding="utf-8") as fh:
    data = json.load(fh)
limits = data.setdefault("service_limits", {}).setdefault("isochrone", {})
limits["max_time"] = 300
limits["max_time_contour"] = 300
limits["max_contours"] = 4
with open(path, "w", encoding="utf-8") as fh:
    json.dump(data, fh, ensure_ascii=False, indent=2)
print("isochrone limits:", limits)
PY

echo ""
echo "构建完成："
ls -lh "$OSM_DIR"/valhalla_tiles.tar "$OSM_DIR"/valhalla.json 2>/dev/null || true
echo ""
echo "下一步：sudo bash scripts/extract_water_places.sh"
