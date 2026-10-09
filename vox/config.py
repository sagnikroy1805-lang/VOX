"""Central configuration for VOX.

Every value can be overridden with an environment variable of the same name,
so the same code runs on a laptop, in a lab, or on a real Spark cluster.
"""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.getenv("VOX_DATA_DIR", ROOT / "data"))
RESULTS_DIR = Path(os.getenv("VOX_RESULTS_DIR", ROOT / "results"))
UPLOAD_DIR = Path(os.getenv("VOX_UPLOAD_DIR", DATA_DIR / "uploads"))
MODEL_CACHE = Path(os.getenv("VOX_MODEL_CACHE", ROOT / "models_cache"))

# --- audio preprocessing -------------------------------------------------
TARGET_SR = 16_000          # every ASR model used here expects 16 kHz mono
TRIM_TOP_DB = 35.0          # silence threshold (dB below peak) for trimming
N_MELS = 80                 # same number of mel bins Whisper uses
N_FFT = 400                 # 25 ms window @16 kHz
HOP = 160                   # 10 ms hop  @16 kHz

# --- models ---------------------------------------------------------------
DEFAULT_MODEL = os.getenv("VOX_DEFAULT_MODEL", "whisper-tiny")

# --- spark ----------------------------------------------------------------
SPARK_MASTER = os.getenv("VOX_SPARK_MASTER", "local[*]")
SPARK_DRIVER_MEMORY = os.getenv("VOX_SPARK_DRIVER_MEMORY", "4g")
# Torch threads per Spark task. 1 avoids CPU over-subscription
# (N Spark tasks x M torch threads must not exceed physical cores).
TORCH_THREADS_PER_TASK = int(os.getenv("VOX_TORCH_THREADS", "1"))

for d in (DATA_DIR, RESULTS_DIR, UPLOAD_DIR, MODEL_CACHE):
    d.mkdir(parents=True, exist_ok=True)

# Keep HuggingFace downloads inside the project folder (easy to find/delete).
os.environ.setdefault("HF_HOME", str(MODEL_CACHE))
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")   # Windows noise
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
