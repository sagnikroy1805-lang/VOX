# VOX — In-Depth Project Analysis & Viva Guide

**Distributed Speech-to-Text Transcription System Using Apache Spark and Pretrained Deep Learning Models**
Aaratrik Paul (24BAI1156) · Sagnik Roy (24BAI1565) · Kumar Chandramani (24BAI1504) · Divyanshu Kumar (24BAI1568)

---

## 0. The project in one paragraph (say this first in the viva)

VOX is a speech-to-text system that transcribes large collections of audio by splitting the work across many CPU cores (or many machines) with **Apache Spark**. Every audio file becomes one row of a Spark DataFrame. Spark cuts the DataFrame into **partitions**, and each partition is sent to a separate **Python worker** that (1) preprocesses the audio — decode, resample to 16 kHz, trim silence, normalise, extract log-mel features — and (2) runs a **pretrained deep-learning ASR model** (OpenAI **Whisper** or Meta **wav2vec 2.0**) on it, then (3) scores the result with **WER and CER** against reference transcripts. We compare this against a **single-node** run of exactly the same code to measure **speed-up and parallel efficiency**, and we test **noise robustness** by adding noise at controlled SNRs. Everything is wrapped in a web application called **VOX** with upload, microphone recording, batch jobs, benchmarks and visualisations.

---

## 1. Why this project exists (link to our DA1 review)

Our literature review found four gaps; VOX addresses each one:

| Gap from DA1 report | How VOX addresses it |
|---|---|
| ASR papers evaluate accuracy in isolation, ignoring the systems engineering of deploying at scale | VOX is an end-to-end system: data → distributed preprocessing → distributed inference → evaluation → UI |
| Spark is well studied for tabular data and general DL (BigDL), but rarely for audio preprocessing + ASR inference | Audio preprocessing and Whisper/wav2vec2 inference run *inside* Spark tasks (`mapInPandas`) |
| Noise-robust ASR is rarely evaluated together with distributed processing | The **Robustness** experiment adds noise at 20/10/5/0 dB *inside the Spark pipeline* and measures WER/CER |
| Few studies report runtime/throughput of distributed vs single-node ASR | The **Benchmark** experiment measures wall time, RTFx, speed-up and efficiency for single-node vs Spark ×1, ×2, ×4… |

Our methodology section promised: *"use Apache Spark to parallelize audio preprocessing (resampling, silence trimming, feature extraction) and to distribute inference of a pretrained ASR model (Whisper or wav2vec2.0) across partitions via Spark UDFs … evaluated on LibriSpeech using WER and CER, with a runtime comparison between distributed and single-node processing."* Every item of that sentence is implemented.

---

## 2. Architecture

```
                         ┌──────────────────────── Spark cluster (local[*] or spark://…) ───────────────────────┐
 manifest.csv            │  DRIVER (JVM + Python)                     EXECUTORS → Python worker processes        │
 (id, path, reference)   │                                                                                       │
 ──────────────────────► │  spark.createDataFrame(manifest)           ┌─ worker 1 ─────────────────────────────┐ │
                         │        │                                   │ for each Arrow batch of rows:          │ │
 VOX website / CLI ────► │  .repartition(N)  ── partitions ─────────► │   decode → resample 16k → trim → norm  │ │
                         │        │                                   │   → (noise) → log-mel features         │ │
                         │  .mapInPandas(transcribe_partition)        │   → ASR model (loaded ONCE per worker) │ │
                         │        │   (lazy – nothing runs yet)       │   → WER / CER                          │ │
                         │  .toPandas()  ◄── ACTION triggers the job  └────────────────────────────────────────┘ │
                         │        │                                   ┌─ worker 2 … worker N (same code) ──────┐ │
                         └────────┼──────────────────────────────────────────────────────────────────────────────┘
                                  ▼
                   results DataFrame → corpus WER/CER, RTFx, speed-up → JSON/CSV → VOX charts
```

### 2.1 Code map

| File | Responsibility |
|---|---|
| `vox/audio.py` | Preprocessing + feature extraction (pure numpy/scipy) |
| `vox/models.py` | Whisper / wav2vec2 / PocketSphinx wrappers, per-process model cache, long-audio chunking |
| `vox/metrics.py` | Text normalisation, Levenshtein alignment, WER, CER, corpus scores |
| `vox/pipeline.py` | **The kernel** `process_records()` — preprocess → batched inference → score. Used by both engines |
| `vox/engines.py` | `LocalEngine` (single-node baseline) and `SparkEngine` (distributed) |
| `vox/benchmark.py` | Scalability benchmark + noise sweep, saves JSON/CSV |
| `vox/datasets.py` | Manifests, LibriSpeech download (HF sample / OpenSLR), folder scanning |
| `vox/cli.py` | Command-line interface |
| `web/app.py` | FastAPI backend: REST API, background job queue |
| `web/static/*` | VOX front-end (HTML/CSS/JS, no frameworks) |
| `tests/test_vox.py` | 13 automated tests (metrics vs jiwer, DSP correctness, Spark == single-node) |

**Key design principle:** the *same* function `process_records` runs in both engines, so the benchmark compares only the *execution strategy* (sequential vs distributed), never two different implementations. A test (`test_spark_equals_single_node`) proves both engines produce identical transcripts.

---

## 3. Stage 1 — Audio preprocessing (in depth)

All of this runs inside each Spark task, in parallel, on each file.

### 3.1 Decoding
`soundfile` (libsndfile) reads WAV/FLAC/OGG/MP3 into float32 samples in [-1, 1]. Stereo is **down-mixed** to mono by averaging channels. If libsndfile can't read a format (m4a, webm), we fall back to `ffmpeg`. In the website, the **browser** itself decodes any format and re-encodes it to 16 kHz mono WAV before upload (Web Audio API `OfflineAudioContext`), so the server always receives clean WAV — including microphone recordings.

### 3.2 Resampling to 16 kHz
**Why 16 kHz?** Speech energy is mostly below 8 kHz; by Nyquist, 16 kHz sampling captures up to 8 kHz. Whisper and wav2vec2 were both trained on 16 kHz audio, so input must match.
**How:** `scipy.signal.resample_poly(y, up, down)` with up/down = target/source divided by their GCD (44100→16000 is up 160, down 441). Polyphase resampling = upsample by inserting zeros, apply a low-pass **anti-aliasing FIR filter**, downsample. The filter removes frequencies above the new Nyquist (8 kHz) — without it, high frequencies would "fold back" (alias) into the speech band as distortion.

### 3.3 Silence trimming (energy-based VAD)
1. Split into 25 ms frames (400 samples) with 10 ms hop (160 samples).
2. Frame RMS energy → decibels relative to the loudest frame: `dB = 20·log10(rms / max_rms)`.
3. Frames above **−35 dB** are "voiced"; keep everything from the first to the last voiced frame.
**Why:** leading/trailing silence costs compute (inference time scales with length) and can make Whisper hallucinate text on silence. On our demo set, trimming removed ~1.2 s per file (≈30%).

### 3.4 Peak normalisation
Scale so the max absolute sample = 0.95. Makes loud/quiet recordings comparable and avoids clipping.

### 3.5 Optional noise injection (robustness experiment)
White Gaussian noise with power chosen to hit a target **SNR**:
`SNR_dB = 10·log10(P_signal / P_noise)  ⇒  P_noise = P_signal / 10^(SNR/10)`.
At 20 dB noise power is 1% of the signal; at 0 dB it equals the signal. The random seed is derived from the file ID (CRC32) so the *same* noise is added whichever worker processes the file — results are reproducible across engines.

### 3.6 Feature extraction: log-mel spectrogram
1. **Framing + Hann window** (25 ms / 10 ms) — speech is roughly stationary over ~25 ms; the window tapers frame edges to reduce spectral leakage.
2. **FFT** (400-point) → power spectrum `|X(f)|²` per frame, 201 frequency bins (resolution 40 Hz).
3. **Mel filterbank** — 80 triangular filters equally spaced on the **mel scale** `mel = 2595·log10(1 + f/700)`, which mimics human hearing (fine resolution at low frequencies, coarse at high). We evaluate filters at exact FFT frequencies (Slaney-style) so none are empty.
4. **log10** — loudness perception is logarithmic and the log compresses dynamic range.
Result: an 80 × T matrix (T = 100 frames per second). This is exactly the input format Whisper uses (80 mel bins, 25 ms, 10 ms). VOX stores summary statistics (mean, std, RMS dB, speech ratio) per file in every result row (they appear in the CSV export).

*Teacher may ask: "Is the model using your features?"* — Our feature extractor produces the same representation for analysis/visualisation and per-file descriptors. Each pretrained model also has its own built-in front-end that must exactly match its training (Whisper's `WhisperFeatureExtractor` computes its own log-mel; wav2vec2 takes the **raw waveform** and learns its own features with a CNN). Feeding a model features computed differently from its training would degrade accuracy, so we give each model the preprocessed *waveform* and let it compute its expected input.

---

## 4. Stage 2 — The ASR models (in depth)

| Model | Architecture | Params | Training data | Decoding | Expected LibriSpeech test-clean WER* |
|---|---|---|---|---|---|
| **whisper-tiny** (default) | Transformer encoder–decoder (attention, seq2seq) | 39 M | 680k h weakly-supervised, multilingual | autoregressive, greedy | ≈ 7–8 % |
| whisper-base | same, larger | 74 M | same | same | ≈ 5 % |
| whisper-small | same, larger | 244 M | same | same | ≈ 3–3.5 % |
| **wav2vec2-base-960h** | CNN feature encoder + Transformer + CTC head | 95 M | self-supervised on 960 h unlabeled, fine-tuned on 960 h labeled | greedy CTC | ≈ 3.4 % (no LM) |
| **pocketsphinx** | Classical HMM–GMM + 3-gram LM | ~10 M | WSJ/broadcast-era corpora | Viterbi beam search | ≈ 20–30 % (much worse) |

*Published figures, approximate; **report the numbers you measure yourself** with `run_benchmark.bat`.

### 4.1 Whisper (attention-based encoder–decoder — "AED" in Prabhavalkar et al.'s survey)
- Input: 30-second window of 80-bin log-mel (shorter audio is zero-padded to 30 s; longer audio VOX splits into 30 s chunks and joins the text).
- **Encoder:** 2 conv layers (downsample ×2) + sinusoidal positional encoding + Transformer blocks (self-attention + feed-forward) → acoustic representation.
- **Decoder:** Transformer that generates text tokens one at a time (autoregressive), attending to encoder output via **cross-attention**. Special prompt tokens set the task: `<|startoftranscript|><|en|><|transcribe|><|notimestamps|>`.
- Trained on 680,000 hours of diverse internet audio with "weak" (imperfect) transcripts → robust to accents and noise, outputs punctuation and casing.
- Weakness: can **hallucinate** text on silence/noise (one reason we trim silence).

### 4.2 wav2vec 2.0 (self-supervised learning + CTC)
- **Feature encoder:** 7-layer 1-D CNN over the raw waveform → one vector every 20 ms.
- **Context network:** Transformer over those vectors.
- **Pre-training (self-supervised, no labels):** spans of latent features are masked; the model must identify the true **quantised** latent among distractors (contrastive loss). It learns speech structure from unlabeled audio — this is why our review (Jain et al., child speech) highlights that it works with little labeled data.
- **Fine-tuning:** a linear layer predicts characters per 20 ms frame, trained with **CTC loss**.
- **CTC (Connectionist Temporal Classification):** adds a *blank* token, sums probability over all alignments of the label sequence to the frames, so no frame-level alignment is needed. Greedy decoding: take argmax per frame, collapse repeats, remove blanks ("hh_e_ll_lo" → "hello").
- Non-autoregressive → fast; but no built-in language model, outputs uppercase letters without punctuation.

### 4.3 PocketSphinx (classical baseline)
MFCC features → **Hidden Markov Models** of context-dependent phones (triphones) with **Gaussian Mixture Model** emission probabilities → pronunciation dictionary → trigram language model → Viterbi beam search. This is the "pre-deep-learning" HMM-GMM pipeline that our introduction describes; it is included (a) to *demonstrate* the jump in accuracy deep learning gives and (b) because it runs fully offline with no download. Implementation detail: PocketSphinx adapts its cepstral mean normalisation (CMN) across utterances, which made transcripts depend on *file order* — and therefore on how Spark partitioned the data. VOX resets the feature state per file (`reinit_feat()`) so results are deterministic; we found and fixed this via our Spark-vs-single-node equality test.

### 4.4 Why not RNN-Transducer (RNN-T)?
Our review covers RNN-T (Li et al., Saon et al., Sainath et al.) — it is the dominant **streaming** on-device architecture. Our task is **offline batch** transcription, where full-context models (Whisper, wav2vec2) are more accurate and freely available pretrained. RNN-T is the natural choice for the future streaming extension (Section 10).

### 4.5 Batched inference & model caching
- Inside a partition, files are processed in batches of 8: waveforms are padded and stacked into one tensor → one forward pass → better CPU vectorisation than 8 separate calls.
- `models.get_model()` keeps a per-process cache: a Spark Python worker **loads the model once** and reuses it for every batch/partition it processes. The load time is recorded (`model_load_s`) so the benchmark shows this overhead explicitly.

---

## 5. Stage 3 — Distribution with Apache Spark (in depth)

### 5.1 Spark concepts used
- **Driver:** the process running our program; builds the plan and schedules tasks.
- **Executors:** JVM processes that run tasks. For Python code, each executor launches **Python worker processes**.
- **DataFrame:** distributed table with a schema. Ours: `(id, path, reference)`.
- **Partition:** a chunk of rows; **one task processes one partition**. Number of partitions = unit of parallelism.
- **Lazy evaluation:** `repartition` and `mapInPandas` are *transformations* — they only build a plan (DAG). `toPandas()` is an *action* that actually runs the job.
- **local[N]:** Spark runs driver + N executor threads on one machine — a real Spark scheduler, used for development and our benchmark. Changing the master to `spark://host:7077` runs the identical code on a multi-machine cluster.

### 5.2 Why `mapInPandas` (a vectorised pandas UDF)?
| Option | Verdict |
|---|---|
| Row-at-a-time Python UDF (`@udf`) | Pickles each row separately; we'd need tricks to load the model once; slow |
| `pandas_udf` (Series → Series) | Vectorised, but returns one column; we need ~18 output columns |
| **`mapInPandas(fn, schema)`** | Receives an **iterator of pandas DataFrames** per partition → load model once, process in batches, yield a multi-column DataFrame. Data moves JVM↔Python via **Apache Arrow** (columnar, zero-copy-ish) |
| RDD `mapPartitions` | Works, but loses DataFrame schema/Arrow optimisations |
| BigDL / Spark MLlib | MLlib has no ASR models; BigDL (Dai et al.) needs its own model format — we use standard HuggingFace PyTorch models directly |

`spark.sql.execution.arrow.maxRecordsPerBatch = 8` means each pandas batch handed to our function holds ≤8 files.

### 5.3 Why we ship *file paths*, not audio bytes
Rows contain only paths; each worker reads audio from disk itself. Shipping raw audio through the driver would make the driver a bottleneck and hit memory limits. On a cluster, paths must be on shared storage (NFS / HDFS / S3) — the standard Spark pattern of *moving computation to data*.

### 5.4 Why load the model in the worker instead of broadcasting it?
A `broadcast` variable is serialised by the driver and deserialised in every task. A PyTorch model is large (150 MB–1 GB) and pickling it is slow and fragile. Loading from the local HuggingFace cache inside each worker, once, and caching it in a module-level variable is the standard pattern for DL inference on Spark.

### 5.5 Partitioning and thread settings (performance decisions)
- **Partitions:** 2 per core on Linux/macOS (better load balancing: if one partition has longer files, others pick up the slack), **1 per core on Windows**: Windows has no `fork()`, so PySpark cannot reuse its Python worker daemon and each task starts a fresh Python process — which would reload the model per task. One partition per core ⇒ one model load per core.
- **`torch.set_num_threads(1)` per task:** with N Spark tasks each using M PyTorch threads, you'd have N×M threads competing for N cores → **oversubscription** (context switching, cache thrashing). Data parallelism across files (Spark) replaces intra-op parallelism (PyTorch threads). The benchmark also includes a **single-node multithreaded** run so we can compare the two parallelism strategies honestly.
- `spark.python.worker.reuse = true` keeps Python workers (and their loaded models) alive between tasks.

### 5.6 Fault tolerance
- **Spark level:** if a task fails (e.g., executor crash), Spark re-runs that partition from its lineage (default 4 attempts). Other partitions are unaffected.
- **Application level:** a corrupt or unreadable file must not kill a 10,000-file job — `process_records` catches per-file exceptions, records them in the `error` column, and continues. Tested in `test_pipeline_handles_bad_file`.

### 5.7 Collecting results
`toPandas()` brings results (text + numbers, a few KB per file) to the driver, where corpus metrics are computed and CSV/JSON written. On a large cluster you would instead `df.write.parquet("hdfs://…")`. We avoid writing through Hadoop on Windows because that needs `winutils.exe`.

### 5.8 Progress monitoring
The web app polls Spark's `StatusTracker` (active stages → completed vs total tasks) every 0.5 s to drive the progress bar.

---

## 6. Evaluation metrics (in depth)

### 6.1 Word Error Rate
`WER = (S + D + I) / N` — substitutions, deletions, insertions needed to turn the hypothesis into the reference, divided by the number of reference words. Computed with the **Levenshtein edit-distance dynamic programme** (`vox/metrics.py`, `edit_ops`):

`d[i][j] = d[i-1][j-1]` if words match, else `1 + min(d[i-1][j-1] (sub), d[i-1][j] (del), d[i][j-1] (ins))` — O(n·m) time.

Example: ref "the cat sat on the mat", hyp "the cat sat on mat" → 1 deletion / 6 words = 16.7 %.
WER can exceed 100 % (many insertions). The Transcribe page shows the alignment with colour-coded S/D/I.

### 6.2 Character Error Rate
Same formula over characters. More forgiving for near-misses ("colour" vs "color") and the standard for languages without clear word boundaries.

### 6.3 Text normalisation (critical!)
Whisper outputs "Mr. Smith paid $5, didn't he?" while LibriSpeech references are "MISTER SMITH PAID FIVE DOLLARS DIDN'T HE". Without normalisation, punctuation and case alone would count as errors. VOX lowercases, expands Mr/Mrs/Dr, converts numbers to words, strips punctuation (keeping apostrophes), collapses spaces — applied identically to reference and hypothesis.

### 6.4 Corpus WER vs average WER
VOX reports **corpus WER = total errors / total reference words** (standard in LibriSpeech papers), not the mean of per-file WERs, which would over-weight short utterances.

### 6.5 Speed metrics
- **Wall time:** end-to-end job time including Python worker start-up and model loading (the honest number).
- **RTFx (inverse real-time factor)** = seconds of audio / seconds of processing. RTFx 10 = one hour of audio in 6 minutes.
- **Speed-up** S = T_single / T_parallel.
- **Parallel efficiency** E = S / workers (relative to Spark×1). 100 % = perfect linear scaling.
- **Amdahl's law:** S(N) = 1 / ((1 − p) + p/N). The serial fraction (Spark/JVM start-up, driver scheduling, model loading, collecting results) caps the speed-up. That's why larger datasets show better efficiency: the fixed overhead is amortised.

---

## 7. Experiments and results

### 7.1 Datasets
- **`data/samples`** — 40 synthetic utterances (IEEE Harvard sentences, generated with the espeak-ng speech synthesiser, 22.05 kHz, mixed WAV/FLAC, with 0.6 s silence padding). Purpose: a self-contained demo that exercises resampling, trimming and format handling. **Not** a fair accuracy benchmark — robotic synthetic voices are out-of-domain for every model.
- **LibriSpeech** (Panayotov et al., 2015) — read English audiobooks, 16 kHz FLAC, the standard ASR benchmark. `download dummy` fetches 73 real utterances (~9 MB); `download test-clean --limit N` streams the official test set from OpenSLR. **Use LibriSpeech numbers in your report.**
- **Common Voice** (crowd-sourced, many accents/microphones) — supported via `--folder` / manifests; download needs a Mozilla account.

### 7.2 Results from our development run (verification environment)
Machine: 2-core Linux VM, PocketSphinx model (whisper weights could not be downloaded in that sandbox), 40 demo files (156.6 s of audio):

| Run | Wall time | RTFx | Speed-up vs single | Efficiency | WER |
|---|---|---|---|---|---|
| Single-node (1 thread) | 36.07 s | 4.34× | 1.00× | — | 86.5 % |
| Spark local[1] | 39.90 s | 3.93× | 0.90× | 100 % | 86.5 % |
| Spark local[2] | 20.41 s | 7.68× | **1.77×** | **97.8 %** | 86.5 % |

**How to interpret (great viva material):**
1. **Spark×1 is ~10 % slower than plain Python.** That's Spark's overhead: JVM↔Python serialisation via Arrow, launching Python workers, scheduling. Distribution only pays off with ≥2 workers.
2. **Spark×2 is 1.77× faster than single-node and 1.96× faster than Spark×1 (efficiency 97.8 %).** ASR inference is "embarrassingly parallel": files are independent, so there is no communication between tasks and scaling is near-linear until cores run out.
3. **WER is identical across all three** — distribution changes *speed*, never *accuracy*. (We proved transcripts are bit-identical.)
4. The 86.5 % WER is PocketSphinx on synthetic robotic speech — expected to be bad. It illustrates why deep models replaced HMM-GMM systems.

### 7.3 What you should run and report (on your own laptop)
Run `run_benchmark.bat` (or the website tabs) and fill in:

| Experiment | Expected pattern |
|---|---|
| Accuracy on LibriSpeech sample: whisper-tiny vs wav2vec2-base vs pocketsphinx | wav2vec2 ≈ 3–5 %, whisper-tiny ≈ 6–10 %, pocketsphinx ≈ 20–35 % WER |
| Benchmark whisper-tiny: 1 thread, MT, Spark ×1/×2/×4/×8 | Near-linear speed-up up to the number of **physical** cores, then flattening (hyper-threads share execution units; memory bandwidth; Amdahl) |
| Noise sweep: clean, 20, 10, 5, 0 dB | WER rises slowly to 10 dB, sharply at 5 and 0 dB. Whisper usually degrades more gracefully than wav2vec2-base (trained on diverse, noisy data) |

Likely observation on **single-node multithreaded vs Spark**: PyTorch's internal multithreading speeds up a single forward pass, but efficiency drops quickly (small matrices, synchronisation per layer). Spark's data parallelism (one file per core) usually wins for many short files — this is a key finding to state.

Memory note: each Spark worker holds its own copy of the model (whisper-tiny ≈ 150 MB RAM, small ≈ 1 GB), so RAM, not just cores, limits worker count for big models.

---

## 7A. Multilingual extension — Japanese and Spanish

### What was added
| Piece | Implementation |
|---|---|
| Language choice | Auto-detect, English, Spanish (Español), Japanese (日本語) — on the Transcribe and Batch pages, `--language` on the CLI |
| Language identification | Whisper's built-in language ID: one decoder step scores the 99 language tokens (`<\|en\|>`, `<\|es\|>`, `<\|ja\|>` …) from the encoder output; the best one is used as the prompt for decoding. Files in a batch are grouped by detected language. |
| Speech translation | `task="translate"`: Whisper outputs **English text directly from Spanish/Japanese speech** (no separate MT model). Scored against an English reference. |
| Language-specific models | `wav2vec2-xlsr-es`, `wav2vec2-xlsr-ja`: XLSR-53 (wav2vec 2.0 pre-trained on 56k h in 53 languages) fine-tuned with CTC on Common Voice Spanish / Japanese. ~1.2 GB each, downloaded on first use. |
| Datasets | Google **FLEURS** (`es_419`, `ja_jp`) — the multilingual benchmark used in the Whisper paper — streamed from the HuggingFace Hub (100 utterances by default); plus 10 synthetic demo clips per language in `data/samples_es`, `data/samples_ja`. |
| Language-aware evaluation | see below |
| Guard rails | English-only models (wav2vec2-base, PocketSphinx) are rejected for es/ja with a clear message. |

### Why evaluation must change per language
- **Spanish** is space-delimited, so WER works as usual — but normalisation must **keep accents** (`está` ≠ `esta`, `año` ≠ `ano`) and drop Spanish punctuation `¿ ¡`. Our English normaliser would have deleted every accented letter, so it is language-aware now.
- **Japanese has no spaces between words**, so "WER" over whitespace tokens is meaningless (a whole sentence would be one "word"). The standard practice is to report **character error rate (CER)**; VOX computes the error rate over characters for `ja`.
- **Script mismatch:** the same word can be written in kanji, hiragana or katakana (`天気` = `てんき`). A correct transcript in a different script would count as wrong. VOX converts both reference and hypothesis to **hiragana readings** with `pykakasi` before scoring (kana-normalised CER). Limitation: some kanji have several readings (`今日` → きょう / こんにち), which can introduce a small number of false errors.
- NFKC normalisation folds full-width characters (`ＡＢＣ１２３`) to their normal forms.

### What to expect
Whisper's accuracy depends strongly on model size for non-English. Published FLEURS results: Spanish is one of Whisper's best languages (low single-digit WER for small/medium), Japanese CER is markedly better with `whisper-base`/`small` than `tiny`. **VOX shows a tip recommending whisper-base or small for Japanese.** Measure and report your own numbers with the FLEURS buttons on the Batch page.

### Viva questions on the multilingual part
45. **How does Whisper know which language is spoken?** Its decoder is trained to predict a language token right after `<|startoftranscript|>`. We run that single step (`detect_language`) and take the most probable language token.
46. **Why can't you use WER for Japanese?** Japanese is written without spaces, so there are no whitespace-delimited words; segmentation into words is itself ambiguous. Character-level error rate is the standard metric.
47. **Why convert to hiragana before scoring?** Kanji and kana spell the same word differently; without a common script, correct output in another script would be penalised.
48. **Translate vs transcribe?** Transcribe keeps the source language; translate makes Whisper output English text directly — speech translation in one model.
49. **What is XLSR-53?** wav2vec 2.0 pre-trained self-supervised on 53 languages at once, so it learns shared speech units across languages; fine-tuning on a small labelled set in one language (Common Voice) gives a strong monolingual recogniser — the cross-lingual transfer idea from our literature review (Nowakowski et al.).
50. **Does the Spark part change for other languages?** No — the language is just a parameter passed to every worker; partitioning, batching and fault tolerance are identical.

---

## 8. The VOX web application

- **Backend:** FastAPI (Python). Single-file transcription runs synchronously; long jobs (batch, benchmark, noise sweep, dataset download) run on a one-thread background queue so two Spark jobs never fight over cores; the browser polls `/api/jobs/{id}`.
- **Frontend:** plain HTML/JavaScript styled with **Tailwind CSS v4** (bundled locally so the site works offline), minimal design with light and dark themes (follows the system setting; toggle in the header). Charts drawn as SVG, waveform on `<canvas>`, word/character alignment computed in JS (same Levenshtein algorithm).
- **Microphone:** `MediaRecorder` → browser decodes and resamples to 16 kHz WAV → upload.
- **API endpoints:** `/api/status`, `/api/transcribe`, `/api/upload`, `/api/jobs/{batch|benchmark|noise|download}`, `/api/jobs/{id}`, `/api/jobs/{id}/csv`, `/api/results`.

---

## 9. Testing & verification
`run_tests.bat` → 16 tests:
- WER/CER match the reference library **jiwer** on 4 cases; S/D/I counts correct; normalisation correct.
- Resampling produces the right length; trimming removes 1 s of padding from a tone; noise injection achieves the requested SNR within 0.3 dB; log-mel shape is 80×98 for 1 s with no empty filters.
- Corrupt file → error recorded, job continues.
- **Spark output == single-node output** (identical transcripts).
- Spanish normalisation keeps accents; Japanese is scored per character with kanji→kana; English-only models are rejected for es/ja.

---

## 10. Limitations and future work
1. **Single machine in our tests** — `local[N]` uses a real Spark scheduler, but true cluster runs (network, shared storage) are the next step; code needs only the master URL changed.
2. **Batch, not streaming** — a Kafka → Spark Structured Streaming → model pipeline (Dai et al.'s BigDL architecture from our review) would enable live captioning; RNN-T models suit streaming.
3. **CPU only** in our runs — GPUs give 10–50× faster inference; Spark 3+ supports GPU-aware scheduling (`spark.task.resource.gpu.amount`).
4. **Fixed 30 s chunking** can cut a word at the boundary; VAD-based segmentation with overlap would fix it.
5. **Greedy decoding, no external LM** — beam search + n-gram LM fusion would lower wav2vec2's WER.
6. **Three languages, no fine-tuning** — fine-tuning on accented/child/low-resource speech (gaps in our review: Jain et al., Nowakowski et al.) is a natural extension; the same Spark pipeline could prepare training data.
7. **Synthetic white noise** — real noise (babble, street; e.g., MUSAN) is more realistic.

---

## 11. Demo script for the viva (5 minutes)
1. `run_vox.bat` → show the header chips (Java/Spark ready, CPU cores).
2. **Transcribe:** record "The quick brown fox jumps over the lazy dog", type it as reference → show transcript, WER, coloured alignment, waveform before/after trimming. Repeat with noise SNR 0 dB to show degradation. Then switch the language to Auto and say a sentence in Spanish or play a Japanese clip from `data/samples_ja` (use whisper-base) — VOX detects the language; switch Output to *Translate to English* to show speech translation.
3. **Batch:** LibriSpeech sample, whisper-tiny, Spark, max workers → point out *work distribution* (files per worker PID = proof of parallelism), corpus WER, RTFx, CSV export.
4. **Benchmark:** show the chart from a run done beforehand (it takes several minutes) → explain overhead at ×1, near-linear scaling, efficiency, Amdahl.
5. **Robustness:** WER vs SNR curve.
6. **Architecture tab:** walk through the diagram.
7. Optional: open `http://localhost:4040` (Spark UI) while a batch runs to show stages/tasks/executors.

---

## 12. Viva questions & answers

**Concept & motivation**

1. **Why do you need Spark for speech-to-text at all?** A single machine processes files one at a time; transcribing 10,000 hours with whisper-small on one CPU at RTFx ≈ 2 would take ~5,000 hours. Files are independent, so we split them across cores/machines. Spark gives partitioning, scheduling, fault tolerance and cluster scaling without writing that infrastructure ourselves.

2. **What does "embarrassingly parallel" mean here?** Each file can be transcribed without information from any other file — no communication between tasks, no shuffle. That's why we get near-linear speed-up.

3. **Is this training or inference?** Inference (and preprocessing). We use pretrained models. Training Whisper needs hundreds of GPUs; our contribution is the scalable inference + evaluation system, as stated in our methodology.

4. **Where is the "machine learning" in your project?** The ASR models are deep neural networks (Transformers, CNN, CTC, self-supervised learning); we select, apply and evaluate them (WER/CER, robustness), plus the classical HMM-GMM baseline for comparison. The distributed systems part addresses the scaling gap identified in our review.

**Spark**

5. **What is a partition and how did you choose the number?** A chunk of DataFrame rows processed by one task. 2 per core on Linux (load balancing), 1 per core on Windows (no worker reuse → avoid reloading the model per task).

6. **Difference between transformation and action?** Transformations (`repartition`, `mapInPandas`) are lazy — they build a DAG. Actions (`toPandas`, `count`, `write`) trigger execution. Spark can optimise the whole plan before running.

7. **Why mapInPandas and not a normal UDF?** Normal UDFs process one row at a time with pickle serialisation. `mapInPandas` gives an iterator of pandas DataFrames per partition via Arrow, so we load the model once and batch inference.

8. **What is Apache Arrow?** A columnar in-memory format shared between JVM and Python, avoiding expensive row-by-row serialisation.

9. **How is the model distributed to workers?** It isn't serialised from the driver; each Python worker loads it from the local HuggingFace cache on first use and caches it in a module-level dictionary.

10. **What happens if a worker crashes?** Spark re-schedules the failed partition (up to 4 attempts) using lineage. A bad audio file is handled inside our code — logged in the `error` column, job continues.

11. **Why is Spark×1 slower than plain Python?** Fixed overhead: Python worker launch, Arrow serialisation, scheduling, and (on Windows) process spawning. It only pays off with ≥2 workers or large data.

12. **What limits the speed-up?** Number of physical cores, RAM (one model copy per worker), memory bandwidth, the serial part of the job (Amdahl's law), and uneven partition durations (stragglers).

13. **Why `torch.set_num_threads(1)`?** To avoid oversubscription: N Spark tasks × M PyTorch threads > N cores causes contention. We parallelise across files instead of inside one matrix multiply.

14. **How would you run on a real cluster?** Start a Spark master and workers, put audio on shared storage, install the same Python env on every node, set `VOX_SPARK_MASTER=spark://host:7077`. The `vox` package is shipped to executors with `addPyFile`.

15. **Why not Hadoop MapReduce?** MapReduce writes intermediate results to disk between stages; Spark keeps data in memory and has a richer API (DataFrames, Arrow UDFs). Sewal & Singh in our review report up to 100× speed-ups for iterative jobs. For our single-stage job the main gains are the Python/Arrow integration and lower latency.

16. **Why not BigDL?** BigDL requires models in its own framework; we wanted standard HuggingFace PyTorch models (Whisper/wav2vec2) with no conversion. We follow BigDL's *architecture pattern* (data on Spark, model inference in executors).

**Audio & features**

17. **Why resample to 16 kHz?** The models were trained at 16 kHz; speech information is mostly below 8 kHz (Nyquist).

18. **What is aliasing and how do you prevent it?** When downsampling, frequencies above the new Nyquist fold into lower frequencies as distortion. `resample_poly` applies a low-pass FIR filter before decimation.

19. **What is a mel spectrogram and why log?** Power spectrum per 25 ms frame, pooled into 80 triangular filters on the mel (perceptual) scale; log compresses dynamic range and matches loudness perception.

20. **Why 25 ms window and 10 ms hop?** Speech is quasi-stationary over 20–30 ms; 10 ms hop gives 100 frames/s, enough temporal resolution for phonemes. These are Whisper's settings.

21. **How does silence trimming work?** Frame-level RMS energy in dB relative to the loudest frame; keep from first to last frame above −35 dB.

22. **What is SNR?** Signal-to-noise ratio in dB, `10·log10(P_signal/P_noise)`. 0 dB means noise as loud as speech.

**Models**

23. **Explain Whisper.** Transformer encoder–decoder; encoder processes 30 s of log-mel, decoder generates text tokens autoregressively using cross-attention; trained on 680k hours of weakly-labelled multilingual audio; outputs punctuation.

24. **Explain wav2vec 2.0.** CNN encodes raw audio into 20 ms latent vectors, Transformer adds context. Pre-trained self-supervised by masking latents and solving a contrastive task against quantised targets; fine-tuned with CTC to output characters.

25. **What is CTC?** A loss for sequence labelling without alignment: adds a blank symbol and sums over all alignments of the label sequence to the frames. Decoding = argmax per frame, merge repeats, drop blanks.

26. **Whisper vs wav2vec2 — which is better?** On clean read speech (LibriSpeech), wav2vec2-base-960h (fine-tuned *on LibriSpeech*) often has lower WER than whisper-tiny. Whisper generalises better across domains/noise/accents and outputs punctuation; larger Whisper models beat both. wav2vec2 is non-autoregressive, so typically faster per second of audio.

27. **What is the difference between CTC, attention encoder-decoder and RNN-T?** CTC: frame-wise independent predictions, no LM inside, fast. AED (Whisper): decoder conditions on previous tokens → implicit LM, but needs full input (not streaming). RNN-T: adds a prediction network + joint network, conditions on previous tokens *and* is streamable — used on-device (Sainath et al.).

28. **Why include PocketSphinx?** As a classical HMM-GMM baseline, to quantify the improvement of deep learning, and as a fully offline fallback.

29. **Why does PocketSphinx score so badly on the demo samples?** Synthetic espeak voices and its older acoustic model; it also lacks the massive training data of modern models.

30. **What is "hallucination" in Whisper?** Because the decoder is a language model, on silence or noise it can generate fluent but non-existent text. Trimming silence mitigates it.

31. **How do you handle audio longer than 30 seconds?** Split into 30 s chunks, transcribe chunks as a batch, concatenate the texts. Limitation: words cut at chunk boundaries.

**Evaluation**

32. **Define WER and CER. Can WER exceed 100 %?** (S+D+I)/N over words / characters. Yes — insertions are unbounded.

33. **How do you compute S, D, I?** Levenshtein dynamic programming; we implemented it ourselves and verified against `jiwer`.

34. **Why normalise text before WER?** Casing, punctuation and number formats differ between model output and references; they are not recognition errors.

35. **Why corpus WER instead of average WER?** Per-file averaging gives a 3-word utterance the same weight as a 40-word one; corpus WER weights by length (standard practice).

36. **What is RTFx?** Audio duration ÷ processing time. >1 means faster than real time.

37. **What is parallel efficiency?** Speed-up ÷ number of workers. 100 % = perfect linear scaling.

38. **Does distribution change accuracy?** No. Same model, same preprocessing, deterministic noise seeds → identical transcripts (verified by an automated test). Only speed changes.

39. **What is Amdahl's law?** Max speed-up with N workers is `1/((1−p)+p/N)` where p is the parallelisable fraction; serial overhead caps scaling.

**Engineering**

40. **How does the web app avoid blocking during long jobs?** Jobs run on a background thread; the API returns a job ID; the browser polls for progress, reading Spark's StatusTracker.

41. **Why one job at a time?** Spark already uses all cores within a job; running two jobs simultaneously would make them compete and invalidate benchmark timings.

42. **How is reproducibility ensured?** Fixed manifests, deterministic noise seeds (CRC32 of file ID), deterministic decoding (greedy), results saved as JSON/CSV with timestamps and machine info, automated tests.

43. **What would you change for production?** GPU inference, cluster deployment with shared storage, streaming ingestion (Kafka), authentication on the web app, writing results to Parquet/a database, VAD-based segmentation, model quantisation (int8) for faster CPU inference.

44. **What was the hardest bug?** PocketSphinx's adaptive CMN made transcripts depend on file order → Spark and single-node gave different output. Found by our equality test, fixed by resetting the decoder's feature state per utterance. Also Windows has no `fork()`, so PySpark can't reuse workers there — we use one partition per core on Windows.

---

## 13. Glossary
**ASR** automatic speech recognition · **WER/CER** word/character error rate · **SNR** signal-to-noise ratio · **RTFx** inverse real-time factor · **CTC** connectionist temporal classification · **AED** attention encoder–decoder · **RNN-T** recurrent neural network transducer · **HMM-GMM** hidden Markov model with Gaussian mixture emissions · **MFCC** mel-frequency cepstral coefficients · **STFT/FFT** (short-time) fast Fourier transform · **VAD** voice activity detection · **DAG** directed acyclic graph (Spark execution plan) · **UDF** user-defined function · **Arrow** columnar in-memory data format · **Driver/Executor** Spark coordinator / worker processes · **Partition** chunk of data processed by one task.

## 14. References used in the implementation
- Radford et al., "Robust Speech Recognition via Large-Scale Weak Supervision" (Whisper), 2022.
- Baevski et al., "wav2vec 2.0: A Framework for Self-Supervised Learning of Speech Representations", NeurIPS 2020.
- Graves et al., "Connectionist Temporal Classification", ICML 2006.
- Panayotov et al., "LibriSpeech: an ASR corpus based on public domain audio books", ICASSP 2015.
- Zaharia et al., "Resilient Distributed Datasets", NSDI 2012; Apache Spark documentation (pandas UDFs / `mapInPandas`).
- Dai et al., "BigDL", SoCC 2019 — architectural pattern for DL inference on Spark (from our DA1 review).
- Prabhavalkar et al., "End-to-End Speech Recognition: A Survey", 2024 (from our DA1 review).
