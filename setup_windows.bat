@echo off
REM ======================================================================
REM  VOX one-time setup for Windows
REM  - creates a private environment in .\env  (Python 3.11 + Java 17)
REM  - installs all Python packages
REM  - downloads the Whisper-tiny and wav2vec2 models + LibriSpeech sample
REM ======================================================================
setlocal EnableExtensions
cd /d "%~dp0"
set "ENV=%~dp0env"
echo.
echo   ==========  VOX setup  ==========
echo.

REM ---------- locate conda (Anaconda / Miniconda) ----------
set "CONDA_BAT="
for %%P in ("%USERPROFILE%\anaconda3" "%USERPROFILE%\miniconda3" "%LOCALAPPDATA%\anaconda3" "%LOCALAPPDATA%\miniconda3" "%ProgramData%\anaconda3" "%ProgramData%\miniconda3") do (
    if not defined CONDA_BAT if exist "%%~P\condabin\conda.bat" set "CONDA_BAT=%%~P\condabin\conda.bat"
)
if not defined CONDA_BAT (
    where conda >nul 2>nul && set "CONDA_BAT=conda"
)

if defined CONDA_BAT goto :with_conda
goto :with_venv

:with_conda
echo [1/4] Creating conda environment with Python 3.11 + OpenJDK 17 (Java for Spark) ...
if exist "%ENV%\python.exe" (
    echo       env already exists - skipping
) else (
    call "%CONDA_BAT%" create -y -p "%ENV%" -c conda-forge python=3.11 openjdk=17
    if errorlevel 1 goto :fail
)
set "PY=%ENV%\python.exe"
set "JAVA_HOME=%ENV%\Library"
set "PATH=%ENV%;%ENV%\Library\bin;%ENV%\Scripts;%PATH%"
goto :install

:with_venv
echo [1/4] conda not found - using a plain Python virtual environment.
where python >nul 2>nul || (echo   ERROR: Python 3.10/3.11 is not installed. Install it from python.org & goto :fail)
if not exist "%ENV%\Scripts\python.exe" python -m venv "%ENV%"
set "PY=%ENV%\Scripts\python.exe"
where java >nul 2>nul || (
    echo.
    echo   WARNING: Java was not found. Spark needs Java 17.
    echo   Install it with:   winget install EclipseAdoptium.Temurin.17.JDK
    echo   Single-file transcription will still work without it.
    echo.
)

:install
echo [2/4] Installing Python packages (torch, transformers, pyspark, fastapi ...)
"%PY%" -m pip install --upgrade pip
"%PY%" -m pip install -r requirements.txt
if errorlevel 1 goto :fail

echo [3/4] Downloading pretrained models (whisper-tiny, wav2vec2-base) ...
"%PY%" -m vox.cli prefetch whisper-tiny wav2vec2-base

echo [4/4] Downloading a LibriSpeech evaluation sample (73 utterances) ...
"%PY%" -m vox.cli download dummy

echo.
echo   Setup complete.  Start VOX with:  run_vox.bat
echo.
pause
exit /b 0

:fail
echo.
echo   Setup failed - see the messages above.
pause
exit /b 1
