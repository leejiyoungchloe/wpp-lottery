@echo off
chcp 65001 >nul
if exist "%~dp0start-tunnel.js" (
    cd /d "%~dp0"
    node start-tunnel.js
) else (
    echo 错误：未找到 start-tunnel.js
    pause
    exit /b 1
)
