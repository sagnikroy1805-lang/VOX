"""The processing kernel shared by BOTH execution engines.

`process_records` is the exact same function whether it runs
  * in a plain Python loop (single-node baseline), or
  * inside a Spark `mapInPandas` task on each partition (distributed).
That guarantees the benchmark compares only the execution strategy,
never two different implementations.
"""
# WHAT THIS FILE DOES: the KERNEL. For a list of audio files it runs
#   stage 1 audio.preprocess -> stage 2 model.transcribe_batch -> stage 3 metrics.wer/cer
# and returns one result row (20 columns) per file. engines.py calls this.

from __future__ import annotations

import os          # os.getpid(): process id, to know which Spark worker did the work
import socket      # socket.gethostname(): machine name, same reason
import time        # timing each stage
import zlib        # zlib.crc32(): a repeatable number from the file id (noise seed)

from . import audio, metrics, models   # the three stage files

# The 20 columns every result row has (Spark needs this fixed list in advance)
RESULT_COLUMNS = [
    "id", "path", "reference", "hypothesis", "wer", "cer",
    "duration_s", "processed_s", "orig_sr", "rms_db", "mel_mean", "mel_std",
    "speech_ratio", "preprocess_s", "infer_s", "model_load_s", "language", "ref_language", "worker", "error",
]


def _empty_result(rec):
    # A blank result row for one file, pre-filled with what the manifest already gives us.
    r = {c: None for c in RESULT_COLUMNS}                # every column starts empty
    r.update(id=str(rec.get("id")), path=str(rec.get("path")),
             reference=rec.get("reference"), hypothesis="", error=None,
             ref_language=(rec.get("language") or None))   # language of the reference text
    return r


def score_language(row: dict, language: str | None, task: str) -> str:
    """Which language's normalisation/tokenisation to score with."""
    if task == "translate":
        return "en"                        # references for translation are English
    # otherwise: the manifest's language, else the chosen one, else the detected one, else English
    return row.get("ref_language") or language or row.get("language") or "en"


def process_records(records: list[dict], model_name: str, batch_size: int = 8,
                    trim: bool = True, snr_db: float | None = None,
                    language: str | None = None, task: str = "transcribe") -> list[dict]:
    """Preprocess + transcribe + score a list of {id, path, reference[, language]} dicts.

    language: "en" | "es" | "ja" | None (None = Whisper auto-detects)
    task:     "transcribe" (same language) | "translate" (Whisper -> English)
    """
    worker = f"{socket.gethostname()}:{os.getpid()}"   # e.g. "sagnik:10432" = this Spark worker
    t_load = time.perf_counter()
    model = models.get_model(model_name)      # loaded once per process, then cached
    load_s = round(time.perf_counter() - t_load, 4)    # ~0 s if it was already loaded
    out = []                                  # all result rows
    for s in range(0, len(records), batch_size):       # 8 files at a time
        chunk = records[s:s + batch_size]     # this batch of up to 8 files
        waves, results = [], []               # good waveforms + one result row per file
        # ---- stage 1: preprocessing (per file) -------------------------
        for i, rec in enumerate(chunk):
            r = _empty_result(rec)
            r["worker"] = worker              # remember which worker processed this file
            t0 = time.perf_counter()
            try:
                seed = zlib.crc32(r["id"].encode())  # reproducible across processes
                y, info = audio.preprocess(rec["path"], trim=trim, snr_db=snr_db,
                                           noise_seed=seed)   # clean 16 kHz waveform + info
                r.update(info)                # store duration, sample rate, features in the row
                waves.append((i, y))          # keep the waveform for the model (i = position in batch)
            except Exception as e:  # corrupt / unreadable file -> keep going
                r["error"] = f"preprocess: {type(e).__name__}: {e}"
            r["preprocess_s"] = round(time.perf_counter() - t0, 4)   # time spent on stage 1
            results.append(r)
        # ---- stage 2: batched model inference --------------------------
        if waves:                             # at least one file was readable
            t0 = time.perf_counter()
            try:
                # ONE model call for the whole batch (faster than one call per file)
                hyps = model.transcribe_batch([y for _, y in waves], language, task)
            except Exception as e:
                # model failed -> empty text for every file in this batch, error recorded
                hyps = [{"text": "", "language": language}] * len(waves)
                for i, _ in waves:
                    results[i]["error"] = f"inference: {type(e).__name__}: {e}"
            per_file = (time.perf_counter() - t0) / len(waves)   # average inference time per file
            for (i, _), h in zip(waves, hyps):
                results[i]["hypothesis"] = h["text"]          # what the model heard
                results[i]["language"] = h["language"]        # detected / chosen language
                results[i]["infer_s"] = round(per_file, 4)
        # ---- stage 3: evaluation --------------------------------------
        for r in results:
            ref = r.get("reference")
            if ref and str(ref).strip() and r["error"] is None:   # only score if there is a reference
                lg = score_language(r, language, task)            # which language rules to use
                r["wer"] = round(metrics.wer(ref, r["hypothesis"], lang=lg), 4)
                r["cer"] = round(metrics.cer(ref, r["hypothesis"], lang=lg), 4)
        out.extend(results)                   # add this batch's rows to the output
    if out:
        out[0]["model_load_s"] = load_s       # ~0 when the model was already cached
    return out                                # list of 20-column dicts, one per file
