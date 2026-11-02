@echo off
chcp 65001 >nul
setlocal EnableExtensions
title 地图轨迹合并工具 - 停止

rem 切换到脚本所在目录
cd /d "%~dp0"

echo ============================================
echo   地图轨迹合并工具 - 停止服务
echo ============================================
echo.

where docker >nul 2>nul
if errorlevel 1 goto :err_no_docker

docker info >nul 2>nul
if errorlevel 1 goto :err_docker_stopped

echo 正在停止并移除容器...
docker compose down
if errorlevel 1 goto :err_down

echo.
echo 已停止。你的数据仍保留在 data 目录，下次启动会自动挂载。
echo.
pause
exit /b 0

:err_no_docker
echo [错误] 未找到 docker 命令。
echo.
echo 请确认已安装 Docker Desktop 并已加入系统 PATH，然后重新打开本窗口。
echo 详细步骤见：安装流程.md
echo.
pause
exit /b 1

:err_docker_stopped
echo [错误] 已安装 Docker，但 Docker 引擎当前没有运行。
echo.
echo 请先启动 Docker Desktop，等待鲸鱼图标变为绿色（Engine running）后重试。
echo.
pause
exit /b 1

:err_down
echo [错误] docker compose down 执行失败。
echo.
echo 排查建议：
echo   1. 确认 Docker Desktop 已启动
echo   2. 查看容器状态：docker compose ps
echo   3. 查看日志：docker compose logs -f
echo.
pause
exit /b 1
