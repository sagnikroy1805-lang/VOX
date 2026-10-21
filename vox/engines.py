"""Execution engines.

LocalEngine  - single-node baseline: one Python process, files processed
               sequentially (the "no Spark" reference point).
SparkEngine  - distributed: the manifest becomes a Spark DataFrame, split into
               partitions, and every partition is processed by a Python worker
               through `mapInPandas` (a vectorised, Arrow-based pandas UDF).

Both call exactly the same `pipeline.process_records` kernel.
"""
# WHAT THIS FILE DOES: decides WHERE the kernel runs - in one process
# (LocalEngine) or spread over Spark workers (SparkEngine). This is the ONLY
# file that uses Apache Spark. It also computes the run summary (RTFx, WER...).

from __future__ import annotations

import os            # environment variables, os.name ("nt" = Windows)
import shutil        # shutil.which("java") to check Java is installed
import sys           # sys.executable = path of the Python we are running
import tempfile      # temp folder for the zipped package
import threading     # background thread that reports Spark progress
import time          # wall-clock timing
import zipfile       # zip the vox package for remote cluster workers
from pathlib import Path

import pandas as pd  # results are pandas DataFrames

from . import config, metrics, models
from .pipeline import RESULT_COLUMNS, process_records   # the kernel and its 20 columns


def summarize(df: pd.DataFrame, wall_s: float, engine: str, model: str,
              workers: int, extra: dict | None = None, language=None,
              task="transcribe") -> dict:
    # Turn the per-file rows into ONE summary of the whole run (shown as cards on the website).
    from .pipeline import score_language
    ok = df[df["error"].isna()] if "error" in df else df          # rows without errors
    audio_s = float(ok["duration_s"].fillna(0).sum())             # total seconds of audio
    rows = ok.to_dict("records")
    langs = [score_language(r, language, task) for r in rows]      # scoring language per file
    # corpus-level WER/CER = total errors / total reference words (metrics.py)
    scores = metrics.corpus_scores(ok["reference"].fillna("").tolist(),
                                   ok["hypothesis"].fillna("").tolist(), langs)
    # how many files were detected in each language, e.g. {"en": 38, "es": 2}
    detected = ok["language"].dropna().value_counts().to_dict() if "language" in ok else {}
    s = {
        "engine": engine, "model": model, "workers": workers,
        "files": int(len(df)), "failed": int(len(df) - len(ok)),
        "audio_s": round(audio_s, 2), "wall_s": round(wall_s, 3),
        "files_per_s": round(len(df) / wall_s, 3) if wall_s else None,   # throughput
        # RTFx: seconds of audio transcribed per second of wall-clock time
        "rtfx": round(audio_s / wall_s, 3) if wall_s else None,
        "preprocess_s_total": round(float(ok["preprocess_s"].fillna(0).sum()), 3),
        "infer_s_total": round(float(ok["infer_s"].fillna(0).sum()), 3),
        "model_load_s_total": round(float(df["model_load_s"].fillna(0).sum()), 3),
        "distinct_workers": int(df["worker"].nunique()),       # how many processes did work
        "language": language or "auto", "task": task,
        "detected_languages": {str(k): int(v) for k, v in detected.items()},
        # add wer, cer, substitutions, ... (floats rounded to 4 decimals)
        **{k: (round(v, 4) if isinstance(v, float) else v) for k, v in scores.items()},
    }
    if extra:
        s.update(extra)              # engine-specific extras (threads, master, partitions)
    return s


# =====================================================================
class LocalEngine:
    """Single process. threads=1 -> pure sequential baseline;
    threads=N -> PyTorch intra-op multithreading (a stronger baseline that
    uses all cores *inside* one model call instead of across files)."""

    def __init__(self, threads: int | None = None):
        self.threads = threads or config.TORCH_THREADS_PER_TASK          # default 1 thread
        self.name = "single-node" if self.threads == 1 else f"single-node-mt"

    def run(self, records, model_name, batch_size=8, trim=True, snr_db=None,
            progress=None, language=None, task="transcribe"):
        models.check_language(model_name, language, task)   # reject impossible combinations early
        models.set_torch_threads(self.threads)
        t0 = time.perf_counter()                             # start the stopwatch
        out = []
        step = max(1, batch_size)
        for i in range(0, len(records), step):               # simple loop, 8 files at a time
            out += process_records(records[i:i + step], model_name, batch_size, trim, snr_db,
                                   language, task)           # the SAME kernel Spark uses
            if progress:
                progress(len(out), len(records))             # update the website progress bar
        wall = time.perf_counter() - t0                      # wall time of the whole run
        df = pd.DataFrame(out, columns=RESULT_COLUMNS)       # rows -> table
        return df, summarize(df, wall, self.name, model_name, 1,
                             {"threads": self.threads}, language, task)


# =====================================================================
_SPARK = {"session": None, "master": None}   # the one SparkSession we keep and reuse
_SPARK_LOCK = threading.Lock()               # only one thread may start/stop Spark at a time


def _package_zip() -> str:
    """Zip the `vox` package so Spark can ship it to remote executors."""
    src = Path(__file__).resolve().parent                 # the vox/ folder
    out = Path(tempfile.gettempdir()) / "vox_pkg.zip"
    with zipfile.ZipFile(out, "w") as z:
        for f in src.rglob("*.py"):                       # every .py file in vox/
            z.write(f, f"vox/{f.relative_to(src).as_posix()}")
    return str(out)


def java_available() -> bool:
    # Spark runs on Java, so check that Java exists (shown as a chip on the website).
    if os.environ.get("JAVA_HOME") and Path(os.environ["JAVA_HOME"], "bin").exists():
        return True
    return shutil.which("java") is not None


def _windows_hadoop_fix():
    """Spark's Hadoop layer needs winutils.exe on Windows (HADOOP_HOME).

    VOX ships winutils.exe + hadoop.dll in VOX/hadoop/bin and points
    HADOOP_HOME there before the JVM starts. No-op on Linux/macOS.
    """
    if os.name != "nt":                               # not Windows -> nothing to do
        return
    home = config.ROOT / "hadoop"                     # VOX/hadoop
    if (home / "bin" / "winutils.exe").exists():
        os.environ["HADOOP_HOME"] = str(home)         # where Spark looks for winutils.exe
        os.environ["hadoop.home.dir"] = str(home)
        bin_dir = str(home / "bin")
        if bin_dir not in os.environ.get("PATH", ""):
            os.environ["PATH"] = bin_dir + os.pathsep + os.environ.get("PATH", "")   # so hadoop.dll is found


def get_spark(master: str | None = None):
    """Create (or reuse) the SparkSession. Changing `master` restarts Spark."""
    from pyspark.sql import SparkSession

    master = master or config.SPARK_MASTER                      # e.g. "local[4]" = 4 workers on this laptop
    with _SPARK_LOCK:
        if _SPARK["session"] is not None and _SPARK["master"] == master:
            return _SPARK["session"]                            # same settings -> reuse (no restart)
        if _SPARK["session"] is not None:
            _SPARK["session"].stop()                            # different worker count -> restart Spark
            _SPARK["session"] = None
        # Python workers must use the SAME interpreter as the driver
        _windows_hadoop_fix()
        os.environ["PYSPARK_PYTHON"] = sys.executable
        os.environ["PYSPARK_DRIVER_PYTHON"] = sys.executable
        root = str(config.ROOT)
        # workers must be able to "import vox" -> put the project folder on PYTHONPATH
        os.environ["PYTHONPATH"] = root + os.pathsep + os.environ.get("PYTHONPATH", "")
        b = (SparkSession.builder.appName("VOX-Distributed-ASR").master(master)
             .config("spark.driver.memory", config.SPARK_DRIVER_MEMORY)
             .config("spark.sql.execution.arrow.pyspark.enabled", "true")   # fast Java <-> Python transfer
             # small Arrow batches -> each mapInPandas call gets a few files
             .config("spark.sql.execution.arrow.maxRecordsPerBatch", "8")
             .config("spark.python.worker.reuse", "true")   # keep models warm
             .config("spark.ui.showConsoleProgress", "false")   # no progress bars in the console
             .config("spark.sql.shuffle.partitions", "8")
             .config("spark.executorEnv.PYTHONPATH", root))     # workers can import vox
        if master.startswith("local"):
            # stay on this machine (avoids network/firewall problems on Windows)
            b = b.config("spark.driver.host", "127.0.0.1").config("spark.driver.bindAddress", "127.0.0.1")
        # a session left over from a failed start would keep its old master
        stale = SparkSession.getActiveSession()
        if stale is not None:
            stale.stop()
        spark = b.getOrCreate()                    # starts the Java process (JVM) = the Spark driver
        try:
            spark.sparkContext.setLogLevel("ERROR")       # hide Spark's info/warning messages
            if not master.startswith("local"):
                # ship the code to remote executors; local workers already see it
                # through PYTHONPATH (and on Windows addPyFile needs Hadoop tools)
                spark.sparkContext.addPyFile(_package_zip())
        except Exception:
            spark.stop()
            raise
        _SPARK.update(session=spark, master=master)   # remember it for reuse
        return spark


def stop_spark():
    # Shut Spark down (end of a benchmark, or when the server closes).
    with _SPARK_LOCK:
        if _SPARK["session"] is not None:
            _SPARK["session"].stop()
            _SPARK.update(session=None, master=None)


# Result columns that hold text; all others hold numbers
STRING_COLS = {"id", "path", "reference", "hypothesis", "language", "ref_language",
               "worker", "error"}


def _result_schema():
    # Spark must know the output columns and their types BEFORE the job runs.
    from pyspark.sql.types import DoubleType, StringType, StructField, StructType
    return StructType([StructField(c, StringType() if c in STRING_COLS else DoubleType(), True)
                       for c in RESULT_COLUMNS])


class SparkEngine:
    name = "spark"

    def __init__(self, master: str | None = None, partitions: int | None = None):
        self.master = master or config.SPARK_MASTER     # "local[N]" or "spark://IP:7077"
        self.partitions = partitions                    # None = choose automatically

    def run(self, records, model_name, batch_size=8, trim=True, snr_db=None,
            progress=None, language=None, task="transcribe"):
        models.check_language(model_name, language, task)
        spark = get_spark(self.master)                  # start (or reuse) Spark
        sc = spark.sparkContext
        parallelism = sc.defaultParallelism             # number of worker slots (N in local[N])
        # Linux/macOS: Python workers are forked from a daemon and REUSED, so
        # 2 partitions per core gives better load balancing at no extra cost.
        # Windows has no fork(): every task starts a fresh Python process and
        # reloads the model, so we use exactly one partition per core there.
        per_core = 1 if os.name == "nt" else 2
        n_parts = self.partitions or min(len(records), max(1, parallelism * per_core))
        torch_threads = config.TORCH_THREADS_PER_TASK   # 1 PyTorch thread per worker

        # ---- the function every executor runs on its partition --------
        def transcribe_partition(batches):
            # Runs INSIDE each Spark Python worker. "batches" = pandas tables of up to 8 files.
            from vox import models as m
            from vox.pipeline import RESULT_COLUMNS as cols, process_records as proc
            import pandas as _pd
            m.set_torch_threads(torch_threads)
            for pdf in batches:
                recs = pdf.to_dict("records")                  # table -> list of dicts
                res = _pd.DataFrame(proc(recs, model_name, batch_size, trim, snr_db,
                                         language, task), columns=cols)   # run the kernel
                for c in cols:
                    if c not in STRING_COLS:
                        # make number columns real floats so they match the Spark schema
                        res[c] = _pd.to_numeric(res[c], errors="coerce").astype("float64")
                yield res                                      # send these result rows back to Spark

        pdf = pd.DataFrame(records)                             # manifest records -> pandas table
        if "language" not in pdf:
            pdf["language"] = ""
        pdf = pdf[["id", "path", "reference", "language"]].fillna("").astype(str)   # 4 text columns only
        df = spark.createDataFrame(pdf).repartition(n_parts)    # Spark DataFrame split into N partitions
        result = df.mapInPandas(transcribe_partition, schema=_result_schema())   # plan only (lazy)

        stop = threading.Event()
        if progress:
            def poll():
                # Every 0.5 s ask Spark how many tasks are finished -> website progress bar.
                tracker = sc.statusTracker()
                while not stop.is_set():
                    done = total = 0
                    for sid in tracker.getActiveStageIds():
                        info = tracker.getStageInfo(sid)
                        if info:
                            done += info.numCompletedTasks
                            total += info.numTasks
                    if total:
                        progress(done, total, unit="partitions")
                    time.sleep(0.5)
            threading.Thread(target=poll, daemon=True).start()

        t0 = time.perf_counter()                                # start the stopwatch
        sc.setJobDescription(f"VOX transcribe {len(records)} files with {model_name}")
        try:
            out = result.toPandas()      # action -> triggers the distributed job
        finally:
            stop.set()                   # stop the progress thread
        wall = time.perf_counter() - t0                         # wall time of the whole Spark job
        out["error"] = out["error"].where(out["error"].notna(), None)   # NaN -> None
        summary = summarize(out, wall, self.name, model_name, parallelism,
                            {"master": self.master, "partitions": n_parts}, language, task)
        if progress:
            progress(n_parts, n_parts, unit="partitions")       # show 100 %
        return out, summary                                     # (per-file table, run summary)
