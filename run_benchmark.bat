@echo off
REM Command-line experiments (same as the Benchmark / Robustness tabs of the website).
cd /d "%~dp0"
call "%~dp0_env.bat" || exit /b 1
set "DATA=data\librispeech_dummy\manifest.csv"
if not exist "%DATA%" set "DATA=data\samples\manifest.csv"

echo === 1. Accuracy: Whisper-tiny vs wav2vec2 vs PocketSphinx on %DATA% ===
"%PY%" -m vox.cli batch --manifest %DATA% --engine spark --model whisper-tiny
"%PY%" -m vox.cli batch --manifest %DATA% --engine spark --model wav2vec2-base
"%PY%" -m vox.cli batch --manifest %DATA% --engine spark --model pocketsphinx

echo === 2. Scalability: single-node vs Spark 1/2/4... workers ===
"%PY%" -m vox.cli benchmark --manifest %DATA% --model whisper-tiny

echo === 3. Noise robustness sweep ===
"%PY%" -m vox.cli noise --manifest %DATA% --model whisper-tiny

echo.
echo All results are in the results\ folder (JSON + CSV) and on the website.
pause
