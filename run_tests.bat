@echo off
REM WHAT THIS FILE DOES: runs the 16 automatic tests in tests\test_vox.py - expected result: 16 passed
REM go to the VOX folder
cd /d "%~dp0"
REM set the Python, Java and Hadoop paths
call "%~dp0_env.bat" || exit /b 1
REM run pytest on the tests folder
"%PY%" -m pytest -q tests
REM keep the window open to read the result
pause
