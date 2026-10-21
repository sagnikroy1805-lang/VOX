@echo off
REM Start the VOX website and open it in the browser.
REM go to the VOX folder
cd /d "%~dp0"
REM set the Python, Java and Hadoop paths - stop if VOX is not set up yet
call "%~dp0_env.bat" || exit /b 1
echo.
echo   Starting VOX on http://127.0.0.1:8000   (close this window to stop)
echo.
REM open the website in the default browser
start "" http://127.0.0.1:8000
REM start the web server - python -m vox.cli serve - keep this window open while using VOX
"%PY%" -m vox.cli serve --port 8000
REM if the server stops, keep the window open to read any error
pause
