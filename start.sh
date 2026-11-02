#!/usr/bin/env bash
#
# 地图轨迹合并工具 —— 一键启动（macOS / Linux）
#
# 首次使用若提示 Permission denied，请先执行：
#     chmod +x start.sh stop.sh
#
# 用法：./start.sh
# 端口：默认宿主机 8000，可通过环境变量或项目根目录 .env 里的 MAPTRACK_PORT 修改。
#
set -euo pipefail

# 切换到脚本所在目录，保证在任意路径下执行都能找到 docker-compose.yml
cd "$(dirname "$0")"

APP_PORT="${MAPTRACK_PORT:-8000}"

info() { printf '%s\n' "$*"; }
fail() { printf '\n[错误] %s\n' "$*" >&2; exit 1; }

info "============================================"
info "  地图轨迹合并工具 - 一键启动"
info "============================================"
info ""

# ---------- 1. 检查 docker 命令 ----------
command -v docker >/dev/null 2>&1 || fail "未找到 docker 命令。macOS 请先安装 Docker Desktop；Linux 请安装 Docker Engine 与 compose 插件（详见 安装流程.md）。"

# ---------- 2. 检查 Docker 引擎是否在运行 ----------
docker info >/dev/null 2>&1 || fail "Docker 已安装但引擎未运行。macOS 请打开 Docker Desktop；Linux 请执行 sudo systemctl start docker 后重试。"

# ---------- 3. 检查 compose 插件（必须为 v2） ----------
docker compose version >/dev/null 2>&1 || fail "未找到 docker compose 插件（v2）。请升级 Docker Desktop，或安装 docker-compose-plugin 后重试。"

# ---------- 4. 构建镜像并启动容器 ----------
info "[1/3] 构建镜像并启动容器（首次构建需下载 python:3.12-slim 基础镜像）..."
docker compose up -d --build || fail "docker compose up 执行失败。请查看日志：docker compose logs -f"

# ---------- 5. 读取宿主机实际映射端口（默认 8000） ----------
if [ -z "${MAPTRACK_PORT:-}" ]; then
  DETECTED_PORT="$(docker compose port maptrack 8000 2>/dev/null | head -n 1 | awk -F: '{print $NF}' | tr -d '\r' || true)"
  if [ -n "${DETECTED_PORT:-}" ]; then
    APP_PORT="${DETECTED_PORT}"
  fi
fi

# ---------- 6. 健康检查：curl / wget / python3 任一可用即可 ----------
health_ok() {
  local url="http://127.0.0.1:${APP_PORT}/api/health"
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --max-time 3 -o /dev/null "$url" >/dev/null 2>&1
    return $?
  fi
  if command -v wget >/dev/null 2>&1; then
    wget -q -T 3 -O /dev/null "$url" >/dev/null 2>&1
    return $?
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$url" >/dev/null 2>&1 <<'PY'
import sys
import urllib.request

try:
    with urllib.request.urlopen(sys.argv[1], timeout=3) as resp:
        sys.exit(0 if resp.status == 200 else 1)
except Exception:
    sys.exit(1)
PY
    return $?
  fi
  return 1
}

# ---------- 7. 轮询等待服务就绪（最多 60 秒） ----------
info "[2/3] 等待服务就绪（最多 60 秒）..."
READY=0
for _ in {1..30}; do
  if health_ok; then
    READY=1
    break
  fi
  sleep 2
done

if [ "$READY" -ne 1 ]; then
  printf '\n[错误] 服务在 60 秒内没有就绪（健康检查未通过）。\n\n' >&2
  printf '请按顺序排查：\n' >&2
  printf '  1. 查看容器状态：docker compose ps\n' >&2
  printf '  2. 查看日志：docker compose logs -f\n' >&2
  printf '  3. 手动检查：curl http://127.0.0.1:%s/api/health\n' "$APP_PORT" >&2
  printf '  4. 确认 Docker 引擎已运行、%s 端口未被占用\n' "$APP_PORT" >&2
  printf '  5. 首次拉取镜像较慢时可稍等片刻后重试\n\n' >&2
  printf '最近 30 行容器日志：\n' >&2
  docker compose logs --tail=30 || true
  exit 1
fi

# ---------- 8. 打开浏览器（macOS 用 open，Linux 用 xdg-open） ----------
info "[3/3] 服务已就绪：http://127.0.0.1:${APP_PORT}"
if command -v open >/dev/null 2>&1; then
  open "http://127.0.0.1:${APP_PORT}" >/dev/null 2>&1 || true
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "http://127.0.0.1:${APP_PORT}" >/dev/null 2>&1 || true
else
  info "没有找到浏览器启动命令，请手动打开上面的地址。"
fi

info ""
info "停止服务：./stop.sh   或   docker compose down"
info "查看日志：docker compose logs -f"
