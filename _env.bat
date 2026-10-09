@echo off
REM Shared helper: points PY and JAVA_HOME at the environment made by setup_windows.bat
set "VOXROOT=%~dp0"
set "PY="
if exist "%VOXROOT%env\python.exe" set "PY=%VOXROOT%env\python.exe"
if not defined PY if exist "%VOXROOT%env\Scripts\python.exe" set "PY=%VOXROOT%env\Scripts\python.exe"
if not defined PY (
    echo VOX is not set up yet - run setup_windows.bat first.
    pause
    exit /b 1
)
if not exist "%VOXROOT%env\Library\bin\java.exe" goto :nojava
set "JAVA_HOME=%VOXROOT%env\Library"
set "PATH=%VOXROOT%env;%VOXROOT%env\Library\bin;%VOXROOT%env\Scripts;%PATH%"
:nojava
set "HADOOP_HOME=%VOXROOT%hadoop"
set "PATH=%VOXROOT%hadoop\bin;%PATH%"
set "PYTHONPATH=%VOXROOT%"
set "PYSPARK_PYTHON=%PY%"
set "PYSPARK_DRIVER_PYTHON=%PY%"
set "PYTHONIOENCODING=utf-8"
