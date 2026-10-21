@echo off
REM Shared helper: points PY and JAVA_HOME at the environment made by setup_windows.bat
REM VOXROOT = the VOX folder - the folder this .bat file is in
set "VOXROOT=%~dp0"
REM PY = the Python inside env - conda layout first, then venv layout
set "PY="
if exist "%VOXROOT%env\python.exe" set "PY=%VOXROOT%env\python.exe"
if not defined PY if exist "%VOXROOT%env\Scripts\python.exe" set "PY=%VOXROOT%env\Scripts\python.exe"
REM no Python found: VOX has not been set up yet
if not defined PY (
    echo VOX is not set up yet - run setup_windows.bat first.
    pause
    exit /b 1
)
REM Java 17 inside env: JAVA_HOME tells Spark where Java is
if not exist "%VOXROOT%env\Library\bin\java.exe" goto :nojava
set "JAVA_HOME=%VOXROOT%env\Library"
set "PATH=%VOXROOT%env;%VOXROOT%env\Library\bin;%VOXROOT%env\Scripts;%PATH%"
:nojava
REM HADOOP_HOME = VOX\hadoop: Spark on Windows needs hadoop\bin\winutils.exe
set "HADOOP_HOME=%VOXROOT%hadoop"
set "PATH=%VOXROOT%hadoop\bin;%PATH%"
REM PYTHONPATH = VOX folder, so import vox works everywhere, including in Spark workers
set "PYTHONPATH=%VOXROOT%"
REM the Spark driver and the Spark workers must use the SAME Python
set "PYSPARK_PYTHON=%PY%"
set "PYSPARK_DRIVER_PYTHON=%PY%"
REM print Japanese and Spanish text correctly in the console
set "PYTHONIOENCODING=utf-8"
