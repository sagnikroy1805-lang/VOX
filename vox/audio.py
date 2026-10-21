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
# WHAT THIS FILE DOES: STAGE 1 of the pipeline. Turns any audio file into a
# clean 16 kHz mono waveform (a numpy array of numbers between -1 and 1).
# Called by pipeline.process_records() on every Spark worker, and directly by
# web/app.py for the Transcribe tab.

from __future__ import annotations   # lets us write type hints like "tuple[np.ndarray, int]"

import io                  # io.BytesIO lets us treat raw bytes like a file
import shutil              # shutil.which() finds the ffmpeg program if installed
import subprocess          # runs ffmpeg as a separate program
from math import gcd       # greatest common divisor, used for the resampling ratio

import numpy as np                       # fast arrays and maths
import soundfile as sf                   # reads WAV / FLAC / OGG files
from scipy.signal import resample_poly   # polyphase resampler with anti-aliasing filter

from . import config       # our settings: TARGET_SR=16000, TRIM_TOP_DB=35, N_MELS=80 ...


# ---------------------------------------------------------------- decoding
def _decode_ffmpeg(data: bytes) -> tuple[np.ndarray, int]:
    """Fallback decoder for formats libsndfile cannot read (m4a, webm...)."""
    exe = shutil.which("ffmpeg")              # look for ffmpeg on the PATH
    if exe is None:                           # not installed -> we cannot decode this format
        raise RuntimeError("Unsupported audio format and ffmpeg is not installed.")
    proc = subprocess.run(                    # run ffmpeg: input from stdin, output to stdout
        [exe, "-hide_banner", "-loglevel", "error", "-i", "pipe:0",
         "-f", "f32le", "-ac", "1", "-ar", str(config.TARGET_SR), "pipe:1"],   # float32, 1 channel, 16 kHz
        input=data, capture_output=True, check=True,   # send the bytes in, collect the output
    )
    # ffmpeg's output is raw float32 numbers -> turn them into a numpy array
    return np.frombuffer(proc.stdout, dtype=np.float32).copy(), config.TARGET_SR


def load_audio(source) -> tuple[np.ndarray, int]:
    """Read a path or raw bytes and return (mono float32 waveform, sample_rate)."""
    # source can be raw bytes (website upload) or a file path (batch job)
    data = source if isinstance(source, (bytes, bytearray)) else open(source, "rb").read()
    try:
        # soundfile reads WAV/FLAC/OGG; always_2d gives shape (samples, channels)
        y, sr = sf.read(io.BytesIO(data), dtype="float32", always_2d=True)
        y = y.mean(axis=1)                         # downmix to mono
    except Exception:
        # soundfile could not read it (e.g. MP3, M4A, WebM) -> try ffmpeg instead
        y, sr = _decode_ffmpeg(bytes(data))
    return y.astype(np.float32), int(sr)           # waveform + its original sample rate


# ----------------------------------------------------------- transforms
def resample(y: np.ndarray, sr: int, target_sr: int = config.TARGET_SR) -> np.ndarray:
    # Change the sample rate to 16 kHz (the rate every model was trained on).
    if sr == target_sr:                   # already 16 kHz -> nothing to do
        return y
    g = gcd(sr, target_sr)                # e.g. 22050 and 16000 -> gcd 50
    # upsample by 16000/50 = 320, downsample by 22050/50 = 441; the built-in
    # low-pass filter removes frequencies above 8 kHz so they don't alias
    return resample_poly(y, target_sr // g, sr // g).astype(np.float32)


def frame_rms_db(y: np.ndarray, frame: int = 400, hop: int = 160) -> np.ndarray:
    # Loudness of every 25 ms frame (400 samples), one frame every 10 ms (160 samples),
    # in dB relative to the loudest frame (loudest = 0 dB, quieter = negative).
    if len(y) < frame:                                   # very short clip -> pad to one frame
        y = np.pad(y, (0, frame - len(y)))
    n = 1 + (len(y) - frame) // hop                      # number of frames
    # index matrix: row i = sample positions of frame i (fast, no Python loop)
    idx = np.arange(frame)[None, :] + hop * np.arange(n)[:, None]
    rms = np.sqrt(np.mean(y[idx] ** 2, axis=1) + 1e-12)  # root-mean-square energy per frame
    return 20 * np.log10(rms / (rms.max() + 1e-12) + 1e-12)   # convert to decibels


def trim_silence(y: np.ndarray, top_db: float = config.TRIM_TOP_DB,
                 frame: int = 400, hop: int = 160) -> np.ndarray:
    """Remove leading / trailing silence (energy-based voice activity)."""
    if len(y) == 0:                         # empty audio -> nothing to trim
        return y
    db = frame_rms_db(y, frame, hop)        # loudness of each frame
    voiced = np.flatnonzero(db > -top_db)   # frames louder than -35 dB = speech
    if voiced.size == 0:                    # whole clip is quiet -> keep it as it is
        return y
    start = voiced[0] * hop                 # first sample of the first speech frame
    end = min(len(y), voiced[-1] * hop + frame)   # last sample of the last speech frame
    return y[start:end]                     # cut away the silence before and after


def normalize(y: np.ndarray, peak: float = 0.95) -> np.ndarray:
    # Scale the audio so its loudest sample is 0.95 (quiet and loud recordings look alike).
    m = np.max(np.abs(y)) if len(y) else 0.0          # current loudest sample
    return (y / m * peak).astype(np.float32) if m > 0 else y   # avoid dividing by zero


def add_noise(y: np.ndarray, snr_db: float, seed: int = 0) -> np.ndarray:
    """Add white Gaussian noise so that signal/noise power ratio == snr_db."""
    rng = np.random.default_rng(seed)                  # seeded -> same noise every run
    p_signal = np.mean(y ** 2) + 1e-12                 # average power of the speech
    p_noise = p_signal / (10 ** (snr_db / 10))         # SNR formula: noise power for the wanted dB
    # random Gaussian noise with that power (std = sqrt(power)), added to the speech
    return (y + rng.normal(0, np.sqrt(p_noise), size=y.shape)).astype(np.float32)


# ---------------------------------------------------- feature extraction
def _hz_to_mel(f):
    # Convert frequency in Hz to the mel scale (how humans perceive pitch).
    return 2595.0 * np.log10(1.0 + np.asarray(f) / 700.0)


def _mel_to_hz(m):
    # Inverse of _hz_to_mel: mel value back to Hz.
    return 700.0 * (10 ** (np.asarray(m) / 2595.0) - 1.0)


_MEL_CACHE: dict = {}   # filterbanks are computed once and reused (they never change)


def mel_filterbank(sr=config.TARGET_SR, n_fft=config.N_FFT, n_mels=config.N_MELS):
    """Triangular mel filters, shape (n_mels, n_fft//2 + 1).

    Filter edges are placed evenly on the mel scale and evaluated at the exact
    FFT bin frequencies (no rounding), so no filter is empty even with the
    coarse 40 Hz resolution of a 400-point FFT.
    """
    key = (sr, n_fft, n_mels)                  # cache key for these settings
    if key not in _MEL_CACHE:                  # build it only the first time
        fft_freqs = np.linspace(0, sr / 2, n_fft // 2 + 1)   # 201 FFT bin frequencies, 0..8000 Hz
        # 82 edge points evenly spaced on the mel scale -> 80 overlapping triangles
        edges = _mel_to_hz(np.linspace(_hz_to_mel(0), _hz_to_mel(sr / 2), n_mels + 2))
        # rising side of each triangle (0 at its left edge -> 1 at its centre)
        lower = (fft_freqs[None, :] - edges[:-2, None]) / (edges[1:-1] - edges[:-2])[:, None]
        # falling side of each triangle (1 at its centre -> 0 at its right edge)
        upper = (edges[2:, None] - fft_freqs[None, :]) / (edges[2:] - edges[1:-1])[:, None]
        fb = np.maximum(0, np.minimum(lower, upper))          # triangle = min of both sides, never negative
        fb *= (2.0 / (edges[2:] - edges[:-2]))[:, None]      # Slaney area normalisation
        _MEL_CACHE[key] = fb.astype(np.float32)              # store for next time
    return _MEL_CACHE[key]                                   # shape (80, 201)


def log_mel_spectrogram(y: np.ndarray, sr: int = config.TARGET_SR,
                        n_fft=config.N_FFT, hop=config.HOP, n_mels=config.N_MELS):
    """Return log-mel spectrogram of shape (n_mels, frames)."""
    if len(y) < n_fft:                                   # pad very short audio to one window
        y = np.pad(y, (0, n_fft - len(y)))
    window = np.hanning(n_fft).astype(np.float32)        # Hann window smooths each frame's edges
    n = 1 + (len(y) - n_fft) // hop                      # number of 10 ms frames
    idx = np.arange(n_fft)[None, :] + hop * np.arange(n)[:, None]   # sample positions per frame
    spec = np.abs(np.fft.rfft(y[idx] * window, axis=1)) ** 2       # power spectrum
    mel = mel_filterbank(sr, n_fft, n_mels) @ spec.T     # group 201 FFT bins into 80 mel bands
    return np.log10(np.maximum(mel, 1e-10))              # log energy (avoid log of 0)


def extract_features(y: np.ndarray, sr: int = config.TARGET_SR) -> dict:
    """Compact per-utterance acoustic descriptors (stored with each result)."""
    if len(y) == 0:                                      # empty audio -> default values
        return {"rms_db": -120.0, "mel_mean": 0.0, "mel_std": 0.0, "speech_ratio": 0.0}
    lm = log_mel_spectrogram(y, sr)                      # 80 x frames log-mel picture
    db = frame_rms_db(y)                                 # loudness per frame
    return {
        "rms_db": float(20 * np.log10(np.sqrt(np.mean(y ** 2)) + 1e-12)),   # overall loudness in dB
        "mel_mean": float(lm.mean()),                    # average log-mel energy
        "mel_std": float(lm.std()),                      # how much the spectrum varies
        "speech_ratio": float(np.mean(db > -config.TRIM_TOP_DB)),   # fraction of frames that are speech
    }


# --------------------------------------------------------- full stage
def preprocess(source, trim: bool = True, snr_db: float | None = None,
               noise_seed: int = 0) -> tuple[np.ndarray, dict]:
    """Run the complete preprocessing stage. Returns (waveform@16k, info dict)."""
    y, sr = load_audio(source)                     # 1-2. decode + mono
    orig_dur = len(y) / sr if sr else 0.0          # original length in seconds (used for RTFx)
    y = resample(y, sr)                            # 3. convert to 16 kHz
    if trim:
        y = trim_silence(y)                        # 4. cut silence at both ends
    y = normalize(y)                               # 5. peak 0.95
    if snr_db is not None:                         # 6. only in the robustness experiment
        y = normalize(add_noise(y, snr_db, noise_seed))   # add noise, then re-normalise
    info = {                                       # facts about this file, stored in the result row
        "orig_sr": sr,                                       # original sample rate
        "duration_s": round(orig_dur, 3),                    # length before processing
        "processed_s": round(len(y) / config.TARGET_SR, 3),  # length after trimming
        **extract_features(y),                               # 7. rms_db, mel_mean, mel_std, speech_ratio
    }
    return y, info                                 # clean waveform + info -> goes to the model
