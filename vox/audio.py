"""Audio preprocessing stage of the VOX pipeline.

Steps applied to every file (on each Spark executor, in parallel):
    1. decode          -> float32 waveform (any common format)
    2. downmix         -> mono
    3. resample        -> 16 kHz (polyphase filter, scipy.signal.resample_poly)
    4. trim silence    -> remove leading/trailing frames quieter than TRIM_TOP_DB
    5. normalise       -> peak normalisation to 0.95
    6. (optional) add noise at a chosen SNR  -> robustness experiments
    7. feature extraction -> log-mel spectrogram + summary statistics

Everything is written with numpy/scipy only so it runs identically on
Windows, Linux and inside Spark Python workers.
"""
from __future__ import annotations

import io
import shutil
import subprocess
from math import gcd

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

from . import config


# ---------------------------------------------------------------- decoding
def _decode_ffmpeg(data: bytes) -> tuple[np.ndarray, int]:
    """Fallback decoder for formats libsndfile cannot read (m4a, webm...)."""
    exe = shutil.which("ffmpeg")
    if exe is None:
        raise RuntimeError("Unsupported audio format and ffmpeg is not installed.")
    proc = subprocess.run(
        [exe, "-hide_banner", "-loglevel", "error", "-i", "pipe:0",
         "-f", "f32le", "-ac", "1", "-ar", str(config.TARGET_SR), "pipe:1"],
        input=data, capture_output=True, check=True,
    )
    return np.frombuffer(proc.stdout, dtype=np.float32).copy(), config.TARGET_SR


def load_audio(source) -> tuple[np.ndarray, int]:
    """Read a path or raw bytes and return (mono float32 waveform, sample_rate)."""
    data = source if isinstance(source, (bytes, bytearray)) else open(source, "rb").read()
    try:
        y, sr = sf.read(io.BytesIO(data), dtype="float32", always_2d=True)
        y = y.mean(axis=1)                         # downmix to mono
    except Exception:
        y, sr = _decode_ffmpeg(bytes(data))
    return y.astype(np.float32), int(sr)


# ----------------------------------------------------------- transforms
def resample(y: np.ndarray, sr: int, target_sr: int = config.TARGET_SR) -> np.ndarray:
    if sr == target_sr:
        return y
    g = gcd(sr, target_sr)
    return resample_poly(y, target_sr // g, sr // g).astype(np.float32)


def frame_rms_db(y: np.ndarray, frame: int = 400, hop: int = 160) -> np.ndarray:
    if len(y) < frame:
        y = np.pad(y, (0, frame - len(y)))
    n = 1 + (len(y) - frame) // hop
    idx = np.arange(frame)[None, :] + hop * np.arange(n)[:, None]
    rms = np.sqrt(np.mean(y[idx] ** 2, axis=1) + 1e-12)
    return 20 * np.log10(rms / (rms.max() + 1e-12) + 1e-12)


def trim_silence(y: np.ndarray, top_db: float = config.TRIM_TOP_DB,
                 frame: int = 400, hop: int = 160) -> np.ndarray:
    """Remove leading / trailing silence (energy-based voice activity)."""
    if len(y) == 0:
        return y
    db = frame_rms_db(y, frame, hop)
    voiced = np.flatnonzero(db > -top_db)
    if voiced.size == 0:
        return y
    start = voiced[0] * hop
    end = min(len(y), voiced[-1] * hop + frame)
    return y[start:end]


def normalize(y: np.ndarray, peak: float = 0.95) -> np.ndarray:
    m = np.max(np.abs(y)) if len(y) else 0.0
    return (y / m * peak).astype(np.float32) if m > 0 else y


def add_noise(y: np.ndarray, snr_db: float, seed: int = 0) -> np.ndarray:
    """Add white Gaussian noise so that signal/noise power ratio == snr_db."""
    rng = np.random.default_rng(seed)
    p_signal = np.mean(y ** 2) + 1e-12
    p_noise = p_signal / (10 ** (snr_db / 10))
    return (y + rng.normal(0, np.sqrt(p_noise), size=y.shape)).astype(np.float32)


# ---------------------------------------------------- feature extraction
def _hz_to_mel(f):
    return 2595.0 * np.log10(1.0 + np.asarray(f) / 700.0)


def _mel_to_hz(m):
    return 700.0 * (10 ** (np.asarray(m) / 2595.0) - 1.0)


_MEL_CACHE: dict = {}


def mel_filterbank(sr=config.TARGET_SR, n_fft=config.N_FFT, n_mels=config.N_MELS):
    """Triangular mel filters, shape (n_mels, n_fft//2 + 1).

    Filter edges are placed evenly on the mel scale and evaluated at the exact
    FFT bin frequencies (no rounding), so no filter is empty even with the
    coarse 40 Hz resolution of a 400-point FFT.
    """
    key = (sr, n_fft, n_mels)
    if key not in _MEL_CACHE:
        fft_freqs = np.linspace(0, sr / 2, n_fft // 2 + 1)
        edges = _mel_to_hz(np.linspace(_hz_to_mel(0), _hz_to_mel(sr / 2), n_mels + 2))
        lower = (fft_freqs[None, :] - edges[:-2, None]) / (edges[1:-1] - edges[:-2])[:, None]
        upper = (edges[2:, None] - fft_freqs[None, :]) / (edges[2:] - edges[1:-1])[:, None]
        fb = np.maximum(0, np.minimum(lower, upper))
        fb *= (2.0 / (edges[2:] - edges[:-2]))[:, None]      # Slaney area normalisation
        _MEL_CACHE[key] = fb.astype(np.float32)
    return _MEL_CACHE[key]


def log_mel_spectrogram(y: np.ndarray, sr: int = config.TARGET_SR,
                        n_fft=config.N_FFT, hop=config.HOP, n_mels=config.N_MELS):
    """Return log-mel spectrogram of shape (n_mels, frames)."""
    if len(y) < n_fft:
        y = np.pad(y, (0, n_fft - len(y)))
    window = np.hanning(n_fft).astype(np.float32)
    n = 1 + (len(y) - n_fft) // hop
    idx = np.arange(n_fft)[None, :] + hop * np.arange(n)[:, None]
    spec = np.abs(np.fft.rfft(y[idx] * window, axis=1)) ** 2       # power spectrum
    mel = mel_filterbank(sr, n_fft, n_mels) @ spec.T
    return np.log10(np.maximum(mel, 1e-10))


def extract_features(y: np.ndarray, sr: int = config.TARGET_SR) -> dict:
    """Compact per-utterance acoustic descriptors (stored with each result)."""
    if len(y) == 0:
        return {"rms_db": -120.0, "mel_mean": 0.0, "mel_std": 0.0, "speech_ratio": 0.0}
    lm = log_mel_spectrogram(y, sr)
    db = frame_rms_db(y)
    return {
        "rms_db": float(20 * np.log10(np.sqrt(np.mean(y ** 2)) + 1e-12)),
        "mel_mean": float(lm.mean()),
        "mel_std": float(lm.std()),
        "speech_ratio": float(np.mean(db > -config.TRIM_TOP_DB)),
    }


# --------------------------------------------------------- full stage
def preprocess(source, trim: bool = True, snr_db: float | None = None,
               noise_seed: int = 0) -> tuple[np.ndarray, dict]:
    """Run the complete preprocessing stage. Returns (waveform@16k, info dict)."""
    y, sr = load_audio(source)
    orig_dur = len(y) / sr if sr else 0.0
    y = resample(y, sr)
    if trim:
        y = trim_silence(y)
    y = normalize(y)
    if snr_db is not None:
        y = normalize(add_noise(y, snr_db, noise_seed))
    info = {
        "orig_sr": sr,
        "duration_s": round(orig_dur, 3),
        "processed_s": round(len(y) / config.TARGET_SR, 3),
        **extract_features(y),
    }
    return y, info
