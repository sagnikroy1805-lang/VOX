# VOX — Distributed Speech-to-Text Transcription System

**Apache Spark + pretrained deep-learning ASR models (Whisper / wav2vec 2.0)**
ML Project (DA1) — Aaratrik Paul · Sagnik Roy · Kumar Chandramani · Divyanshu Kumar

VOX implements the methodology proposed in the DA1 review report:

| Report requirement | Where it lives |
|---|---|
| Spark-parallel audio preprocessing (resampling, silence trimming, feature extraction) | `vox/audio.py`, run inside Spark tasks by `vox/engines.py` |
| Distributed inference of a pretrained ASR model (Whisper or wav2vec2) via Spark UDFs | `vox/models.py` + `SparkEngine` (`mapInPandas`) in `vox/engines.py` |
| Evaluation on LibriSpeech / Common Voice with WER and CER | `vox/metrics.py`, `vox/datasets.py` |
| Runtime comparison: distributed vs single-node | `vox/benchmark.py` (`run_benchmark`) |
| Noise-robustness (research gap 3) | `vox/benchmark.py` (`run_noise_sweep`) |
| Usable front end | `web/` — the **VOX** website |

---

## 1. Quick start (Windows)

```
git clone https://github.com/sagnikroy1805-lang/VOX.git
cd VOX
```
(or download the ZIP from GitHub and extract it)


1. Double-click **`setup_windows.bat`** (once, ~10 min, needs internet).
   It creates `env\` with Python 3.11 + Java 17 (via your Anaconda), installs the
   packages, downloads Whisper-tiny + wav2vec2 and a 73-utterance LibriSpeech sample.
2. Double-click **`run_vox.bat`** → the browser opens **http://127.0.0.1:8000**.
3. Optional: **`run_benchmark.bat`** runs every experiment from the command line,
   **`run_tests.bat`** runs the test-suite.

No Anaconda? Install Python 3.11 from python.org and Java 17
(`winget install EclipseAdoptium.Temurin.17.JDK`), then run `setup_windows.bat`.

### Linux / macOS
```bash
python3.11 -m venv env && source env/bin/activate
pip install -r requirements.txt          # Java 17 must be installed
python -m vox.cli prefetch && python -m vox.cli download dummy
python -m vox.cli serve                  # http://127.0.0.1:8000
```

## 2. The website

Minimal light/dark design (follows your system theme, toggle in the header). Tailwind CSS is bundled, so it also works offline.

| Tab | What it does |
|---|---|
| **Transcribe** | Upload or record → transcript in English, Spanish or Japanese (auto-detected) or translated to English; timing, RTFx, optional WER/CER with word/character alignment, raw vs processed waveform. |
| **Batch** | Transcribe a whole dataset on Spark (choose workers) or single-node. Shows corpus WER/CER, throughput, how files were spread over Spark Python workers, per-file table, CSV export. Download LibriSpeech or upload your own files here. |
| **Benchmark** | Single-node (1 thread), single-node (multithreaded PyTorch) and Spark × 1, 2, 4 … workers on the same data. Wall time, RTFx, speed-up, parallel efficiency chart. |
| **Robustness** | WER/CER as white noise is added at 20, 10, 5, 0 dB SNR. |
| **Architecture** | Pipeline diagram and model table. |

## 3. Command line

```bash
python -m vox.cli transcribe data/samples/harvard_00.flac --model whisper-tiny
python -m vox.cli batch --manifest data/librispeech_dummy/manifest.csv --engine spark --master local[4]
python -m vox.cli batch --folder "D:/my_audio" --engine local
python -m vox.cli benchmark --manifest data/librispeech_dummy/manifest.csv --workers 1,2,4
python -m vox.cli noise --manifest data/librispeech_dummy/manifest.csv
python -m vox.cli download test-clean --limit 500
```

Models: `whisper-tiny` (default), `whisper-base`, `whisper-small` (English, Spanish, Japanese),
`wav2vec2-base` (English), `wav2vec2-xlsr-es` (Spanish), `wav2vec2-xlsr-ja` (Japanese), `pocketsphinx` (English).

Languages: `--language en|es|ja` (omit to auto-detect) and `--task translate` for speech → English.
Multilingual test data: `python -m vox.cli download fleurs-es` / `fleurs-ja` (Google FLEURS, 100 clips each).

## 4. Running on a real multi-machine Spark cluster

The code is cluster-ready — only the master URL changes.
On one laptop: `spark-class org.apache.spark.deploy.master.Master` → note `spark://IP:7077`.
On each other laptop: `spark-class org.apache.spark.deploy.worker.Worker spark://IP:7077`.
Then `set VOX_SPARK_MASTER=spark://IP:7077` and run VOX as usual. Audio files must be
reachable at the same path on every machine (shared folder / HDFS / S3) and every
machine needs the same Python environment. The `vox` package is shipped to executors
automatically (`addPyFile`).

## 5. Project layout

```
VOX/
├─ vox/
│  ├─ config.py      settings (env-var overridable)
│  ├─ audio.py       preprocessing + log-mel feature extraction (numpy/scipy)
│  ├─ models.py      Whisper / wav2vec2 / PocketSphinx backends, per-process cache
│  ├─ metrics.py     text normalisation, Levenshtein WER / CER
│  ├─ pipeline.py    the kernel: preprocess → batch inference → score
│  ├─ engines.py     LocalEngine (baseline) and SparkEngine (mapInPandas)
│  ├─ benchmark.py   scalability benchmark + noise sweep
│  ├─ datasets.py    manifests, LibriSpeech download, folder scan
│  └─ cli.py         command-line interface
├─ web/app.py        FastAPI backend          web/static/  VOX front end
├─ data/samples*/    demo clips: 40 English, 10 Spanish, 10 Japanese (synthetic)
├─ results/          benchmark / noise JSON + CSV
├─ tests/            pytest suite (16 tests)
├─ ANALYSIS.md       in-depth project analysis + viva Q&A
└─ *.bat             Windows setup / run scripts
```

## 6. Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `VOX_SPARK_MASTER` | `local[*]` | Spark master URL |
| `VOX_DEFAULT_MODEL` | `whisper-tiny` | model pre-selected in the UI |
| `VOX_TORCH_THREADS` | `1` | PyTorch threads per Spark task |
| `VOX_SPARK_DRIVER_MEMORY` | `4g` | driver JVM memory |

## 7. Troubleshooting

* **"Java / Spark missing" chip** – Spark needs Java 17. Re-run `setup_windows.bat` or install Temurin 17.
* **First transcription is slow** – the model is downloaded/loaded once, then cached.
* **`HADOOP_HOME` / `winutils.exe` errors on Windows** – Spark's Hadoop layer needs `winutils.exe`. VOX ships it in `hadoop/bin` (from the widely used [cdarlint/winutils](https://github.com/cdarlint/winutils), Hadoop 3.3.6 build) and sets `HADOOP_HOME` automatically.
* **Out of memory** – use fewer Spark workers or `whisper-tiny`.
