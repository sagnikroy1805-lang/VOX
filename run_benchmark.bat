@echo off
REM Command-line experiments (same as the Benchmark / Robustness tabs of the website).
REM go to the VOX folder
cd /d "%~dp0"
REM set the Python, Java and Hadoop paths - stop if VOX is not set up yet
call "%~dp0_env.bat" || exit /b 1
REM use the LibriSpeech sample if it was downloaded, otherwise the 40 demo clips
set "DATA=data\librispeech_dummy\manifest.csv"
if not exist "%DATA%" set "DATA=data\samples\manifest.csv"

echo === 1. Accuracy: Whisper-tiny vs wav2vec2 vs PocketSphinx on %DATA% ===
REM 1. batch: transcribe the whole dataset on Spark with each model and compare WER
"%PY%" -m vox.cli batch --manifest %DATA% --engine spark --model whisper-tiny
"%PY%" -m vox.cli batch --manifest %DATA% --engine spark --model wav2vec2-base
"%PY%" -m vox.cli batch --manifest %DATA% --engine spark --model pocketsphinx

echo === 2. Scalability: single-node vs Spark 1/2/4... workers ===
REM 2. scalability benchmark: single-node vs Spark with 1, 2, 4 ... workers
"%PY%" -m vox.cli benchmark --manifest %DATA% --model whisper-tiny

echo === 3. Noise robustness sweep ===
REM 3. noise sweep: WER and CER at clean, 20, 10, 5 and 0 dB
"%PY%" -m vox.cli noise --manifest %DATA% --model whisper-tiny

echo.
echo All results are in the results\ folder (JSON + CSV) and on the website.
pause
