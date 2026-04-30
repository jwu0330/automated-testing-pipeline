@echo off
REM ════════════════════════════════════════════════════════════
REM  Automated Testing Pipeline — 一鍵啟動 UI
REM
REM  雙擊執行：自動啟動 Docker Desktop + UI server + 開瀏覽器。
REM  也可放進 Windows 啟動資料夾（shell:startup）開機自動跑。
REM ════════════════════════════════════════════════════════════
setlocal
cd /d "%~dp0"

set PORT=%PORT%
if "%PORT%"=="" set PORT=8080

echo [start] checking Docker Desktop...
tasklist /FI "IMAGENAME eq Docker Desktop.exe" 2>nul | find /I "Docker Desktop.exe" >nul
if errorlevel 1 (
    echo [start] launching Docker Desktop ^(detached^)...
    if exist "C:\Program Files\Docker\Docker\Docker Desktop.exe" (
        start "" "C:\Program Files\Docker\Docker\Docker Desktop.exe"
    ) else (
        powershell -NoProfile -Command "Start-Process 'Docker Desktop'"
    )
) else (
    echo [start] Docker Desktop already running.
)

REM Docker daemon 不需在這裡同步等待 — server.js 會在 /api/run 時再次確認

where node >nul 2>&1
if errorlevel 1 (
    echo [start] ERROR: node not found in PATH. Please install Node.js.
    pause
    exit /b 1
)

echo [start] launching UI server on http://localhost:%PORT%
start "atp-ui" /MIN cmd /c "node ui\server.js"

REM 給 server 一秒上線再開瀏覽器
timeout /t 2 /nobreak >nul
start "" "http://localhost:%PORT%"

echo [start] done. UI window minimized to taskbar.
endlocal
