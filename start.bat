@echo off
chcp 65001 >nul
setlocal EnableExtensions EnableDelayedExpansion
title 地图轨迹合并工具 - 启动

rem 切换到脚本所在目录（双击运行时当前目录可能是 C:\Windows\System32）
cd /d "%~dp0"

echo ============================================
echo   地图轨迹合并工具 - 一键启动
echo ============================================
echo.

rem ---------- 1. 检查 docker 命令 ----------
where docker >nul 2>nul
if errorlevel 1 goto :err_no_docker

rem ---------- 2. 检查 Docker 引擎是否已运行 ----------
docker info >nul 2>nul
if errorlevel 1 goto :err_docker_stopped

rem ---------- 3. 检查 docker compose 插件 ----------
docker compose version >nul 2>nul
if errorlevel 1 goto :err_no_compose

rem ---------- 4. 构建镜像并启动容器 ----------
echo [1/3] 构建镜像并启动容器（首次构建需下载 python:3.12-slim 基础镜像，请耐心等待）...
docker compose up -d --build
if errorlevel 1 goto :err_up

rem ---------- 5. 读取宿主机实际映射端口（默认 8000） ----------
set "APP_PORT="
if defined MAPTRACK_PORT set "APP_PORT=%MAPTRACK_PORT%"
if not defined APP_PORT (
    for /f "usebackq tokens=2 delims=:" %%p in (`docker compose port maptrack 8000 2^>nul`) do (
        if not "%%p"=="" set "APP_PORT=%%p"
    )
)
if not defined APP_PORT set "APP_PORT=8000"

rem ---------- 6. 轮询健康检查（最多 60 秒，每 2 秒一次） ----------
echo [2/3] 等待服务就绪（最多 60 秒）...
set "READY=0"
for /l %%i in (1,1,30) do (
    if "!READY!"=="0" (
        call :probe_health
        if errorlevel 1 (
            timeout /t 2 /nobreak >nul 2>nul
        ) else (
            set "READY=1"
        )
    )
)
if "!READY!"=="1" goto :ok
goto :err_timeout

:ok
echo [3/3] 服务已就绪，正在打开浏览器...
start "" "http://127.0.0.1:%APP_PORT%"
echo.
echo 访问地址：http://127.0.0.1:%APP_PORT%
echo 停止服务：双击 stop.bat，或在当前目录执行 docker compose down
echo 查看日志：docker compose logs -f
echo.
pause
exit /b 0

rem ---------- 健康检查子过程：优先 PowerShell，其次 curl.exe ----------
:probe_health
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 -Uri 'http://127.0.0.1:%APP_PORT%/api/health'; if ($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }" >nul 2>nul
if not errorlevel 1 exit /b 0
if exist "%SystemRoot%\System32\curl.exe" (
    "%SystemRoot%\System32\curl.exe" -fsS -m 3 "http://127.0.0.1:%APP_PORT%/api/health" >nul 2>nul
    if not errorlevel 1 exit /b 0
)
exit /b 1

rem ---------- 错误处理 ----------
:err_no_docker
echo [错误] 未找到 docker 命令，无法启动服务。
echo.
echo 请先安装并启动 Docker Desktop：
echo   1. 打开 https://www.docker.com/products/docker-desktop/ 下载 Windows 版安装包
echo   2. 安装前建议先执行 wsl --install 并重启（详见 安装流程.md）
echo   3. 启动 Docker Desktop，等待左下角显示 Engine running
echo   4. 再双击 start.bat
echo.
echo 详细步骤见：安装流程.md
echo.
pause
exit /b 1

:err_docker_stopped
echo [错误] 已安装 Docker，但 Docker 引擎当前没有运行。
echo.
echo 排查建议：
echo   1. 在开始菜单打开 Docker Desktop，等待鲸鱼图标变为绿色（Engine running）
echo   2. 刚启动时可能还在加载，等待 1 至 2 分钟后再试
echo   3. 若提示 WSL2 相关错误，在管理员 PowerShell 中执行：wsl --update
echo   4. 仍无法启动时重启电脑，或在 Docker Desktop 中选择 Troubleshoot 重置
echo.
pause
exit /b 1

:err_no_compose
echo [错误] 当前 Docker 缺少 compose 插件，无法使用 docker compose 命令。
echo.
echo 处理方法：
echo   1. 升级到最新版 Docker Desktop
echo   2. Linux 用户请安装 docker-compose-plugin
echo   3. 验证：执行 docker compose version 应能输出版本号
echo.
pause
exit /b 1

:err_up
echo [错误] 容器启动失败（docker compose up 返回错误）。
echo.
echo 常见原因与排查建议：
echo   1. 端口被占用：本机 8000 端口已被其他程序使用。可在项目根目录新建 .env 文件写入 MAPTRACK_PORT=9000 后重新运行，详见 README 常见问题
echo   2. Docker Desktop 未完全启动：确认鲸鱼图标为绿色、显示 Engine running 后重试
echo   3. 镜像拉取失败：网络问题或需要配置国内镜像加速，可稍后重试
echo   4. 查看详细日志：docker compose logs -f
echo.
pause
exit /b 1

:err_timeout
echo [错误] 服务在 60 秒内没有就绪（健康检查未通过）。
echo.
echo 请按顺序排查：
echo   1. 查看容器状态：docker compose ps
echo   2. 查看日志：docker compose logs -f
echo   3. 手动访问健康检查地址：http://127.0.0.1:%APP_PORT%/api/health
echo   4. 确认 Docker Desktop 已启动、%APP_PORT% 端口未被占用
echo   5. 若首次拉取镜像较慢，容器可能仍在启动中，可稍等片刻后重试
echo.
pause
exit /b 1
