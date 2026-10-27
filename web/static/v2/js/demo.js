// Simulated VOX server for ?demo=1 previews. Same JSON shapes as web/app.py.
const MODELS = [
  ["whisper-tiny", "39M", ["en", "es", "ja"], true, "Transformer encoder-decoder (attention, seq2seq)", "openai/whisper-tiny"],
  ["whisper-base", "74M", ["en", "es", "ja"], true, "Transformer encoder-decoder (attention, seq2seq)", "openai/whisper-base"],
  ["whisper-small", "244M", ["en", "es", "ja"], true, "Transformer encoder-decoder (attention, seq2seq)", "openai/whisper-small"],
  ["wav2vec2-base", "95M", ["en"], false, "Self-supervised CNN+Transformer encoder with CTC head", "facebook/wav2vec2-base-960h"],
  ["wav2vec2-xlsr-es", "315M", ["es"], false, "XLSR-53 cross-lingual wav2vec 2.0 + CTC (Spanish)", "jonatasgrosman/wav2vec2-large-xlsr-53-spanish"],
  ["pocketsphinx", "~10M (GMM)", ["en"], false, "Classical HMM-GMM + 3-gram LM (non-deep baseline)", null],
].map(([name, params, langs, multilingual, arch, hf]) => ({ name, params, langs, multilingual, arch, hf, available: true, loaded: name === "whisper-tiny" }));

let DATASETS = [
  { name: "demo", path: "data/demo/manifest.csv", count: 40, languages: ["en"] },
  { name: "librispeech_test-clean", path: "data/librispeech_test-clean/manifest.csv", count: 200, languages: ["en"] },
  { name: "fleurs_es", path: "data/fleurs_es/manifest.csv", count: 100, languages: ["es"] },
];

const BENCH = {
  kind: "benchmark", model: "whisper-tiny", files: 40, language: "en", cpu_count: 8, created: "2026-10-13T19:13:31",
  runs: [
    { engine: "single-node", workers: 1, threads: 1, wall_s: 44.3, files_per_s: 0.9, rtfx: 3.54, speedup_vs_single: 1.0, efficiency: null, model_load_s_total: 1.9, wer: 0.075 },
    { engine: "single-node-mt", workers: 1, threads: 8, wall_s: 21.6, files_per_s: 1.85, rtfx: 7.25, speedup_vs_single: 2.05, efficiency: null, model_load_s_total: 1.9, wer: 0.075 },
    { engine: "spark", workers: 1, wall_s: 44.5, files_per_s: 0.9, rtfx: 3.52, speedup_vs_single: 0.995, efficiency: 1, model_load_s_total: 2.1, wer: 0.075 },
    { engine: "spark", workers: 2, wall_s: 26.5, files_per_s: 1.51, rtfx: 5.91, speedup_vs_single: 1.67, efficiency: 0.84, model_load_s_total: 4.3, wer: 0.075 },
    { engine: "spark", workers: 4, wall_s: 15.1, files_per_s: 2.65, rtfx: 10.4, speedup_vs_single: 2.93, efficiency: 0.74, model_load_s_total: 8.7, wer: 0.075 },
  ],
};
const NOISE = {
  kind: "noise", model: "pocketsphinx", engine: "spark", files: 40, language: "en", created: "2026-10-13T19:40:02",
  points: [
    { snr_db: null, label: "clean", wer: 0.865, cer: 0.609, wall_s: 20.4 },
    { snr_db: 20, label: "20 dB", wer: 0.862, cer: 0.568, wall_s: 20.9 },
    { snr_db: 10, label: "10 dB", wer: 0.913, cer: 0.673, wall_s: 21.3 },
    { snr_db: 5, label: "5 dB", wer: 0.913, cer: 0.724, wall_s: 21.0 },
    { snr_db: 0, label: "0 dB", wer: 0.965, cer: 0.834, wall_s: 21.8 },
  ],
};
let RESULTS = [NOISE, BENCH];
const JOBS = {};
const SENT = [
  "The birch canoe slid on the smooth planks.", "Glue the sheet to the dark blue background.",
  "It's easy to tell the depth of a well.", "These days a chicken leg is a rare dish.",
  "Rice is often served in round bowls.", "The juice of lemons makes fine punch.",
  "The box was thrown beside the parked truck.", "The hogs were fed chopped corn and garbage.",
];

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now() / 1000;

function wave(n = 600, seed = 1) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const env = Math.max(0, Math.sin((i / n) * Math.PI * 5 + seed)) * 0.7 + 0.08;
    out.push(+(env * (0.4 + 0.6 * Math.abs(Math.sin(i * 0.37 + seed * 3)))).toFixed(3));
  }
  return out;
}

function tick(job) {
  if (job.state === "done" || job.state === "error") return;
  const t = now() - job.created;
  if (t < 0.6) { job.state = "queued"; return; }
  if (!job.started) { job.started = job.created + 0.6; job.state = "running"; job.log.push(`[demo] Starting ${job.kind} job`); }
  const total = job.kind === "noise" ? 5 : job.kind === "benchmark" ? 5 : 40;
  const dur = job.kind === "download" ? 2 : 4.5;
  const done = Math.min(total, Math.floor(((t - 0.6) / dur) * total));
  job.progress = { label: job.kind === "noise" ? "noise" : job.kind === "benchmark" ? "runs" : "files", done, total };
  if (done % 7 === 0 && job.log.length < done / 7 + 2) job.log.push(`[demo] processed ${done}/${total}`);
  if (t - 0.6 >= dur) {
    job.state = "done"; job.finished = now();
    if (job.kind === "batch") {
      const lim = Math.min(job.params.limit || 40, 40);
      job.rows = Array.from({ length: lim }, (_, i) => {
        const ref = SENT[i % SENT.length], w = i % 9 === 0 ? 0.12 : i % 5 === 0 ? 0.06 : 0;
        return { id: `demo_${String(i).padStart(3, "0")}`, language: "en", reference: ref, hypothesis: w ? ref.replace(/\b(the|a)\b/i, "uh") : ref,
          wer: w, cer: w / 2, duration_s: 3.2 + (i % 4) * 0.6, infer_s: 0.6 + (i % 3) * 0.2, worker: `host:${4120 + (i % (job.params.workers || 4))}` };
      });
      job.summary = { files: lim, failed: 0, audio_s: lim * 3.9, wall_s: 15.1, rtfx: 10.4, wer: 0.031, cer: 0.014, engine: job.params.engine,
        master: job.params.engine === "spark" ? `local[${job.params.workers || 4}]` : "", detected_languages: { en: lim } };
    } else if (job.kind === "benchmark") { job.result = { ...BENCH, created: new Date().toISOString().slice(0, 19) }; RESULTS.unshift(job.result); }
    else if (job.kind === "noise") { job.result = { ...NOISE, model: job.params.model, created: new Date().toISOString().slice(0, 19) }; RESULTS.unshift(job.result); }
    else if (job.kind === "download") {
      const name = job.params.which.startsWith("fleurs") ? `fleurs_${job.params.which.slice(-2)}` : `librispeech_${job.params.which}`;
      const path = `data/${name}/manifest.csv`;
      if (!DATASETS.find((d) => d.path === path)) DATASETS.push({ name, path, count: 100, languages: [job.params.which.slice(-2) === "ja" ? "ja" : job.params.which.slice(-2) === "es" ? "es" : "en"] });
      job.result = { manifest: path };
    }
    job.log.push(`[demo] Done`);
  }
}

const pub = (j, rows = true) => {
  tick(j);
  const o = { ...j }; if (!rows) delete o.rows;
  if (j.started) o.elapsed_s = +(((j.finished || now()) - j.started)).toFixed(1);
  return o;
};

export async function demoFetch(path, opts = {}) {
  await sleep(120 + Math.random() * 160);
  const method = (opts.method || "GET").toUpperCase();
  if (path === "/api/status") {
    const busy = Object.values(JOBS).some((j) => (tick(j), j.state === "running" || j.state === "queued"));
    return json({ version: "demo", models: MODELS, default_model: "whisper-tiny", languages: { en: "English", es: "Spanish", ja: "Japanese" },
      java: true, spark_master: "local[*]", spark_running: true, cpu_count: 8, worker_options: [1, 2, 4, 8], datasets: DATASETS, busy });
  }
  if (path === "/api/results") return json(RESULTS);
  if (path === "/api/jobs" && method === "GET") return json(Object.values(JOBS).sort((a, b) => b.created - a.created).map((j) => pub(j, false)));
  let m = path.match(/^\/api\/jobs\/(batch|benchmark|noise|download)$/);
  if (m && method === "POST") {
    const params = JSON.parse(opts.body || "{}");
    const id = Math.random().toString(16).slice(2, 12);
    JOBS[id] = { id, kind: m[1], params, state: "queued", progress: { label: "", done: 0, total: 0 }, log: [], created: now(), started: null,
      finished: null, summary: null, result: null, rows: null, error: null };
    return json({ id });
  }
  m = path.match(/^\/api\/jobs\/([a-z0-9]+)$/);
  if (m) return JOBS[m[1]] ? json(pub(JOBS[m[1]])) : json({ detail: "no such job" }, 404);
  if (path === "/api/upload") { const p = "data/uploads/upload_demo/manifest.csv"; if (!DATASETS.find((d) => d.path === p)) DATASETS.push({ name: "upload_demo", path: p, count: 3, languages: ["en"] }); return json({ manifest: p, count: 3, name: "upload_demo" }); }
  if (path === "/api/transcribe") {
    await sleep(1100);
    const fd = opts.body, ref = (fd && fd.get && fd.get("reference")) || "";
    const text = "The birch canoe slid on the smooth planks.";
    const res = { filename: "demo.wav", model: (fd && fd.get && fd.get("model")) || "whisper-tiny", text, language: "en", language_name: "English",
      requested_language: (fd && fd.get && fd.get("language")) || "auto", task: (fd && fd.get && fd.get("task")) || "transcribe",
      info: { duration_s: 3.62, processed_s: 2.91 }, timing: { preprocess_s: 0.04, model_load_s: 0, inference_s: 0.41, rtfx: 8.83 },
      waveform_raw: wave(600, 1), waveform: wave(600, 1.4), words: 8 };
    if (ref.trim()) {
      res.scores = { wer: 0.125, cer: 0.05, S: 1, D: 0, I: 0, N: 8, H: 7, ref_norm: ref.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, "").trim(),
        hyp_norm: text.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ""), unit: "word", score_language: "en" };
    }
    return json(res);
  }
  return json({ detail: "not found (demo)" }, 404);
}
