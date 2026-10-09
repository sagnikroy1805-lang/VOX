"""Experiments that answer the research gaps from the DA1 review.

1. Scalability benchmark  - single-node vs Spark with 1, 2, 4 ... workers
   (gap: "few studies report runtime/throughput of distributed vs
   single-node ASR inference").
2. Noise-robustness sweep - WER/CER as white noise is added at decreasing
   SNR (gap: "noise-robust ASR rarely evaluated together with distributed
   processing").

Both write JSON + CSV into results/ and are shown on the VOX website.
"""
from __future__ import annotations

import json
import os
import time
from datetime import datetime

import pandas as pd

from . import config, models
from .engines import LocalEngine, SparkEngine, stop_spark


def _save(kind: str, payload: dict) -> str:
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    path = config.RESULTS_DIR / f"{kind}_{ts}.json"
    path.write_text(json.dumps(payload, indent=2, default=str), encoding="utf-8")
    rows = payload.get("runs") or payload.get("points") or []
    if rows:
        pd.DataFrame(rows).to_csv(path.with_suffix(".csv"), index=False)
    return str(path)


def default_worker_counts() -> list[int]:
    n = os.cpu_count() or 2
    counts, k = [], 1
    while k <= n:
        counts.append(k)
        k *= 2
    if counts[-1] != n:
        counts.append(n)
    return counts


def run_benchmark(records, model_name, worker_counts=None, include_local=True,
                  batch_size=8, progress=None, log=print, include_mt=True,
                  language=None) -> dict:
    worker_counts = worker_counts or default_worker_counts()
    runs = []
    if include_local:
        log(f"[benchmark] single-node baseline on {len(records)} files ...")
        models._CACHE.clear()           # include model loading, like Spark workers do
        _, s = LocalEngine().run(records, model_name, batch_size, language=language,
                                 progress=(lambda d, t, **k: progress and progress(f"single-node", d, t)))
        runs.append(s)
        log(f"[benchmark]   wall={s['wall_s']}s  RTFx={s['rtfx']}")
        ncpu = os.cpu_count() or 1
        if include_mt and ncpu > 1 and models.MODEL_INFO[model_name]["family"] != "pocketsphinx":
            log(f"[benchmark] single-node, PyTorch multithreaded ({ncpu} threads) ...")
            models._CACHE.clear()
            _, s = LocalEngine(threads=ncpu).run(
                records, model_name, batch_size, language=language,
                progress=(lambda d, t, **k: progress and progress("single-node-mt", d, t)))
            runs.append(s)
            log(f"[benchmark]   wall={s['wall_s']}s  RTFx={s['rtfx']}")
    for w in worker_counts:
        log(f"[benchmark] Spark local[{w}] ...")
        eng = SparkEngine(master=f"local[{w}]")
        _, s = eng.run(records, model_name, batch_size, language=language,
                       progress=(lambda d, t, unit="", w=w: progress and progress(f"spark x{w}", d, t)))
        runs.append(s)
        log(f"[benchmark]   wall={s['wall_s']}s  RTFx={s['rtfx']}")
    stop_spark()

    base = runs[0]["wall_s"] if include_local else None
    spark1 = next((r["wall_s"] for r in runs if r["engine"] == "spark" and r["workers"] == 1), None)
    for r in runs:
        if base:
            r["speedup_vs_single"] = round(base / r["wall_s"], 3)
        if spark1:
            r["speedup_vs_spark1"] = round(spark1 / r["wall_s"], 3)
            if r["engine"] == "spark":
                # parallel efficiency = speedup / number of workers
                r["efficiency"] = round(spark1 / r["wall_s"] / r["workers"], 3)
    payload = {"kind": "benchmark", "model": model_name, "files": len(records),
               "language": language or "auto",
               "cpu_count": os.cpu_count(), "torch_threads_per_task": config.TORCH_THREADS_PER_TASK,
               "created": datetime.now().isoformat(timespec="seconds"), "runs": runs}
    payload["saved_to"] = _save("benchmark", payload)
    return payload


def run_noise_sweep(records, model_name, snrs=(None, 20, 10, 5, 0), engine="spark",
                    progress=None, log=print, language=None) -> dict:
    eng = SparkEngine() if engine == "spark" else LocalEngine()
    points = []
    for i, snr in enumerate(snrs):
        label = "clean" if snr is None else f"{snr:g} dB"
        log(f"[noise] SNR = {label}")
        _, s = eng.run(records, model_name, snr_db=snr, language=language)
        points.append({"snr_db": snr, "label": label, "wer": s["wer"], "cer": s["cer"],
                       "wall_s": s["wall_s"]})
        if progress:
            progress("noise", i + 1, len(snrs))
    payload = {"kind": "noise", "model": model_name, "engine": engine, "files": len(records),
               "language": language or "auto",
               "created": datetime.now().isoformat(timespec="seconds"), "points": points}
    payload["saved_to"] = _save("noise", payload)
    return payload


def list_results() -> list[dict]:
    out = []
    for p in sorted(config.RESULTS_DIR.glob("*.json"), reverse=True):
        try:
            d = json.loads(p.read_text(encoding="utf-8"))
            out.append(d)
        except Exception:
            continue
    return out
