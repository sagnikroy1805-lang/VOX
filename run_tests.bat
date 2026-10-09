@echo off
cd /d "%~dp0"
call "%~dp0_env.bat" || exit /b 1
"%PY%" -m pytest -q tests
pause
