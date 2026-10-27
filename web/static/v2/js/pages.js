// All page behaviour: Dashboard, Transcribe, Batch, Benchmark, Robustness, How it works.
// Same API calls as the original VOX front-end, restyled with the pink tokens.
import { api, postJSON } from "./api.js?v=3";
import { $, $$, fmt, pct, esc, tile, toast, setStatus, LANG, CODE } from "./ui.js?v=3";
import { TOKENS } from "./tokens.js?v=3";

const C = TOKENS.color;
let STATUS = null;
let HIST = [];
let busyCount = 0;
const redraw = {};          // charts to redraw on resize, keyed by name

function busy(on) {
  busyCount = Math.max(0, busyCount + (on ? 1 : -1));
  refreshDot();
}
function refreshDot() {
  if (!STATUS) return setStatus("bad", "Server not reachable");
  if (busyCount > 0 || STATUS.busy) return setStatus("busy", "Working…");
  setStatus(STATUS.java ? "ok" : "bad", STATUS.java ? `Spark ready · ${STATUS.cpu_count} cores` : "Spark needs Java");
}

/* --------------------------------------------------------- segmented controls */
const seg = (id) => $(`#${id} button.on`)?.dataset.v ?? "";
function initSegs() {
  $$(".seg").forEach((g) => g.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    e.preventDefault();
    $$("button", g).forEach((x) => x.classList.toggle("on", x === b));
    g.dispatchEvent(new Event("change"));
  }));
}

/* ------------------------------------------------------------------- status */
export async function loadStatus(keepSelection = true) {
  try { STATUS = await api("/api/status"); }
  catch (e) { STATUS = null; refreshDot(); $("#dEyebrow").textContent = "Server not reachable — start run_vox.bat"; throw e; }
  refreshDot();
  const avail = STATUS.models.filter((m) => m.available);
  $$(".modelSel").forEach((sel) => {
    const prev = sel.value;
    sel.innerHTML = STATUS.models.map((m) =>
      `<option value="${m.name}" ${m.available ? "" : "disabled"}>${m.name} · ${m.params} · ${m.langs.map((l) => CODE[l]).join("/")}${m.available ? "" : " (not installed)"}</option>`).join("");
    const def = avail.find((m) => m.name === STATUS.default_model) ? STATUS.default_model : (avail[0] || {}).name;
    sel.value = keepSelection && prev && avail.find((m) => m.name === prev) ? prev : def;
  });
  $$(".dataSel").forEach((sel) => {
    const prev = sel.value;
    sel.innerHTML = STATUS.datasets.map((d) =>
      `<option value="${esc(d.path)}">${esc(d.name)} · ${d.count} files · ${(d.languages || ["en"]).map((l) => CODE[l] || l).join("/")}</option>`).join("");
    if (keepSelection && prev && STATUS.datasets.find((d) => d.path === prev)) sel.value = prev;
  });
  const w = STATUS.worker_options || [1];
  const bw = $("#bWorkers"), prevW = bw.value;
  bw.innerHTML = w.map((n) => `<option value="${n}">${n}</option>`).join("");
  bw.value = prevW && w.includes(+prevW) ? prevW : w[w.length - 1];
  if (!$("#kWorkers").children.length)
    $("#kWorkers").innerHTML = w.map((n) => `<label class="chip"><input type="checkbox" value="${n}" checked>${n}</label>`).join("");
  $("#mTable").innerHTML = `<tr><th>Model</th><th>Languages</th><th>Architecture</th><th>Params</th><th>Source</th><th>Status</th></tr>` +
    STATUS.models.map((m) => `<tr><td class="mono">${m.name}</td><td style="white-space:nowrap">${m.langs.map((l) => CODE[l]).join(" · ")}</td><td>${esc(m.arch)}</td><td class="num">${m.params}</td><td class="mono muted" style="font-size:12px">${m.hf || "bundled, offline"}</td><td class="${m.available ? "pos" : "neg"}">${m.available ? (m.loaded ? "loaded" : "ready") : "not installed"}</td></tr>`).join("");
  renderDashStatus();
  langHint();
}

/* ================================================================ DASHBOARD */
function renderDashStatus() {
  if (!STATUS) return;
  const avail = STATUS.models.filter((m) => m.available).length;
  const files = STATUS.datasets.reduce((a, d) => a + d.count, 0);
  $("#dSpark").innerHTML = STATUS.java ? `<span class="grad">Ready</span>` : `<span class="neg">No Java</span>`;
  $("#dSparkSub").textContent = STATUS.spark_running ? `session up · ${STATUS.spark_master}` : `${STATUS.spark_master} · starts on first job`;
  $("#dCores").textContent = STATUS.cpu_count;
  $("#dModels").innerHTML = `${avail}<small>/ ${STATUS.models.length}</small>`;
  $("#dModelsSub").textContent = `default ${STATUS.default_model}`;
  $("#dData").innerHTML = `${STATUS.datasets.length}<small>${files} files</small>`;
  $("#dDataSub").textContent = STATUS.datasets.slice(0, 3).map((d) => d.name).join(" · ") || "download one on the Batch page";
  $("#dEyebrow").textContent = `${STATUS.java ? "Spark ready" : "Spark needs Java"} · ${STATUS.cpu_count} cores · ${STATUS.busy ? "working" : "idle"}`;
}

const runLabel = (r) => (r.engine === "single-node" ? "1 thread" : r.engine === "single-node-mt" ? `${r.threads} threads` : `Spark ×${r.workers}`);

function renderDashBench() {
  const b = HIST.find((h) => h.kind === "benchmark");
  if (!b) { $("#dBench").innerHTML = `<div class="empty">No benchmark saved yet.</div>`; return; }
  const max = Math.max(...b.runs.map((r) => r.speedup_vs_single || 0), 1);
  $("#dBenchSub").textContent = `${b.model} · ${b.files} files · ${b.cpu_count} cores · ${String(b.created).replace("T", " ")}`;
  $("#dBench").innerHTML = `<div class="spark-bars">${b.runs.map((r) =>
    `<div class="col"><div class="val">${fmt(r.speedup_vs_single, 2)}×</div><div class="bar-v" style="height:${Math.max(4, (100 * (r.speedup_vs_single || 0)) / max) * 0.72}%"></div><div class="lab">${runLabel(r)}</div></div>`).join("")}</div>`;
}

export async function refreshDashboard() {
  try {
    const jobs = await api("/api/jobs");
    $("#dJobs").innerHTML = jobs.length ? jobs.slice(0, 5).map((j) => {
      const p = j.params || {}, label = { batch: "Batch", benchmark: "Benchmark", noise: "SNR sweep", download: "Download" }[j.kind] || j.kind;
      const meta = j.kind === "download" ? p.which : `${p.model || ""}${p.limit ? ` · ${p.limit} files` : ""}${j.elapsed_s ? ` · ${j.elapsed_s}s` : ""}`;
      return `<div class="job"><div class="ic">${label.slice(0, 2).toUpperCase()}</div><div><div class="n">${label}</div><div class="m">${esc(meta)}</div></div><span class="state ${j.state}">${j.state}</span></div>`;
    }).join("") : `<div class="empty">No jobs yet — run a batch to see it here.</div>`;
  } catch (_) { /* server offline: keep previous */ }
  renderDashStatus();
  renderDashBench();
}

/* =============================================================== TRANSCRIBE */
let currentBlob = null, currentName = "";

async function toWav16k(blob) {
  const buf = await blob.arrayBuffer();
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const decoded = await ctx.decodeAudioData(buf.slice(0));
  ctx.close();
  const sr = 16000, len = Math.max(1, Math.ceil(decoded.duration * sr));
  const off = new OfflineAudioContext(1, len, sr);
  const src = off.createBufferSource(); src.buffer = decoded; src.connect(off.destination); src.start();
  const pcm = (await off.startRendering()).getChannelData(0);
  const out = new DataView(new ArrayBuffer(44 + pcm.length * 2));
  const w = (o, s) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF"); out.setUint32(4, 36 + pcm.length * 2, true); w(8, "WAVE"); w(12, "fmt ");
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
  out.setUint32(24, sr, true); out.setUint32(28, sr * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true);
  w(36, "data"); out.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true);
  return new Blob([out], { type: "audio/wav" });
}

async function setInput(blob, name) {
  try { currentBlob = await toWav16k(blob); } catch (e) { currentBlob = blob; }
  currentName = name;
  $("#fileName").textContent = name;
  const p = $("#player"); p.src = URL.createObjectURL(blob); p.hidden = false;
  $("#tGo").disabled = !!$("#tGo").dataset.bad;
}

function langHint() {
  const lang = seg("tLang"), task = seg("tTask"), model = $("#tModel").value;
  const info = STATUS?.models.find((m) => m.name === model);
  let msg = "";
  const bad = !!(info && ((lang && !info.langs.includes(lang)) || (task === "translate" && !info.multilingual)));
  if (info && lang && !info.langs.includes(lang)) msg = `${model} supports ${info.langs.map((l) => LANG[l]).join(", ")} only. Choose a Whisper model for ${LANG[lang]}.`;
  else if (info && task === "translate" && !info.multilingual) msg = "Translation requires a Whisper model.";
  else if (lang === "ja" && model === "whisper-tiny") msg = "whisper-base or whisper-small are noticeably more accurate for Japanese.";
  $("#tHint").textContent = msg; $("#tHint").hidden = !msg;
  $("#tGo").dataset.bad = bad ? "1" : ""; $("#tGo").disabled = bad || !currentBlob;
  $("#tRef").placeholder = task === "translate" ? "Expected English translation" :
    lang === "ja" ? "今日はいい天気ですね。" : lang === "es" ? "El perro corre rápido por el parque." : "The birch canoe slid on the smooth planks.";
}

function initTranscribe() {
  const drop = $("#drop");
  drop.addEventListener("click", () => $("#fileInput").click());
  $("#pick").addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); $("#fileInput").click(); });
  $("#fileInput").addEventListener("change", (e) => e.target.files[0] && setInput(e.target.files[0], e.target.files[0].name));
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => { const f = e.dataTransfer.files[0]; if (f) setInput(f, f.name); });

  let rec = null, recStart = 0, recTimer = null;
  $("#recBtn").addEventListener("click", async () => {
    if (rec && rec.state === "recording") { rec.stop(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chunks = [];
      rec = new MediaRecorder(stream);
      rec.ondataavailable = (e) => chunks.push(e.data);
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        clearInterval(recTimer); $("#recBtn").classList.remove("recording"); busy(false);
        $("#recLabel").textContent = "Record"; $("#recTime").textContent = "";
        setInput(new Blob(chunks, { type: rec.mimeType }), "microphone-recording.wav");
      };
      rec.start(); recStart = Date.now(); busy(true);
      $("#recBtn").classList.add("recording"); $("#recLabel").textContent = "Stop";
      recTimer = setInterval(() => ($("#recTime").textContent = ((Date.now() - recStart) / 1000).toFixed(1) + "s"), 100);
    } catch (e) { toast("Microphone not available: " + e.message, true); }
  });

  ["tLang", "tTask"].forEach((id) => $("#" + id).addEventListener("change", langHint));
  $("#tModel").addEventListener("change", langHint);

  $("#tGo").addEventListener("click", async () => {
    if (!currentBlob) return;
    const btn = $("#tGo"); btn.disabled = true; btn.textContent = "Transcribing…"; busy(true);
    const fd = new FormData();
    fd.append("file", currentBlob, currentName.replace(/\.[^.]+$/, "") + ".wav");
    fd.append("model", $("#tModel").value);
    fd.append("reference", $("#tRef").value);
    fd.append("trim", $("#tTrim").checked);
    fd.append("snr_db", $("#tSnr").value);
    fd.append("language", seg("tLang"));
    fd.append("task", seg("tTask"));
    try { renderTranscript(await api("/api/transcribe", { method: "POST", body: fd })); loadStatus(); }
    catch (e) { toast(e.message, true); }
    finally { btn.disabled = !!btn.dataset.bad; btn.textContent = "Transcribe"; busy(false); }
  });
}

function renderTranscript(r) {
  $("#tEmpty").hidden = true; $("#tOut").hidden = false;
  $("#tText").textContent = r.text || "No speech recognised.";
  const lg = r.language || "en", ja = lg === "ja" && r.task !== "translate";
  $("#tBadges").innerHTML =
    `<span class="chip on">${LANG[lg] || lg}${r.requested_language === "auto" ? " · detected" : ""}</span>` +
    (r.task === "translate" ? `<span class="chip">Translated to English</span>` : "") +
    `<span class="chip mono">${esc(r.model)}</span>`;
  const t = r.timing, i = r.info;
  let tiles = "";
  if (r.scores) tiles += tile(r.scores.unit === "char" ? "Error (chars)" : "WER", pct(r.scores.wer), true) + tile("CER", pct(r.scores.cer), true);
  tiles += tile("Audio", fmt(i.duration_s, 2) + "<small>s</small>") + tile("After trim", fmt(i.processed_s, 2) + "<small>s</small>") +
    tile("Inference", fmt(t.inference_s, 2) + "<small>s</small>") + tile("Speed", fmt(t.rtfx, 1) + "<small>× RT</small>") +
    tile("Model load", fmt(t.model_load_s, 2) + "<small>s</small>") + tile(ja ? "Characters" : "Words", ja ? [...r.text.replace(/\s/g, "")].length : r.words);
  $("#tTiles").innerHTML = tiles;
  if (r.scores) renderAlignment(r.scores); else $("#tAlign").hidden = true;
  redraw.wave = () => drawWave($("#cWave"), r.waveform_raw, r.waveform);
  redraw.wave();
  if (window.gsap) gsap.from("#tText, #tTiles .tile", { y: 10, opacity: 0, duration: 0.5, stagger: 0.04, ease: TOKENS.motion.enter });
}

function align(ref, hyp) {
  const n = ref.length, m = hyp.length, d = [];
  for (let i = 0; i <= n; i++) { d.push(new Array(m + 1).fill(0)); d[i][0] = i; }
  for (let j = 0; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++)
    d[i][j] = ref[i - 1] === hyp[j - 1] ? d[i - 1][j - 1] : 1 + Math.min(d[i - 1][j - 1], d[i - 1][j], d[i][j - 1]);
  const ops = []; let i = n, j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && ref[i - 1] === hyp[j - 1] && d[i][j] === d[i - 1][j - 1]) { ops.push(["H", hyp[j - 1]]); i--; j--; }
    else if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + 1) { ops.push(["S", hyp[j - 1], ref[i - 1]]); i--; j--; }
    else if (i > 0 && d[i][j] === d[i - 1][j] + 1) { ops.push(["D", ref[i - 1]]); i--; }
    else { ops.push(["I", hyp[j - 1]]); j--; }
  }
  return ops.reverse();
}
function renderAlignment(s) {
  const chars = s.unit === "char";
  const split = (x) => (chars ? [...x] : x.split(" ").filter(Boolean));
  const ops = align(split(s.ref_norm), split(s.hyp_norm));
  $("#tAlign").innerHTML = ops.map(([o, w, r]) => o === "H" ? `<span class="w">${esc(w)}</span>` :
    `<span class="w ${o}" title="${o === "S" ? "substituted for: " + esc(r) : o === "D" ? "deleted" : "inserted"}">${esc(w)}</span>`).join(chars ? "" : " ") +
    `<div class="meta">${s.S} substituted · ${s.D} deleted · ${s.I} inserted · ${s.N} reference ${chars ? "characters" : "words"}${s.score_language === "ja" ? " · kanji and katakana compared as hiragana" : ""}</div>`;
  $("#tAlign").hidden = false;
}

function drawWave(c, raw, proc) {
  if (!c.clientWidth) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2); c.width = c.clientWidth * dpr; c.height = c.clientHeight * dpr;
  const g = c.getContext("2d"), W = c.width, H = c.height, h = H / 2;
  g.clearRect(0, 0, W, H);
  const lane = (arr, y0, fill) => {
    if (!arr || !arr.length) return; const bw = W / arr.length; g.fillStyle = fill;
    arr.forEach((v, i) => { const a = Math.max(1, v * (h / 2 - 6)); g.fillRect(i * bw, y0 + h / 2 - a, Math.max(1, bw - 0.8), a * 2); });
  };
  const grad = g.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0, C.crimson); grad.addColorStop(0.5, C.pinkDeep); grad.addColorStop(1, C.pink);
  lane(raw, 0, "rgba(161,161,170,.38)"); lane(proc, h, grad);
}

/* ===================================================================== JOBS */
function startJob(kind, body, prefix, onDone) {
  const box = $(`#${prefix}Job`), bar = box.querySelector(".bar"), btn = $(`#${prefix}Go`);
  box.hidden = false; btn.disabled = true; bar.classList.add("indet"); busy(true);
  $(`#${prefix}Log`).textContent = ""; $(`#${prefix}Prog`).textContent = "queued";
  postJSON(`/api/jobs/${kind}`, body).then(({ id }) => {
    const poll = async () => {
      let j;
      try { j = await api(`/api/jobs/${id}`); } catch (e) { setTimeout(poll, 1500); return; }
      const p = j.progress;
      if (p.total) { bar.classList.remove("indet"); bar.firstElementChild.style.width = (100 * p.done) / p.total + "%"; }
      $(`#${prefix}Prog`).textContent = `${j.state}${j.waiting_for ? " · waiting for " + j.waiting_for : ""}${p.total ? ` · ${p.label} ${p.done}/${p.total}` : ""}${j.elapsed_s ? ` · ${j.elapsed_s}s` : ""}`;
      $(`#${prefix}Log`).textContent = j.log.join("\n");
      if (j.state === "done" || j.state === "error") {
        btn.disabled = false; bar.classList.remove("indet"); busy(false);
        bar.firstElementChild.style.width = j.state === "done" ? "100%" : "0";
        if (j.state === "error") toast(j.error, true); else onDone && onDone(j);
        loadStatus().catch(() => {}); return;
      }
      setTimeout(poll, 800);
    };
    poll();
  }).catch((e) => { btn.disabled = false; busy(false); toast(e.message, true); });
}
const intOrNull = (v) => (v ? parseInt(v, 10) : null);
const floatOrNull = (v) => (v === "" ? null : parseFloat(v));

/* ==================================================================== BATCH */
function initBatch() {
  $("#bGo").addEventListener("click", () => startJob("batch", {
    manifest: $("#bData").value, model: $("#bModel").value, engine: $("#bEngine").value,
    workers: intOrNull($("#bWorkers").value), limit: intOrNull($("#bLimit").value), snr_db: floatOrNull($("#bSnr").value),
    language: seg("bLang") || null, task: $("#bTask").value,
  }, "b", renderBatch));
  $("#bEngine").addEventListener("change", (e) => ($("#bWorkers").disabled = e.target.value !== "spark"));

  $$("[data-download]").forEach((b) => b.addEventListener("click", () => {
    toast(`Downloading ${b.textContent.trim()}…`); busy(true);
    postJSON("/api/jobs/download", { which: b.dataset.download, limit: b.dataset.download.startsWith("fleurs") ? 100 : 200 }).then(({ id }) => {
      const poll = async () => {
        const j = await api(`/api/jobs/${id}`);
        if (j.state === "done") { busy(false); toast("Dataset ready"); await loadStatus(false); selectDataset(j.result.manifest); }
        else if (j.state === "error") { busy(false); toast(j.error, true); }
        else setTimeout(poll, 1500);
      };
      poll();
    }).catch((e) => { busy(false); toast(e.message, true); });
  }));

  $("#bUpload").addEventListener("change", async (e) => {
    const files = [...e.target.files]; if (!files.length) return;
    const fd = new FormData(); files.forEach((f) => fd.append("files", f, f.name)); fd.append("name", "upload");
    try { const r = await api("/api/upload", { method: "POST", body: fd }); toast(`Uploaded ${r.count} audio files`); await loadStatus(false); selectDataset(r.manifest); }
    catch (err) { toast(err.message, true); }
    e.target.value = "";
  });
}
function selectDataset(path) { $$(".dataSel").forEach((s) => { if ([...s.options].some((o) => o.value === path)) s.value = path; }); }

function renderBatch(j) {
  const s = j.summary, rows = j.rows || [];
  $("#bEmpty").hidden = true; $("#bOut").hidden = false; $("#bCsv").hidden = false;
  const det = Object.entries(s.detected_languages || {}).map(([l, n]) => `${CODE[l] || l}<small>${n}</small>`).join(" ");
  $("#bTiles").innerHTML =
    tile("WER", pct(s.wer), true) + tile("CER", pct(s.cer), true) +
    tile("Files", `${s.files}${s.failed ? `<small>${s.failed} failed</small>` : ""}`) +
    tile("Audio", fmt(s.audio_s / 60, 1) + "<small>min</small>") + tile("Wall time", fmt(s.wall_s, 1) + "<small>s</small>") +
    tile("Speed", fmt(s.rtfx, 1) + "<small>× RT</small>") + tile("Engine", `${s.engine === "spark" ? "Spark" : "Local"}<small>${s.master || ""}</small>`) +
    tile("Languages", det || "—");
  const counts = {}; rows.forEach((r) => (counts[r.worker] = (counts[r.worker] || 0) + 1));
  const max = Math.max(...Object.values(counts), 1);
  $("#bDist").innerHTML = Object.entries(counts).map(([w, c]) =>
    `<div class="dist-row"><span title="${esc(w)}">pid ${esc(String(w).split(":").pop())}</span><div class="b" style="width:${(100 * c) / max}%"></div><span>${c}</span></div>`).join("");
  $("#bCsv").href = `/api/jobs/${j.id}/csv`;
  $("#bTable").innerHTML = `<tr><th>ID</th><th>Lang</th><th>Hypothesis</th><th>Reference</th><th>WER</th><th>Audio s</th><th>Infer s</th><th>Worker</th></tr>` +
    rows.map((r) => `<tr><td class="mono muted" style="font-size:12px">${esc(r.id)}</td><td class="mono" style="font-size:12px">${CODE[r.language] || esc(r.language || "")}</td>
      <td style="min-width:200px">${r.error ? `<span class="neg">${esc(r.error)}</span>` : esc(r.hypothesis)}</td>
      <td class="muted" style="min-width:200px">${esc(r.reference)}</td>
      <td class="num ${r.wer > 0.5 ? "neg" : r.wer === 0 ? "pos" : ""}">${pct(r.wer)}</td>
      <td class="num">${fmt(r.duration_s)}</td><td class="num">${fmt(r.infer_s)}</td><td class="mono muted" style="font-size:12px">${esc(String(r.worker || "").split(":").pop())}</td></tr>`).join("");
  refreshDashboard();
}

/* ================================================================ BENCHMARK */
function initBench() {
  $("#kGo").addEventListener("click", () => {
    const wc = $$("#kWorkers input:checked").map((x) => parseInt(x.value, 10));
    if (!wc.length) return toast("Select at least one worker count", true);
    startJob("benchmark", { manifest: $("#kData").value, model: $("#kModel").value, worker_counts: wc, limit: intOrNull($("#kLimit").value) },
      "k", (j) => { loadHistory().then(() => renderBench(j.result)); });
  });
}

function renderBench(res) {
  if (!res) return;
  $("#kEmpty").hidden = true; $("#kOut").hidden = false;
  redraw.bench = () => {
    const runs = res.runs, W = 640, H = 300, L = 46, R = 46, T = 22, B = 48, iw = W - L - R, ih = H - T - B;
    const maxWall = Math.max(...runs.map((r) => r.wall_s)) * 1.15;
    const spark1 = runs.find((r) => r.engine === "spark" && r.workers === 1);
    const ideal = (r) => (r.engine === "spark" && spark1 && r.speedup_vs_single ? (spark1.speedup_vs_single || 1) * r.workers : null);
    const maxSp = Math.max(1, ...runs.map((r) => Math.max(r.speedup_vs_single || 0, ideal(r) || 0))) * 1.15;
    const bw = iw / runs.length, x = (i) => L + bw * i + bw / 2;
    const yW = (v) => T + ih - (v / maxWall) * ih, yS = (v) => T + ih - (v / maxSp) * ih;
    let s = `<svg viewBox="0 0 ${W} ${H}"><defs><linearGradient id="kbar" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.pinkDeep}" stop-opacity=".55"/><stop offset="1" stop-color="${C.crimson}" stop-opacity=".18"/></linearGradient></defs><g class="grid">`;
    for (let k = 0; k <= 4; k++) {
      const y = T + (ih * k) / 4; s += `<line x1="${L}" x2="${W - R}" y1="${y}" y2="${y}"/>`;
      s += `<text x="${L - 8}" y="${y + 4}" text-anchor="end">${(maxWall * (1 - k / 4)).toFixed(0)}s</text>`;
      s += `<text x="${W - R + 8}" y="${y + 4}">${(maxSp * (1 - k / 4)).toFixed(1)}×</text>`;
    }
    s += `</g>`;
    runs.forEach((r, i) => {
      s += `<rect x="${x(i) - bw * 0.22}" y="${yW(r.wall_s)}" width="${bw * 0.44}" height="${T + ih - yW(r.wall_s)}" rx="7" fill="url(#kbar)"><title>${r.wall_s}s</title></rect>`;
      s += `<text x="${x(i)}" y="${H - B + 20}" text-anchor="middle">${runLabel(r)}</text>`;
      s += `<text x="${x(i)}" y="${H - B + 34}" text-anchor="middle" style="opacity:.7">${r.wall_s.toFixed(1)}s</text>`;
    });
    const idealPts = runs.map((r, i) => (ideal(r) ? `${x(i)},${yS(ideal(r))}` : null)).filter(Boolean);
    if (idealPts.length > 1) s += `<polyline points="${idealPts.join(" ")}" fill="none" stroke="${C.crimson}" stroke-width="1.8" stroke-dasharray="5 5"/>`;
    s += `<polyline points="${runs.map((r, i) => `${x(i)},${yS(r.speedup_vs_single || 0)}`).join(" ")}" fill="none" stroke="${C.pink}" stroke-width="2.4" stroke-linejoin="round" style="filter:drop-shadow(0 0 6px rgba(246,211,223,.6))"/>`;
    runs.forEach((r, i) => (s += `<circle cx="${x(i)}" cy="${yS(r.speedup_vs_single || 0)}" r="4.8" fill="${C.surface2}" stroke="${C.pink}" stroke-width="2.2"><title>${fmt(r.speedup_vs_single)}×</title></circle>`));
    $("#kChart").innerHTML = s + "</svg>";
  };
  redraw.bench();
  $("#kTable").innerHTML = `<tr><th>Run</th><th>Wall s</th><th>Files/s</th><th>RTFx</th><th>Speed-up</th><th>Efficiency</th><th>Model load s</th><th>WER</th></tr>` +
    res.runs.map((r) => `<tr><td class="mono">${runLabel(r)}</td><td class="num">${fmt(r.wall_s)}</td><td class="num">${fmt(r.files_per_s)}</td><td class="num">${fmt(r.rtfx)}</td>
    <td class="num ${r.speedup_vs_single >= 1 ? "pos" : "neg"}">${fmt(r.speedup_vs_single)}×</td><td class="num">${r.efficiency != null ? pct(r.efficiency) : "—"}</td><td class="num">${fmt(r.model_load_s_total)}</td><td class="num">${pct(r.wer)}</td></tr>`).join("");
  $("#kMeta").textContent = `${res.model} · ${res.files} files · ${res.cpu_count} CPU cores · ${res.created}. Speed-up is relative to the single-thread run; efficiency = speed-up (Spark ×k vs ×1) / k.`;
}

/* =================================================================== NOISE */
function initNoise() {
  $("#nGo").addEventListener("click", () => startJob("noise",
    { manifest: $("#nData").value, model: $("#nModel").value, limit: intOrNull($("#nLimit").value), engine: "spark" },
    "n", (j) => { loadHistory().then(() => renderNoise(j.result)); }));
}

function renderNoise(res) {
  if (!res) return;
  $("#nEmpty").hidden = true; $("#nOut").hidden = false;
  redraw.noise = () => {
    const P = res.points, W = 640, H = 280, L = 46, R = 20, T = 30, B = 36, iw = W - L - R, ih = H - T - B;
    const maxY = Math.max(0.1, ...P.map((p) => Math.max(p.wer || 0, p.cer || 0))) * 1.15;
    const x = (i) => L + (iw * (i + 0.5)) / P.length, y = (v) => T + ih - (v / maxY) * ih;
    let s = `<svg viewBox="0 0 ${W} ${H}"><defs><linearGradient id="nfill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.pinkDeep}" stop-opacity=".28"/><stop offset="1" stop-color="${C.pinkDeep}" stop-opacity="0"/></linearGradient></defs><g class="grid">`;
    for (let k = 0; k <= 4; k++) { const yy = T + (ih * k) / 4; s += `<line x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}"/><text x="${L - 8}" y="${yy + 4}" text-anchor="end">${(maxY * (1 - k / 4) * 100).toFixed(0)}%</text>`; }
    s += `</g>`;
    s += `<polygon points="${x(0)},${T + ih} ${P.map((p, i) => `${x(i)},${y(p.wer || 0)}`).join(" ")} ${x(P.length - 1)},${T + ih}" fill="url(#nfill)"/>`;
    [["wer", C.pink], ["cer", C.pinkDeep]].forEach(([k, c]) => {
      s += `<polyline points="${P.map((p, i) => `${x(i)},${y(p[k] || 0)}`).join(" ")}" fill="none" stroke="${c}" stroke-width="2.4" stroke-linejoin="round" ${k === "cer" ? 'stroke-dasharray="6 5"' : 'style="filter:drop-shadow(0 0 6px rgba(246,211,223,.55))"'}/>`;
      P.forEach((p, i) => (s += `<circle cx="${x(i)}" cy="${y(p[k] || 0)}" r="4.6" fill="${C.surface2}" stroke="${c}" stroke-width="2.2"><title>${k.toUpperCase()} ${pct(p[k])}</title></circle>`));
    });
    P.forEach((p, i) => (s += `<text x="${x(i)}" y="${H - B + 22}" text-anchor="middle">${p.label}</text>`));
    s += `<text x="${W - R}" y="${T - 12}" text-anchor="end" style="fill:${C.pink}">WER</text><text x="${W - R - 46}" y="${T - 12}" text-anchor="end" style="fill:${C.pinkDeep}">CER</text>`;
    $("#nChart").innerHTML = s + "</svg>";
  };
  redraw.noise();
  $("#nTable").innerHTML = `<tr><th>SNR</th><th>WER</th><th>CER</th><th>Wall s</th></tr>` +
    res.points.map((p) => `<tr><td class="mono">${p.label}</td><td class="num">${pct(p.wer)}</td><td class="num">${pct(p.cer)}</td><td class="num">${fmt(p.wall_s)}</td></tr>`).join("") +
    `<tr><td colspan="4" class="muted" style="font-size:12px">${res.model} · ${res.files} files · ${res.engine} · ${res.created}</td></tr>`;
}

/* ================================================================= HISTORY */
export async function loadHistory() {
  HIST = await api("/api/results");
  const fill = (sel, kind, render) => {
    const items = HIST.filter((h) => h.kind === kind);
    sel.innerHTML = items.length ? items.map((h, i) => `<option value="${i}">${String(h.created).replace("T", " ")} · ${h.model} · ${h.files} files</option>`).join("") : `<option>No saved runs</option>`;
    sel.onchange = () => render(items[sel.value]);
    if (items.length) render(items[0]);
  };
  fill($("#kHist"), "benchmark", renderBench);
  fill($("#nHist"), "noise", renderNoise);
  renderDashBench();
}

/* ==================================================================== INIT */
export function onPageShown(route) {
  if (route === "dashboard") refreshDashboard();
  if (route === "transcribe" && redraw.wave) redraw.wave();
}

export function initPages() {
  initSegs(); initTranscribe(); initBatch(); initBench(); initNoise();
  let rt; addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => redraw.wave && redraw.wave(), 150); });
  loadStatus(false).then(loadHistory).then(refreshDashboard).catch((e) => toast("Server not reachable: " + e.message, true));
  setInterval(() => { if (document.visibilityState === "visible" && STATUS) loadStatus().catch(() => {}); }, 15000);
}
