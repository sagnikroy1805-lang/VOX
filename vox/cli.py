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
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime

from . import config


def _records(args):
    from . import datasets
    if getattr(args, "folder", None):
        recs = datasets.scan_folder(args.folder)
    else:
        recs = datasets.load_manifest(args.manifest or datasets.demo_manifest())
    if args.limit:
        recs = recs[: args.limit]
    if not recs:
        sys.exit("No audio files found.")
    return recs


def cmd_transcribe(args):
    import time
    from . import audio, models
    m = models.get_model(args.model)
    y, info = audio.preprocess(args.file)
    t0 = time.perf_counter()
    models.check_language(args.model, args.language, args.task)
    res = m.transcribe(y, args.language, args.task)
    print(json.dumps({"file": args.file, "model": args.model, "text": res["text"],
                      "language": res["language"], "task": args.task,
                      "audio_s": info["duration_s"],
                      "infer_s": round(time.perf_counter() - t0, 3)}, indent=2))


def cmd_batch(args):
    from .engines import LocalEngine, SparkEngine, stop_spark
    recs = _records(args)
    eng = SparkEngine(args.master, args.partitions) if args.engine == "spark" else LocalEngine()
    df, summary = eng.run(recs, args.model, args.batch_size, snr_db=args.snr,
                          language=args.language, task=args.task)
    out = args.out or config.RESULTS_DIR / f"batch_{datetime.now():%Y%m%d_%H%M%S}.csv"
    df.to_csv(out, index=False)
    if args.engine == "spark":
        stop_spark()
    print(json.dumps(summary, indent=2))
    print(f"\nPer-file results written to {out}")


def cmd_benchmark(args):
    from .benchmark import run_benchmark
    workers = [int(x) for x in args.workers.split(",")] if args.workers else None
    res = run_benchmark(_records(args), args.model, workers, not args.no_local, args.batch_size,
                        language=args.language)
    cols = ["engine", "workers", "wall_s", "rtfx", "speedup_vs_single", "efficiency", "wer"]
    print("\n" + " | ".join(f"{c:>17}" for c in cols))
    for r in res["runs"]:
        print(" | ".join(f"{str(r.get(c, '')):>17}" for c in cols))
    print(f"\nSaved to {res['saved_to']}")


def cmd_noise(args):
    from .benchmark import run_noise_sweep
    from .engines import stop_spark
    res = run_noise_sweep(_records(args), args.model, engine=args.engine,
                          language=args.language)
    stop_spark()
    for p in res["points"]:
        print(f"{p['label']:>8}  WER={p['wer']:.3f}  CER={p['cer']:.3f}")
    print(f"Saved to {res['saved_to']}")


def cmd_download(args):
    from . import datasets
    if args.which == "dummy":
        path = datasets.download_librispeech_dummy()
    elif args.which.startswith("fleurs-"):
        path = datasets.download_fleurs(args.which.split("-")[1], limit=args.limit or 100)
    else:
        path = datasets.download_librispeech(args.which, args.limit)
    print(f"Manifest written: {path}")


def cmd_prefetch(args):
    """Download + load models once so the first web request is fast."""
    from . import models
    for name in args.models:
        print(f"Loading {name} ...", flush=True)
        models.get_model(name)
        print(f"  ok ({models.LOAD_TIMES[name]:.1f}s)")


def cmd_serve(args):
    import uvicorn
    print(f"\n  VOX is running ->  http://127.0.0.1:{args.port}\n")
    uvicorn.run("web.app:app", host=args.host, port=args.port, log_level="warning")


def main(argv=None):
    p = argparse.ArgumentParser(prog="vox", description="VOX distributed speech-to-text")
    sub = p.add_subparsers(dest="cmd", required=True)

    def common(sp, engine=True):
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
    s.set_defaults(fn=cmd_transcribe)

    s = sub.add_parser("batch", help="transcribe many files (Spark or single-node)")
    common(s)
    s.add_argument("--master", default=config.SPARK_MASTER)
    s.add_argument("--partitions", type=int)
    s.add_argument("--snr", type=float, help="add white noise at this SNR (dB)")
    s.add_argument("--task", choices=["transcribe", "translate"], default="transcribe")
    s.add_argument("--out")
    s.set_defaults(fn=cmd_batch)

    s = sub.add_parser("benchmark", help="single-node vs Spark scalability benchmark")
    common(s, engine=False)
    s.add_argument("--workers", help="comma list, e.g. 1,2,4")
    s.add_argument("--no-local", action="store_true")
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

    args = p.parse_args(argv)
    args.fn(args)


if __name__ == "__main__":
    main()
