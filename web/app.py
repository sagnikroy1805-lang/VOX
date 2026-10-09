"""VOX web server (FastAPI).

  GET  /                         the VOX single-page website
  GET  /api/status               models, Spark/Java availability, datasets
  POST /api/transcribe           one file -> text (+ language, WER/CER, waveform)
  POST /api/upload               many files -> a manifest for a batch job
  POST /api/jobs/{kind}          start batch | benchmark | noise | download
  GET  /api/jobs[/{id}]          job status, progress, log and results
  GET  /api/jobs/{id}/csv        per-file results as CSV
  GET  /api/results              saved benchmark / noise experiments

Long jobs run one at a time on a background thread (Spark itself parallelises
inside each job), and the browser polls for progress.
"""
from __future__ import annotations

import io
import os
import sys
import threading
import time
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from vox import __version__, audio, benchmark, config, datasets, engines, metrics, models  # noqa: E402

STATIC = Path(__file__).resolve().parent / "static"
app = FastAPI(title="VOX", version=__version__)
app.mount("/static", StaticFiles(directory=STATIC), name="static")

EXECUTOR = ThreadPoolExecutor(max_workers=1)        # Spark/compute jobs: one at a time
DOWNLOADS = ThreadPoolExecutor(max_workers=2)       # network downloads never block experiments
JOBS: dict[str, dict] = {}
JOB_LOCK = threading.Lock()
INFER_LOCK = threading.Lock()


# ------------------------------------------------------------------ pages
@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


@app.get("/api/status")
def status():
    return {
        "version": __version__,
        "models": models.available_models(),
        "default_model": config.DEFAULT_MODEL,
        "languages": models.LANGUAGES,
        "java": engines.java_available(),
        "spark_master": config.SPARK_MASTER,
        "spark_running": engines._SPARK["session"] is not None,
        "cpu_count": os.cpu_count(),
        "worker_options": benchmark.default_worker_counts(),
        "datasets": datasets.list_manifests(),
        "busy": any(j["state"] in ("queued", "running") for j in JOBS.values()),
    }


# -------------------------------------------------------------- transcribe
def _envelope(y: np.ndarray, points: int = 600) -> list:
    if len(y) == 0:
        return []
    edges = np.linspace(0, len(y), points + 1).astype(int)
    return [round(float(np.abs(y[a:b]).max()) if b > a else 0.0, 3)
            for a, b in zip(edges[:-1], edges[1:])]


@app.post("/api/transcribe")
def transcribe(file: UploadFile = File(...), model: str = Form(config.DEFAULT_MODEL),
               reference: str = Form(""), trim: bool = Form(True),
               snr_db: str = Form(""), language: str = Form(""),
               task: str = Form("transcribe")):
    data = file.file.read()
    if not data:
        raise HTTPException(400, "Empty file")
    lang = language if language in models.LANGUAGES else None     # "" / "auto" -> detect
    try:
        models.check_language(model, lang, task)
    except ValueError as e:
        raise HTTPException(400, str(e))
    try:
        t0 = time.perf_counter()
        raw, sr = audio.load_audio(data)
        snr = float(snr_db) if snr_db not in ("", "none", None) else None
        y, info = audio.preprocess(data, trim=trim, snr_db=snr)
        t_pre = time.perf_counter() - t0
        with INFER_LOCK:
            t1 = time.perf_counter()
            fresh = model not in models._CACHE
            m = models.get_model(model)
            t_load = time.perf_counter() - t1 if fresh else 0.0
            models.set_torch_threads(os.cpu_count() or 1)
            t2 = time.perf_counter()
            out = m.transcribe(y, lang, task)
            text = out["text"]
            t_inf = time.perf_counter() - t2
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(500, f"{type(e).__name__}: {e}")
    res = {
        "filename": file.filename, "model": model, "text": text,
        "language": out["language"], "language_name": models.LANGUAGES.get(out["language"], out["language"]),
        "requested_language": lang or "auto", "task": task,
        "info": info,
        "timing": {"preprocess_s": round(t_pre, 3), "model_load_s": round(t_load, 3),
                   "inference_s": round(t_inf, 3),
                   "rtfx": round(info["duration_s"] / t_inf, 2) if t_inf else None},
        "waveform_raw": _envelope(audio.resample(raw, sr)),
        "waveform": _envelope(y),
        "words": len(text.split()),
    }
    if reference.strip():
        sl = "en" if task == "translate" else (lang or out["language"] or "en")
        d = metrics.wer_details(reference, text, lang=sl)
        res["scores"] = {
            "wer": round(metrics.wer(reference, text, lang=sl), 4),
            "cer": round(metrics.cer(reference, text, lang=sl), 4),
            **{k: d[k] for k in ("S", "D", "I", "N", "H")},
            "ref_norm": metrics.normalize_text(reference, sl),
            "hyp_norm": metrics.normalize_text(text, sl),
            "unit": "char" if sl in metrics.NO_SPACE_LANGS else "word",
            "score_language": sl,
        }
    return res


# ------------------------------------------------------------------ upload
@app.post("/api/upload")
async def upload(files: list[UploadFile] = File(...), name: str = Form("")):
    batch = (name.strip().replace(" ", "_") or "upload") + "_" + uuid.uuid4().hex[:6]
    folder = config.UPLOAD_DIR / batch
    folder.mkdir(parents=True, exist_ok=True)
    rows = []
    for f in files:
        fn = Path(f.filename).name
        dest = folder / fn
        dest.write_bytes(await f.read())
        if dest.suffix.lower() == ".txt" or dest.suffix.lower() == ".csv":
            continue
        rows.append({"id": dest.stem, "path": fn, "reference": ""})
    # optional references: sidecar <name>.txt uploaded alongside the audio
    for r in rows:
        side = folder / f"{r['id']}.txt"
        if side.exists():
            r["reference"] = side.read_text(encoding="utf-8").strip()
    if not rows:
        raise HTTPException(400, "No audio files in upload")
    mf = datasets.write_manifest(rows, folder / "manifest.csv")
    return {"manifest": str(mf), "count": len(rows), "name": batch}


# -------------------------------------------------------------------- jobs
class JobRequest(BaseModel):
    manifest: str | None = None
    model: str = config.DEFAULT_MODEL
    engine: str = "spark"            # spark | local
    workers: int | None = None       # spark local[N]
    worker_counts: list[int] | None = None
    limit: int | None = None
    snr_db: float | None = None
    snrs: list[float | None] | None = None
    language: str | None = None      # en | es | ja | None (auto-detect)
    task: str = "transcribe"         # transcribe | translate
    which: str | None = None         # for download jobs


def _new_job(kind: str, params: dict) -> dict:
    jid = uuid.uuid4().hex[:10]
    job = {"id": jid, "kind": kind, "params": params, "state": "queued",
           "progress": {"label": "", "done": 0, "total": 0}, "log": [],
           "created": time.time(), "started": None, "finished": None,
           "summary": None, "result": None, "rows": None, "error": None}
    with JOB_LOCK:
        JOBS[jid] = job
    return job


def _log(job, msg):
    job["log"].append(f"[{time.strftime('%H:%M:%S')}] {msg}")


def _prog(job):
    def cb(*a, **k):
        if len(a) == 3:
            label, done, total = a
        else:
            label, (done, total) = k.get("unit", "files"), a[:2]
        job["progress"] = {"label": label, "done": int(done), "total": int(total)}
    return cb


def _records(req: JobRequest):
    mf = req.manifest or str(datasets.demo_manifest())
    recs = datasets.load_manifest(mf, req.limit)
    if not recs:
        raise ValueError("Dataset is empty")
    return recs


def _lang(req: JobRequest):
    return req.language if req.language in models.LANGUAGES else None


def _run_job(job, req: JobRequest):
    job["state"], job["started"] = "running", time.time()
    log = lambda m: _log(job, m)  # noqa: E731
    try:
        if job["kind"] == "batch":
            recs = _records(req)
            if req.engine == "spark":
                if not engines.java_available():
                    raise RuntimeError("Java not found - Spark needs Java 17. "
                                       "Run setup_windows.bat or use engine=local.")
                master = f"local[{req.workers}]" if req.workers else config.SPARK_MASTER
                log(f"Starting Spark ({master}) for {len(recs)} files with {req.model}")
                eng = engines.SparkEngine(master)
            else:
                log(f"Single-node run for {len(recs)} files with {req.model}")
                eng = engines.LocalEngine()
            df, summary = eng.run(recs, req.model, snr_db=req.snr_db, progress=_prog(job),
                                  language=_lang(req), task=req.task)
            df = df.astype(object).where(df.notna(), None)   # NaN -> null for JSON
            job["rows"] = df.to_dict("records")
            job["summary"] = summary
            log(f"Done in {summary['wall_s']} s - WER {summary.get('wer')}")
        elif job["kind"] == "benchmark":
            if not engines.java_available():
                raise RuntimeError("Java not found - Spark needs Java 17.")
            recs = _records(req)
            job["result"] = benchmark.run_benchmark(recs, req.model, req.worker_counts,
                                                    progress=_prog(job), log=log,
                                                    language=_lang(req))
        elif job["kind"] == "noise":
            recs = _records(req)
            eng = "spark" if engines.java_available() and req.engine == "spark" else "local"
            snrs = req.snrs or [None, 20, 10, 5, 0]
            job["result"] = benchmark.run_noise_sweep(recs, req.model, snrs, eng,
                                                      progress=_prog(job), log=log,
                                                      language=_lang(req))
        elif job["kind"] == "download":
            log(f"Downloading {req.which} ...")
            if req.which == "dummy":
                p = datasets.download_librispeech_dummy()
            elif req.which in ("fleurs-es", "fleurs-ja"):
                p = datasets.download_fleurs(req.which[-2:], limit=req.limit or 100)
            else:
                p = datasets.download_librispeech(req.which, req.limit or 200)
            job["result"] = {"manifest": str(p)}
            log(f"Saved manifest {p}")
        job["state"] = "done"
    except Exception as e:
        traceback.print_exc()
        try:   # full details for debugging: results/vox_errors.log
            with open(config.RESULTS_DIR / "vox_errors.log", "a", encoding="utf-8") as f:
                f.write(f"\n===== {time.strftime('%Y-%m-%d %H:%M:%S')} job {job['id']} "
                        f"({job['kind']}) params={job['params']}\n{traceback.format_exc()}")
        except OSError:
            pass
        job["state"], job["error"] = "error", f"{type(e).__name__}: {e}"
        log(job["error"])
    finally:
        job["finished"] = time.time()


@app.post("/api/jobs/{kind}")
def start_job(kind: str, req: JobRequest):
    if kind not in ("batch", "benchmark", "noise", "download"):
        raise HTTPException(404, "unknown job type")
    job = _new_job(kind, req.model_dump())
    (DOWNLOADS if kind == "download" else EXECUTOR).submit(_run_job, job, req)
    return {"id": job["id"]}


def _public(job, rows=True):
    j = {k: v for k, v in job.items() if k != "rows" or rows}
    if job["state"] == "queued" and job["kind"] != "download":
        ahead = [x for x in JOBS.values() if x["kind"] != "download"
                 and x["state"] in ("queued", "running") and x["created"] < job["created"]]
        if ahead:
            j["waiting_for"] = f"{len(ahead)} earlier job(s): " + ", ".join(x["kind"] for x in ahead)
    if job["started"]:
        j["elapsed_s"] = round((job["finished"] or time.time()) - job["started"], 1)
    return j


@app.get("/api/jobs")
def list_jobs():
    return [_public(j, rows=False) for j in sorted(JOBS.values(), key=lambda x: -x["created"])]


@app.get("/api/jobs/{jid}")
def get_job(jid: str):
    if jid not in JOBS:
        raise HTTPException(404, "no such job")
    return JSONResponse(_public(JOBS[jid]))


@app.get("/api/jobs/{jid}/csv")
def job_csv(jid: str):
    job = JOBS.get(jid)
    if not job or not job.get("rows"):
        raise HTTPException(404, "no rows")
    import pandas as pd
    buf = io.StringIO()
    pd.DataFrame(job["rows"]).to_csv(buf, index=False)
    return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv",
                             headers={"Content-Disposition": f"attachment; filename=vox_{jid}.csv"})


@app.get("/api/results")
def results():
    return benchmark.list_results()


@app.on_event("shutdown")
def _shutdown():
    engines.stop_spark()
