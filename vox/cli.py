"""VOX command-line interface.

Examples
    python -m vox.cli transcribe data/samples/harvard_00.flac
    python -m vox.cli batch --manifest data/samples/manifest.csv --engine spark
    python -m vox.cli benchmark --manifest data/librispeech_dummy/manifest.csv --workers 1,2,4
    python -m vox.cli noise --manifest data/librispeech_dummy/manifest.csv
    python -m vox.cli transcribe clip.wav --language ja
    python -m vox.cli transcribe clip.wav --task translate      # any language -> English
    python -m vox.cli batch --manifest data/samples_es/manifest.csv --language es
    python -m vox.cli download dummy
    python -m vox.cli download test-clean --limit 200
    python -m vox.cli serve --port 8000
"""
# WHAT THIS FILE DOES: the second "front door" to VOX (the website is the first).
# Each command calls the SAME functions the website uses, so results match.
# The .bat files are thin wrappers around these commands.

from __future__ import annotations

import argparse              # turns command-line words into arguments
import json                  # print results as JSON
import sys
from datetime import datetime

from . import config


def _records(args):
    # Get the list of files to process: from --folder, or from --manifest (default: demo samples).
    from . import datasets
    if getattr(args, "folder", None):
        recs = datasets.scan_folder(args.folder)          # any folder of audio files
    else:
        recs = datasets.load_manifest(args.manifest or datasets.demo_manifest())
    if args.limit:
        recs = recs[: args.limit]                         # only the first N files
    if not recs:
        sys.exit("No audio files found.")
    return recs


def cmd_transcribe(args):
    # "transcribe FILE": one file -> text (same path as the Transcribe tab, no Spark)
    import time
    from . import audio, models
    m = models.get_model(args.model)                      # load the model
    y, info = audio.preprocess(args.file)                 # stage 1: clean the audio
    t0 = time.perf_counter()
    models.check_language(args.model, args.language, args.task)
    res = m.transcribe(y, args.language, args.task)       # stage 2: speech -> text
    print(json.dumps({"file": args.file, "model": args.model, "text": res["text"],
                      "language": res["language"], "task": args.task,
                      "audio_s": info["duration_s"],
                      "infer_s": round(time.perf_counter() - t0, 3)}, indent=2))


def cmd_batch(args):
    # "batch": a whole dataset on Spark (default) or single-node; per-file CSV saved in results/
    from .engines import LocalEngine, SparkEngine, stop_spark
    recs = _records(args)
    eng = SparkEngine(args.master, args.partitions) if args.engine == "spark" else LocalEngine()
    df, summary = eng.run(recs, args.model, args.batch_size, snr_db=args.snr,
                          language=args.language, task=args.task)
    out = args.out or config.RESULTS_DIR / f"batch_{datetime.now():%Y%m%d_%H%M%S}.csv"
    df.to_csv(out, index=False)                           # one row per file
    if args.engine == "spark":
        stop_spark()
    print(json.dumps(summary, indent=2))                  # WER, RTFx, wall time ...
    print(f"\nPer-file results written to {out}")


def cmd_benchmark(args):
    # "benchmark": the scalability experiment (benchmark.run_benchmark)
    from .benchmark import run_benchmark
    workers = [int(x) for x in args.workers.split(",")] if args.workers else None   # "1,2,4" -> [1, 2, 4]
    res = run_benchmark(_records(args), args.model, workers, not args.no_local, args.batch_size,
                        language=args.language)
    cols = ["engine", "workers", "wall_s", "rtfx", "speedup_vs_single", "efficiency", "wer"]
    print("\n" + " | ".join(f"{c:>17}" for c in cols))   # table header
    for r in res["runs"]:
        print(" | ".join(f"{str(r.get(c, '')):>17}" for c in cols))   # one line per configuration
    print(f"\nSaved to {res['saved_to']}")


def cmd_noise(args):
    # "noise": the robustness experiment (WER/CER at clean, 20, 10, 5, 0 dB)
    from .benchmark import run_noise_sweep
    from .engines import stop_spark
    res = run_noise_sweep(_records(args), args.model, engine=args.engine,
                          language=args.language)
    stop_spark()
    for p in res["points"]:
        print(f"{p['label']:>8}  WER={p['wer']:.3f}  CER={p['cer']:.3f}")
    print(f"Saved to {res['saved_to']}")


def cmd_download(args):
    # "download": fetch a dataset into data/ and write its manifest.csv
    from . import datasets
    if args.which == "dummy":
        path = datasets.download_librispeech_dummy()
    elif args.which.startswith("fleurs-"):
        path = datasets.download_fleurs(args.which.split("-")[1], limit=args.limit or 100)   # "fleurs-es" -> "es"
    else:
        path = datasets.download_librispeech(args.which, args.limit)   # test-clean / dev-clean / test-other
    print(f"Manifest written: {path}")


def cmd_prefetch(args):
    """Download + load models once so the first web request is fast."""
    from . import models
    for name in args.models:
        print(f"Loading {name} ...", flush=True)
        models.get_model(name)                            # downloads into models_cache/ on first use
        print(f"  ok ({models.LOAD_TIMES[name]:.1f}s)")


def cmd_serve(args):
    # "serve": start the website (uvicorn runs the FastAPI app in web/app.py)
    import uvicorn
    print(f"\n  VOX is running ->  http://127.0.0.1:{args.port}\n")
    uvicorn.run("web.app:app", host=args.host, port=args.port, log_level="warning")


def main(argv=None):
    # Define every command and its options, then run the matching cmd_* function.
    p = argparse.ArgumentParser(prog="vox", description="VOX distributed speech-to-text")
    sub = p.add_subparsers(dest="cmd", required=True)    # a command word is required

    def common(sp, engine=True):
        # options shared by batch / benchmark / noise
        sp.add_argument("--manifest")
        sp.add_argument("--folder")
        sp.add_argument("--limit", type=int)
        sp.add_argument("--model", default=config.DEFAULT_MODEL)
        sp.add_argument("--batch-size", type=int, default=8)
        sp.add_argument("--language", choices=["en", "es", "ja"],
                        help="spoken language (default: auto-detect with Whisper)")
        if engine:
            sp.add_argument("--engine", choices=["spark", "local"], default="spark")

    s = sub.add_parser("transcribe", help="transcribe one audio file")
    s.add_argument("file")
    s.add_argument("--model", default=config.DEFAULT_MODEL)
    s.add_argument("--language", choices=["en", "es", "ja"])
    s.add_argument("--task", choices=["transcribe", "translate"], default="transcribe")
    s.set_defaults(fn=cmd_transcribe)                     # which function this command runs

    s = sub.add_parser("batch", help="transcribe many files (Spark or single-node)")
    common(s)
    s.add_argument("--master", default=config.SPARK_MASTER)   # e.g. local[4]
    s.add_argument("--partitions", type=int)
    s.add_argument("--snr", type=float, help="add white noise at this SNR (dB)")
    s.add_argument("--task", choices=["transcribe", "translate"], default="transcribe")
    s.add_argument("--out")
    s.set_defaults(fn=cmd_batch)

    s = sub.add_parser("benchmark", help="single-node vs Spark scalability benchmark")
    common(s, engine=False)
    s.add_argument("--workers", help="comma list, e.g. 1,2,4")
    s.add_argument("--no-local", action="store_true")    # skip the single-node baselines
    s.set_defaults(fn=cmd_benchmark)

    s = sub.add_parser("noise", help="WER vs SNR robustness sweep")
    common(s)
    s.set_defaults(fn=cmd_noise)

    s = sub.add_parser("download", help="download LibriSpeech")
    s.add_argument("which", choices=["dummy", "test-clean", "dev-clean", "test-other",
                                       "fleurs-es", "fleurs-ja"])
    s.add_argument("--limit", type=int)
    s.set_defaults(fn=cmd_download)

    s = sub.add_parser("prefetch", help="download pretrained models in advance")
    s.add_argument("models", nargs="*", default=["whisper-tiny", "wav2vec2-base"])
    s.set_defaults(fn=cmd_prefetch)

    s = sub.add_parser("serve", help="start the VOX website")
    s.add_argument("--host", default="127.0.0.1")
    s.add_argument("--port", type=int, default=8000)
    s.set_defaults(fn=cmd_serve)

    args = p.parse_args(argv)     # read what the user typed
    args.fn(args)                 # run the chosen command


if __name__ == "__main__":
    # runs when started as "python -m vox.cli ..."
    main()
