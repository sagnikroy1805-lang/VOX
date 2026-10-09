"""The processing kernel shared by BOTH execution engines.

`process_records` is the exact same function whether it runs
  * in a plain Python loop (single-node baseline), or
  * inside a Spark `mapInPandas` task on each partition (distributed).
That guarantees the benchmark compares only the execution strategy,
never two different implementations.
"""
from __future__ import annotations

import os
import socket
import time
import zlib

from . import audio, metrics, models

RESULT_COLUMNS = [
    "id", "path", "reference", "hypothesis", "wer", "cer",
    "duration_s", "processed_s", "orig_sr", "rms_db", "mel_mean", "mel_std",
    "speech_ratio", "preprocess_s", "infer_s", "model_load_s", "language", "ref_language", "worker", "error",
]


def _empty_result(rec):
    r = {c: None for c in RESULT_COLUMNS}
    r.update(id=str(rec.get("id")), path=str(rec.get("path")),
             reference=rec.get("reference"), hypothesis="", error=None,
             ref_language=(rec.get("language") or None))
    return r


def score_language(row: dict, language: str | None, task: str) -> str:
    """Which language's normalisation/tokenisation to score with."""
    if task == "translate":
        return "en"                        # references for translation are English
    return row.get("ref_language") or language or row.get("language") or "en"


def process_records(records: list[dict], model_name: str, batch_size: int = 8,
                    trim: bool = True, snr_db: float | None = None,
                    language: str | None = None, task: str = "transcribe") -> list[dict]:
    """Preprocess + transcribe + score a list of {id, path, reference[, language]} dicts.

    language: "en" | "es" | "ja" | None (None = Whisper auto-detects)
    task:     "transcribe" (same language) | "translate" (Whisper -> English)
    """
    worker = f"{socket.gethostname()}:{os.getpid()}"
    t_load = time.perf_counter()
    model = models.get_model(model_name)      # loaded once per process, then cached
    load_s = round(time.perf_counter() - t_load, 4)
    out = []
    for s in range(0, len(records), batch_size):
        chunk = records[s:s + batch_size]
        waves, results = [], []
        # ---- stage 1: preprocessing (per file) -------------------------
        for i, rec in enumerate(chunk):
            r = _empty_result(rec)
            r["worker"] = worker
            t0 = time.perf_counter()
            try:
                seed = zlib.crc32(r["id"].encode())  # reproducible across processes
                y, info = audio.preprocess(rec["path"], trim=trim, snr_db=snr_db,
                                           noise_seed=seed)
                r.update(info)
                waves.append((i, y))
            except Exception as e:  # corrupt / unreadable file -> keep going
                r["error"] = f"preprocess: {type(e).__name__}: {e}"
            r["preprocess_s"] = round(time.perf_counter() - t0, 4)
            results.append(r)
        # ---- stage 2: batched model inference --------------------------
        if waves:
            t0 = time.perf_counter()
            try:
                hyps = model.transcribe_batch([y for _, y in waves], language, task)
            except Exception as e:
                hyps = [{"text": "", "language": language}] * len(waves)
                for i, _ in waves:
                    results[i]["error"] = f"inference: {type(e).__name__}: {e}"
            per_file = (time.perf_counter() - t0) / len(waves)
            for (i, _), h in zip(waves, hyps):
                results[i]["hypothesis"] = h["text"]
                results[i]["language"] = h["language"]
                results[i]["infer_s"] = round(per_file, 4)
        # ---- stage 3: evaluation --------------------------------------
        for r in results:
            ref = r.get("reference")
            if ref and str(ref).strip() and r["error"] is None:
                lg = score_language(r, language, task)
                r["wer"] = round(metrics.wer(ref, r["hypothesis"], lang=lg), 4)
                r["cer"] = round(metrics.cer(ref, r["hypothesis"], lang=lg), 4)
        out.extend(results)
    if out:
        out[0]["model_load_s"] = load_s       # ~0 when the model was already cached
    return out
