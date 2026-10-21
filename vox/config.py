"""Central configuration for VOX.

Every value can be overridden with an environment variable of the same name,
so the same code runs on a laptop, in a lab, or on a real Spark cluster.
"""
# WHAT THIS FILE DOES: holds every setting and folder path in ONE place.
# Every other module imports it ("from . import config"), so changing a value
# here (e.g. the sample rate) changes it everywhere at once.

import os                      # read environment variables, set new ones
from pathlib import Path       # Path objects make folder paths work on Windows and Linux

# ROOT = the VOX project folder (this file is VOX/vox/config.py -> go up two levels)
ROOT = Path(__file__).resolve().parent.parent
# Folder with datasets (audio files + manifest.csv); VOX_DATA_DIR can override it
DATA_DIR = Path(os.getenv("VOX_DATA_DIR", ROOT / "data"))
# Folder where benchmark / noise results (JSON + CSV) and the error log are saved
RESULTS_DIR = Path(os.getenv("VOX_RESULTS_DIR", ROOT / "results"))
# Folder where files uploaded on the website are stored
UPLOAD_DIR = Path(os.getenv("VOX_UPLOAD_DIR", DATA_DIR / "uploads"))
# Folder where downloaded model weights (Whisper, wav2vec2) are cached
MODEL_CACHE = Path(os.getenv("VOX_MODEL_CACHE", ROOT / "models_cache"))

# --- audio preprocessing -------------------------------------------------
TARGET_SR = 16_000          # every ASR model used here expects 16 kHz mono
TRIM_TOP_DB = 35.0          # silence threshold (dB below peak) for trimming
N_MELS = 80                 # same number of mel bins Whisper uses
N_FFT = 400                 # 25 ms window @16 kHz
HOP = 160                   # 10 ms hop  @16 kHz

# --- models ---------------------------------------------------------------
# Model pre-selected in the website dropdown (can be changed with VOX_DEFAULT_MODEL)
DEFAULT_MODEL = os.getenv("VOX_DEFAULT_MODEL", "whisper-tiny")

# --- spark ----------------------------------------------------------------
# Spark master URL: "local[*]" = use all cores of this laptop;
# on a real cluster set VOX_SPARK_MASTER=spark://IP:7077 (no code change needed)
SPARK_MASTER = os.getenv("VOX_SPARK_MASTER", "local[*]")
# Memory given to the Spark driver (the Java process that coordinates the job)
SPARK_DRIVER_MEMORY = os.getenv("VOX_SPARK_DRIVER_MEMORY", "4g")
# Torch threads per Spark task. 1 avoids CPU over-subscription
# (N Spark tasks x M torch threads must not exceed physical cores).
TORCH_THREADS_PER_TASK = int(os.getenv("VOX_TORCH_THREADS", "1"))

# Create the four folders if they do not exist yet (first run on a new machine)
for d in (DATA_DIR, RESULTS_DIR, UPLOAD_DIR, MODEL_CACHE):
    d.mkdir(parents=True, exist_ok=True)   # parents=True: also make missing parent folders

# Keep HuggingFace downloads inside the project folder (easy to find/delete).
os.environ.setdefault("HF_HOME", str(MODEL_CACHE))
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")   # Windows noise
# Stop the HuggingFace tokenizer from starting its own threads (avoids warnings in workers)
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
