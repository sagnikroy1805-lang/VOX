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
# WHAT THIS FILE DOES: the website's BACKEND. The browser (app.js) sends HTTP
# requests here; each endpoint below calls functions from the vox package and
# sends back JSON. Started by "python -m vox.cli serve" (run_vox.bat).

from __future__ import annotations

import io                 # in-memory text buffer for CSV downloads
import os                 # os.cpu_count()
import sys
import threading          # locks so two requests don't clash
import time
import traceback          # full error details for the log file
import uuid               # random ids for jobs and upload folders
from concurrent.futures import ThreadPoolExecutor   # background job queues
from pathlib import Path

import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile        # the web framework
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles      # serves index.html, app.js, tailwind.js
from pydantic import BaseModel                   # checks the JSON body of job requests

# make "import vox" work: add the project folder (parent of web/) to Python's search path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from vox import __version__, audio, benchmark, config, datasets, engines, metrics, models  # noqa: E402

STATIC = Path(__file__).resolve().parent / "static"          # web/static/ folder
app = FastAPI(title="VOX", version=__version__)               # the web application object
app.mount("/static", StaticFiles(directory=STATIC), name="static")   # /static/... -> files in web/static

EXECUTOR = ThreadPoolExecutor(max_workers=1)        # Spark/compute jobs: one at a time
DOWNLOADS = ThreadPoolExecutor(max_workers=2)       # network downloads never block experiments
JOBS: dict[str, dict] = {}                          # every job, by id (kept in memory)
JOB_LOCK = threading.Lock()                         # protects JOBS
INFER_LOCK = threading.Lock()                       # one Transcribe-tab inference at a time


# ------------------------------------------------------------------ pages
@app.get("/")
def index():
    # Opening http://127.0.0.1:8000 returns the single web page.
    return FileResponse(STATIC / "index.html")


@app.get("/api/status")
def status():
    # Called by app.js when the page loads: fills all dropdowns and the status chips.
    return {
        "version": __version__,
        "models": models.available_models(),                 # model list for the dropdown
        "default_model": config.DEFAULT_MODEL,
        "languages": models.LANGUAGES,                        # en / es / ja
        "java": engines.java_available(),                     # "Java / Spark ready" chip
        "spark_master": config.SPARK_MASTER,
        "spark_running": engines._SPARK["session"] is not None,
        "cpu_count": os.cpu_count(),
        "worker_options": benchmark.default_worker_counts(),  # 1, 2, 4, 8 ...
        "datasets": datasets.list_manifests(),                # dataset dropdown
        "busy": any(j["state"] in ("queued", "running") for j in JOBS.values()),
    }


# -------------------------------------------------------------- transcribe
def _envelope(y: np.ndarray, points: int = 600) -> list:
    # Shrink a waveform to 600 numbers (loudest value in each slice) for drawing on the page.
    if len(y) == 0:
        return []
    edges = np.linspace(0, len(y), points + 1).astype(int)    # 600 equal slices
    return [round(float(np.abs(y[a:b]).max()) if b > a else 0.0, 3)
            for a, b in zip(edges[:-1], edges[1:])]


@app.post("/api/transcribe")
def transcribe(file: UploadFile = File(...), model: str = Form(config.DEFAULT_MODEL),
               reference: str = Form(""), trim: bool = Form(True),
               snr_db: str = Form(""), language: str = Form(""),
               task: str = Form("transcribe")):
    # TRANSCRIBE TAB: one file -> text. No Spark: we call the three stages directly.
    data = file.file.read()                                   # the uploaded WAV bytes
    if not data:
        raise HTTPException(400, "Empty file")
    lang = language if language in models.LANGUAGES else None     # "" / "auto" -> detect
    try:
        models.check_language(model, lang, task)              # e.g. reject wav2vec2-base + Japanese
    except ValueError as e:
        raise HTTPException(400, str(e))                      # error shown as a message on the page
    try:
        t0 = time.perf_counter()
        raw, sr = audio.load_audio(data)                      # original audio (for the "raw" waveform picture)
        snr = float(snr_db) if snr_db not in ("", "none", None) else None
        y, info = audio.preprocess(data, trim=trim, snr_db=snr)   # stage 1: clean 16 kHz waveform
        t_pre = time.perf_counter() - t0
        with INFER_LOCK:                                      # one inference at a time
            t1 = time.perf_counter()
            fresh = model not in models._CACHE                # will the model be loaded now?
            m = models.get_model(model)                       # load (first time) or reuse
            t_load = time.perf_counter() - t1 if fresh else 0.0
            models.set_torch_threads(os.cpu_count() or 1)     # one file -> let PyTorch use all cores
            t2 = time.perf_counter()
            out = m.transcribe(y, lang, task)                 # stage 2: speech -> text
            text = out["text"]
            t_inf = time.perf_counter() - t2                  # inference time
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(500, f"{type(e).__name__}: {e}")
    res = {                                                   # everything the page displays
        "filename": file.filename, "model": model, "text": text,
        "language": out["language"], "language_name": models.LANGUAGES.get(out["language"], out["language"]),
        "requested_language": lang or "auto", "task": task,
        "info": info,
        "timing": {"preprocess_s": round(t_pre, 3), "model_load_s": round(t_load, 3),
                   "inference_s": round(t_inf, 3),
                   "rtfx": round(info["duration_s"] / t_inf, 2) if t_inf else None},   # audio s / inference s
        "waveform_raw": _envelope(audio.resample(raw, sr)),   # picture before processing
        "waveform": _envelope(y),                             # picture after trimming/normalising
        "words": len(text.split()),
    }
    if reference.strip():                                     # user typed the correct text -> score it
        sl = "en" if task == "translate" else (lang or out["language"] or "en")   # scoring language
        d = metrics.wer_details(reference, text, lang=sl)     # stage 3: S, D, I, N
        res["scores"] = {
            "wer": round(metrics.wer(reference, text, lang=sl), 4),
            "cer": round(metrics.cer(reference, text, lang=sl), 4),
            **{k: d[k] for k in ("S", "D", "I", "N", "H")},
            "ref_norm": metrics.normalize_text(reference, sl),   # cleaned texts for the coloured alignment
            "hyp_norm": metrics.normalize_text(text, sl),
            "unit": "char" if sl in metrics.NO_SPACE_LANGS else "word",
            "score_language": sl,
        }
    return res


# ------------------------------------------------------------------ upload
@app.post("/api/upload")
async def upload(files: list[UploadFile] = File(...), name: str = Form("")):
    # BATCH TAB "Upload files": save the files in data/uploads/<name>_xxxxxx/ and write a manifest.
    batch = (name.strip().replace(" ", "_") or "upload") + "_" + uuid.uuid4().hex[:6]
    folder = config.UPLOAD_DIR / batch
    folder.mkdir(parents=True, exist_ok=True)
    rows = []
    for f in files:
        fn = Path(f.filename).name                    # file name only (no folders, for safety)
        dest = folder / fn
        dest.write_bytes(await f.read())              # save the file
        if dest.suffix.lower() == ".txt" or dest.suffix.lower() == ".csv":
            continue                                  # text files are not audio
        rows.append({"id": dest.stem, "path": fn, "reference": ""})
    # optional references: sidecar <name>.txt uploaded alongside the audio
    for r in rows:
        side = folder / f"{r['id']}.txt"
        if side.exists():
            r["reference"] = side.read_text(encoding="utf-8").strip()
    if not rows:
        raise HTTPException(400, "No audio files in upload")
    mf = datasets.write_manifest(rows, folder / "manifest.csv")   # now it appears in the dataset list
    return {"manifest": str(mf), "count": len(rows), "name": batch}


# -------------------------------------------------------------------- jobs
class JobRequest(BaseModel):
    # The settings the page sends when starting a job (pydantic checks the types).
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
    # Create a job record (state "queued") and store it in JOBS.
    jid = uuid.uuid4().hex[:10]                       # random 10-character job id
    job = {"id": jid, "kind": kind, "params": params, "state": "queued",
           "progress": {"label": "", "done": 0, "total": 0}, "log": [],
           "created": time.time(), "started": None, "finished": None,
           "summary": None, "result": None, "rows": None, "error": None}
    with JOB_LOCK:
        JOBS[jid] = job
    return job


def _log(job, msg):
    # Add a timestamped line to the job's log (shown under the progress bar).
    job["log"].append(f"[{time.strftime('%H:%M:%S')}] {msg}")


def _prog(job):
    # Returns a callback the engines call to report progress (done / total).
    def cb(*a, **k):
        if len(a) == 3:
            label, done, total = a                    # called as (label, done, total)
        else:
            label, (done, total) = k.get("unit", "files"), a[:2]   # called as (done, total, unit=...)
        job["progress"] = {"label": label, "done": int(done), "total": int(total)}
    return cb


def _records(req: JobRequest):
    # Load the chosen dataset (default: demo samples), optionally only the first N files.
    mf = req.manifest or str(datasets.demo_manifest())
    recs = datasets.load_manifest(mf, req.limit)
    if not recs:
        raise ValueError("Dataset is empty")
    return recs


def _lang(req: JobRequest):
    # Keep the language only if it is en/es/ja; anything else means auto-detect (None).
    return req.language if req.language in models.LANGUAGES else None


def _run_job(job, req: JobRequest):
    # Runs on a background thread: does the actual work of a job.
    job["state"], job["started"] = "running", time.time()
    log = lambda m: _log(job, m)  # noqa: E731
    try:
        if job["kind"] == "batch":                                    # ---- BATCH TAB ----
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
                                  language=_lang(req), task=req.task)   # run the pipeline
            df = df.astype(object).where(df.notna(), None)   # NaN -> null for JSON
            job["rows"] = df.to_dict("records")              # per-file table
            job["summary"] = summary                          # summary cards
            log(f"Done in {summary['wall_s']} s - WER {summary.get('wer')}")
        elif job["kind"] == "benchmark":                              # ---- BENCHMARK TAB ----
            if not engines.java_available():
                raise RuntimeError("Java not found - Spark needs Java 17.")
            recs = _records(req)
            job["result"] = benchmark.run_benchmark(recs, req.model, req.worker_counts,
                                                    progress=_prog(job), log=log,
                                                    language=_lang(req))
        elif job["kind"] == "noise":                                  # ---- ROBUSTNESS TAB ----
            recs = _records(req)
            eng = "spark" if engines.java_available() and req.engine == "spark" else "local"
            snrs = req.snrs or [None, 20, 10, 5, 0]                   # clean + 4 noise levels
            job["result"] = benchmark.run_noise_sweep(recs, req.model, snrs, eng,
                                                      progress=_prog(job), log=log,
                                                      language=_lang(req))
        elif job["kind"] == "download":                               # ---- DOWNLOAD BUTTONS ----
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
        job["state"], job["error"] = "error", f"{type(e).__name__}: {e}"   # shown as a red message
        log(job["error"])
    finally:
        job["finished"] = time.time()


@app.post("/api/jobs/{kind}")
def start_job(kind: str, req: JobRequest):
    # Start a background job and return its id IMMEDIATELY (the page then polls for progress).
    if kind not in ("batch", "benchmark", "noise", "download"):
        raise HTTPException(404, "unknown job type")
    job = _new_job(kind, req.model_dump())
    # downloads go to their own queue so they never block a benchmark
    (DOWNLOADS if kind == "download" else EXECUTOR).submit(_run_job, job, req)
    return {"id": job["id"]}


def _public(job, rows=True):
    # The job as JSON for the page (optionally without the big per-file table).
    j = {k: v for k, v in job.items() if k != "rows" or rows}
    if job["state"] == "queued" and job["kind"] != "download":
        # tell the user which earlier jobs this one is waiting behind
        ahead = [x for x in JOBS.values() if x["kind"] != "download"
                 and x["state"] in ("queued", "running") and x["created"] < job["created"]]
        if ahead:
            j["waiting_for"] = f"{len(ahead)} earlier job(s): " + ", ".join(x["kind"] for x in ahead)
    if job["started"]:
        j["elapsed_s"] = round((job["finished"] or time.time()) - job["started"], 1)   # seconds so far
    return j


@app.get("/api/jobs")
def list_jobs():
    # All jobs, newest first (without the per-file rows).
    return [_public(j, rows=False) for j in sorted(JOBS.values(), key=lambda x: -x["created"])]


@app.get("/api/jobs/{jid}")
def get_job(jid: str):
    # Polled by the page every 0.8 s: state, progress, log and (when done) the results.
    if jid not in JOBS:
        raise HTTPException(404, "no such job")
    return JSONResponse(_public(JOBS[jid]))


@app.get("/api/jobs/{jid}/csv")
def job_csv(jid: str):
    # "Download CSV" button: the per-file results table as a CSV file.
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
    # Saved benchmark / noise experiments from results/ (history on the Benchmark and Robustness tabs).
    return benchmark.list_results()


@app.on_event("shutdown")
def _shutdown():
    # When the server stops (window closed), shut Spark down cleanly.
    engines.stop_spark()
