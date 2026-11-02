#!/usr/bin/env bash
#
# 地图轨迹合并工具 —— 停止服务（macOS / Linux）
#
# 首次使用若提示 Permission denied，请先执行：chmod +x start.sh stop.sh
# 用法：./stop.sh
#
set -euo pipefail

cd "$(dirname "$0")"

info() { printf '%s\n' "$*"; }
fail() { printf '\n[错误] %s\n' "$*" >&2; exit 1; }

info "============================================"
info "  地图轨迹合并工具 - 停止服务"
info "============================================"
info ""

command -v docker >/dev/null 2>&1 || fail "未找到 docker 命令。请确认已安装 Docker Desktop 或 Docker Engine。"
docker info >/dev/null 2>&1 || fail "Docker 已安装但引擎未运行。macOS 请打开 Docker Desktop；Linux 请执行 sudo systemctl start docker 后重试。"

info "正在停止并移除容器..."
docker compose down || fail "docker compose down 执行失败。请查看容器状态：docker compose ps"

info ""
info "已停止。你的数据仍保留在 ./data 目录，下次启动会自动挂载。"
