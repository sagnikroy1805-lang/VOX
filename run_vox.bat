@echo off
REM Start the VOX website and open it in the browser.
cd /d "%~dp0"
call "%~dp0_env.bat" || exit /b 1
echo.
echo   Starting VOX on http://127.0.0.1:8000   (close this window to stop)
echo.
start "" http://127.0.0.1:8000
"%PY%" -m vox.cli serve --port 8000
pause
