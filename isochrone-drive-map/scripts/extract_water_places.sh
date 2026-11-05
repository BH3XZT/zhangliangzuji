#!/usr/bin/env bash
# 从 OSM PBF 中提取河流/运河（LineString）与城市点（Point），生成轻量 GeoJSON。
#
# 使用 Alpine + osmium-tool + jq，不需要在飞牛宿主机安装 osmium。
# 输出：
#   data/water.geojson  河流/运河线
#   data/places.geojson 城市点（name/name:zh）
#
# 可选环境变量：
#   WATERWAYS=river,canal        水系类型（默认 river+canal；可加 stream 但数据会很大）
#   PLACES=city,town             城市类型（默认 city+town）
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
WATERWAYS="${WATERWAYS:-river,canal}"
PLACES="${PLACES:-city,town}"
IMAGE="${OSMIUM_IMAGE:-python:3.12-slim}"

if ! command -v docker >/dev/null 2>&1; then
  echo "错误：未找到 docker 命令。" >&2
  exit 1
fi

DOCKER="docker"
if ! docker info >/dev/null 2>&1; then
  DOCKER="sudo docker"
  if ! sudo docker info >/dev/null 2>&1; then
    echo "错误：Docker 不可用。" >&2
    exit 1
  fi
fi

if ! ls "$OSM_DIR"/*.osm.pbf >/dev/null 2>&1; then
  echo "错误：$OSM_DIR 下没有 .osm.pbf，请先下载 OSM 数据。" >&2
  exit 1
fi

echo "============================================================"
echo " 提取水系和城市点"
echo " 水系：waterway=$WATERWAYS"
echo " 城市：place=$PLACES"
echo " 输出：$DATA_DIR/water.geojson、places.geojson"
echo "============================================================"

$DOCKER run --rm \
  --memory=4g \
  -v "$DATA_DIR:/data" \
  -v "$ROOT_DIR/scripts:/scripts:ro" \
  -e "WATERWAYS=$WATERWAYS" \
  -e "PLACES=$PLACES" \
  "$IMAGE" bash -euc '
    set -eu
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq >/dev/null
    apt-get install -y -qq --no-install-recommends osmium-tool jq >/dev/null

    cd /data/valhalla
    rm -rf /data/.extract
    mkdir -p /data/.extract
    count=0

    for pbf in *.osm.pbf; do
      [ -f "$pbf" ] || continue
      base="${pbf%.osm.pbf}"
      echo ""
      echo "---- 处理 $pbf ----"

      # 水系：只保留线状 waterway，避免自然水面/关系把文件变大
      osmium tags-filter -o "/data/.extract/${base}-water.osm.pbf" --overwrite \
        "$pbf" "w/waterway=$WATERWAYS"
      osmium export -f geojson -o "/data/.extract/${base}-water.geojson" \
        --geometry-types=linestring --overwrite \
        "/data/.extract/${base}-water.osm.pbf"

      # 城市点：只导出 point，不包含面
      osmium tags-filter -o "/data/.extract/${base}-places.osm.pbf" --overwrite \
        "$pbf" "n/place=$PLACES"
      osmium export -f geojson -o "/data/.extract/${base}-places.geojson" \
        --geometry-types=point --overwrite \
        "/data/.extract/${base}-places.osm.pbf"

      count=$((count + 1))
    done

    if [ "$count" -eq 0 ]; then
      echo "错误：没有找到可处理的 PBF 文件。" >&2
      exit 1
    fi

    jq -s -f /scripts/jq_water.jq /data/.extract/*-water.geojson > /data/water.geojson
    jq -s -f /scripts/jq_places.jq /data/.extract/*-places.geojson > /data/places.geojson
    rm -rf /data/.extract

    echo ""
    echo "水系要素：$(jq ".features | length" /data/water.geojson)"
    echo "城市要素：$(jq ".features | length" /data/places.geojson)"
  '

echo ""
echo "输出文件："
ls -lh "$DATA_DIR"/water.geojson "$DATA_DIR"/places.geojson
echo ""
echo "下一步：sudo docker compose up -d"
