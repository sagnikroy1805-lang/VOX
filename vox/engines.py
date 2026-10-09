"""Execution engines.

LocalEngine  - single-node baseline: one Python process, files processed
               sequentially (the "no Spark" reference point).
SparkEngine  - distributed: the manifest becomes a Spark DataFrame, split into
               partitions, and every partition is processed by a Python worker
               through `mapInPandas` (a vectorised, Arrow-based pandas UDF).

Both call exactly the same `pipeline.process_records` kernel.
"""
from __future__ import annotations

import os
import shutil
import sys
import tempfile
import threading
import time
import zipfile
from pathlib import Path

import pandas as pd

from . import config, metrics, models
from .pipeline import RESULT_COLUMNS, process_records


def summarize(df: pd.DataFrame, wall_s: float, engine: str, model: str,
              workers: int, extra: dict | None = None, language=None,
              task="transcribe") -> dict:
    from .pipeline import score_language
    ok = df[df["error"].isna()] if "error" in df else df
    audio_s = float(ok["duration_s"].fillna(0).sum())
    rows = ok.to_dict("records")
    langs = [score_language(r, language, task) for r in rows]
    scores = metrics.corpus_scores(ok["reference"].fillna("").tolist(),
                                   ok["hypothesis"].fillna("").tolist(), langs)
    detected = ok["language"].dropna().value_counts().to_dict() if "language" in ok else {}
    s = {
        "engine": engine, "model": model, "workers": workers,
        "files": int(len(df)), "failed": int(len(df) - len(ok)),
        "audio_s": round(audio_s, 2), "wall_s": round(wall_s, 3),
        "files_per_s": round(len(df) / wall_s, 3) if wall_s else None,
        # RTFx: seconds of audio transcribed per second of wall-clock time
        "rtfx": round(audio_s / wall_s, 3) if wall_s else None,
        "preprocess_s_total": round(float(ok["preprocess_s"].fillna(0).sum()), 3),
        "infer_s_total": round(float(ok["infer_s"].fillna(0).sum()), 3),
        "model_load_s_total": round(float(df["model_load_s"].fillna(0).sum()), 3),
        "distinct_workers": int(df["worker"].nunique()),
        "language": language or "auto", "task": task,
        "detected_languages": {str(k): int(v) for k, v in detected.items()},
        **{k: (round(v, 4) if isinstance(v, float) else v) for k, v in scores.items()},
    }
    if extra:
        s.update(extra)
    return s


# =====================================================================
class LocalEngine:
    """Single process. threads=1 -> pure sequential baseline;
    threads=N -> PyTorch intra-op multithreading (a stronger baseline that
    uses all cores *inside* one model call instead of across files)."""

    def __init__(self, threads: int | None = None):
        self.threads = threads or config.TORCH_THREADS_PER_TASK
        self.name = "single-node" if self.threads == 1 else f"single-node-mt"

    def run(self, records, model_name, batch_size=8, trim=True, snr_db=None,
            progress=None, language=None, task="transcribe"):
        models.check_language(model_name, language, task)
        models.set_torch_threads(self.threads)
        t0 = time.perf_counter()
        out = []
        step = max(1, batch_size)
        for i in range(0, len(records), step):
            out += process_records(records[i:i + step], model_name, batch_size, trim, snr_db,
                                   language, task)
            if progress:
                progress(len(out), len(records))
        wall = time.perf_counter() - t0
        df = pd.DataFrame(out, columns=RESULT_COLUMNS)
        return df, summarize(df, wall, self.name, model_name, 1,
                             {"threads": self.threads}, language, task)


# =====================================================================
_SPARK = {"session": None, "master": None}
_SPARK_LOCK = threading.Lock()


def _package_zip() -> str:
    """Zip the `vox` package so Spark can ship it to remote executors."""
    src = Path(__file__).resolve().parent
    out = Path(tempfile.gettempdir()) / "vox_pkg.zip"
    with zipfile.ZipFile(out, "w") as z:
        for f in src.rglob("*.py"):
            z.write(f, f"vox/{f.relative_to(src).as_posix()}")
    return str(out)


def java_available() -> bool:
    if os.environ.get("JAVA_HOME") and Path(os.environ["JAVA_HOME"], "bin").exists():
        return True
    return shutil.which("java") is not None


def _windows_hadoop_fix():
    """Spark's Hadoop layer needs winutils.exe on Windows (HADOOP_HOME).

    VOX ships winutils.exe + hadoop.dll in VOX/hadoop/bin and points
    HADOOP_HOME there before the JVM starts. No-op on Linux/macOS.
    """
    if os.name != "nt":
        return
    home = config.ROOT / "hadoop"
    if (home / "bin" / "winutils.exe").exists():
        os.environ["HADOOP_HOME"] = str(home)
        os.environ["hadoop.home.dir"] = str(home)
        bin_dir = str(home / "bin")
        if bin_dir not in os.environ.get("PATH", ""):
            os.environ["PATH"] = bin_dir + os.pathsep + os.environ.get("PATH", "")


def get_spark(master: str | None = None):
    """Create (or reuse) the SparkSession. Changing `master` restarts Spark."""
    from pyspark.sql import SparkSession

    master = master or config.SPARK_MASTER
    with _SPARK_LOCK:
        if _SPARK["session"] is not None and _SPARK["master"] == master:
            return _SPARK["session"]
        if _SPARK["session"] is not None:
            _SPARK["session"].stop()
            _SPARK["session"] = None
        # Python workers must use the SAME interpreter as the driver
        _windows_hadoop_fix()
        os.environ["PYSPARK_PYTHON"] = sys.executable
        os.environ["PYSPARK_DRIVER_PYTHON"] = sys.executable
        root = str(config.ROOT)
        os.environ["PYTHONPATH"] = root + os.pathsep + os.environ.get("PYTHONPATH", "")
        b = (SparkSession.builder.appName("VOX-Distributed-ASR").master(master)
             .config("spark.driver.memory", config.SPARK_DRIVER_MEMORY)
             .config("spark.sql.execution.arrow.pyspark.enabled", "true")
             # small Arrow batches -> each mapInPandas call gets a few files
             .config("spark.sql.execution.arrow.maxRecordsPerBatch", "8")
             .config("spark.python.worker.reuse", "true")   # keep models warm
             .config("spark.ui.showConsoleProgress", "false")
             .config("spark.sql.shuffle.partitions", "8")
             .config("spark.executorEnv.PYTHONPATH", root))
        if master.startswith("local"):
            b = b.config("spark.driver.host", "127.0.0.1").config("spark.driver.bindAddress", "127.0.0.1")
        # a session left over from a failed start would keep its old master
        stale = SparkSession.getActiveSession()
        if stale is not None:
            stale.stop()
        spark = b.getOrCreate()
        try:
            spark.sparkContext.setLogLevel("ERROR")
            if not master.startswith("local"):
                # ship the code to remote executors; local workers already see it
                # through PYTHONPATH (and on Windows addPyFile needs Hadoop tools)
                spark.sparkContext.addPyFile(_package_zip())
        except Exception:
            spark.stop()
            raise
        _SPARK.update(session=spark, master=master)
        return spark


def stop_spark():
    with _SPARK_LOCK:
        if _SPARK["session"] is not None:
            _SPARK["session"].stop()
            _SPARK.update(session=None, master=None)


STRING_COLS = {"id", "path", "reference", "hypothesis", "language", "ref_language",
               "worker", "error"}


def _result_schema():
    from pyspark.sql.types import DoubleType, StringType, StructField, StructType
    return StructType([StructField(c, StringType() if c in STRING_COLS else DoubleType(), True)
                       for c in RESULT_COLUMNS])


class SparkEngine:
    name = "spark"

    def __init__(self, master: str | None = None, partitions: int | None = None):
        self.master = master or config.SPARK_MASTER
        self.partitions = partitions

    def run(self, records, model_name, batch_size=8, trim=True, snr_db=None,
            progress=None, language=None, task="transcribe"):
        models.check_language(model_name, language, task)
        spark = get_spark(self.master)
        sc = spark.sparkContext
        parallelism = sc.defaultParallelism
        # Linux/macOS: Python workers are forked from a daemon and REUSED, so
        # 2 partitions per core gives better load balancing at no extra cost.
        # Windows has no fork(): every task starts a fresh Python process and
        # reloads the model, so we use exactly one partition per core there.
        per_core = 1 if os.name == "nt" else 2
        n_parts = self.partitions or min(len(records), max(1, parallelism * per_core))
        torch_threads = config.TORCH_THREADS_PER_TASK

        # ---- the function every executor runs on its partition --------
        def transcribe_partition(batches):
            from vox import models as m
            from vox.pipeline import RESULT_COLUMNS as cols, process_records as proc
            import pandas as _pd
            m.set_torch_threads(torch_threads)
            for pdf in batches:
                recs = pdf.to_dict("records")
                res = _pd.DataFrame(proc(recs, model_name, batch_size, trim, snr_db,
                                         language, task), columns=cols)
                for c in cols:
                    if c not in STRING_COLS:
                        res[c] = _pd.to_numeric(res[c], errors="coerce").astype("float64")
                yield res

        pdf = pd.DataFrame(records)
        if "language" not in pdf:
            pdf["language"] = ""
        pdf = pdf[["id", "path", "reference", "language"]].fillna("").astype(str)
        df = spark.createDataFrame(pdf).repartition(n_parts)
        result = df.mapInPandas(transcribe_partition, schema=_result_schema())

        stop = threading.Event()
        if progress:
            def poll():
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

        t0 = time.perf_counter()
        sc.setJobDescription(f"VOX transcribe {len(records)} files with {model_name}")
        try:
            out = result.toPandas()      # action -> triggers the distributed job
        finally:
            stop.set()
        wall = time.perf_counter() - t0
        out["error"] = out["error"].where(out["error"].notna(), None)
        summary = summarize(out, wall, self.name, model_name, parallelism,
                            {"master": self.master, "partitions": n_parts}, language, task)
        if progress:
            progress(n_parts, n_parts, unit="partitions")
        return out, summary
