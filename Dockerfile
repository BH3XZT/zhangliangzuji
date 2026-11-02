#
# 地图轨迹合并工具 —— 运行时镜像
#
# 特点：后端为纯 Python 3.12 标准库实现，构建过程不执行 pip install、不访问 PyPI，
#       只需要拉取基础镜像 python:3.12-slim 即可完成构建（国内网络/离线环境也能一键构建）。
#
# 构建：docker compose build   （或 docker build -t maptrack-merger:1.1.0 .）
# 运行：docker compose up -d   （默认宿主机端口 8000，数据目录挂载到 ./data）
#
# v2 说明：镜像内额外包含离线行政区划数据 geo/china_admin.json.gz（约 2.8MB，GCJ-02 简化边界），
#          里程碑与国家/省/市/区点亮功能在运行时直接读取该文件，不需要联网下载。

FROM python:3.12-slim

# 运行环境变量（与 docker-compose.yml 保持一致）
# PORT 为容器内监听端口，固定映射到宿主机；改宿主机端口请用 MAPTRACK_PORT。
ENV PORT=8000 \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    TZ=Asia/Shanghai \
    LANG=C.UTF-8

# 创建非 root 运行用户（uid/gid 10001），并提前建好可写的数据目录 /app/data
# 注意：这里不要用 --system（系统账号要求 UID/GID 小于 1000，显式指定 10001 会告警甚至失败）
RUN groupadd --gid 10001 maptrack \
    && useradd --uid 10001 --gid 10001 --home-dir /app \
           --shell /usr/sbin/nologin --no-create-home maptrack \
    && mkdir -p /app/data \
    && chown -R maptrack:maptrack /app

WORKDIR /app

# 只拷贝运行所需内容：后端、前端静态资源、示例轨迹、离线行政区划数据
# tests/、data/、tools/、.geo_cache/、docs/、文档、一键脚本由 .dockerignore 排除，不进入镜像
COPY --chown=maptrack:maptrack app ./app
COPY --chown=maptrack:maptrack web ./web
COPY --chown=maptrack:maptrack samples ./samples
# v2：离线行政区划数据（里程碑、地图点亮用），约 2.8MB，必须进镜像
COPY --chown=maptrack:maptrack geo ./geo

# 数据目录（运行时由 docker-compose 把宿主机 ./data 挂载到这里）
RUN mkdir -p /app/data && chown maptrack:maptrack /app/data

# 以非 root 用户运行
USER maptrack

# 容器内部监听端口（固定 8000；宿主机端口由 compose 的 MAPTRACK_PORT 决定）
EXPOSE 8000

# 健康检查：用 python 标准库 urllib 请求 /api/health，返回 200 视为健康
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD ["python", "-c", "import sys,urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=3).status == 200 else 1)"]

# 启动后端（标准库 HTTP 服务，入口 app/__main__.py）
CMD ["python", "-m", "app"]
