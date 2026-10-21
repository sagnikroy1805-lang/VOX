// WHAT THIS FILE DOES: everything interactive on the page. It talks to the FastAPI server (web/app.py)
// using fetch() and draws the results. No ML runs in the browser - it only records/converts audio and shows results.
/* VOX front-end — plain JavaScript + Tailwind (bundled locally), no build step. */
// $('#id') = find ONE element on the page (short helper like jQuery)
const $ = (s, r = document) => r.querySelector(s);
// $$('.cls') = find ALL matching elements, returned as an array
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
// STATUS = the server's /api/status answer (models, datasets, cores...), loaded at start-up
let STATUS = null;

// Language names shown on the page
const LANG = { en: "English", es: "Español", ja: "日本語" };
// Short language codes shown in dropdowns and tables
const CODE = { en: "EN", es: "ES", ja: "JA" };
// css('--color-acc') = read a colour from the page's theme (so charts match light/dark mode)
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

/* ------------------------------------------------------------ helpers */
// api(): call the server and return its JSON answer; if the server reports an error, throw it with its message
async function api(path, opts = {}) {
  const r = await fetch(path, opts);
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).detail || msg; } catch (_) {}
    throw new Error(msg);
  }
  return r.json();
}
// postJSON(): send a JSON body with POST (used to start jobs)
const postJSON = (p, body) => api(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
// toast(): small pop-up message at the bottom (red for errors), hides itself after a few seconds
function toast(msg, err = false) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  t.style.color = err ? css("--color-acc") : "";
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), err ? 7000 : 3500);
}
// fmt(): number with d decimals, or a dash if there is no value
const fmt = (v, d = 2) => (v === null || v === undefined || Number.isNaN(v) ? "—" : Number(v).toFixed(d));
// pct(): 0.123 -> '12.3%'
const pct = (v) => (v === null || v === undefined ? "—" : (v * 100).toFixed(1) + "%");
// esc(): make text safe to put inside HTML (stops <, >, & from breaking the page)
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
// tile(): HTML for one summary card (label + value); hl = highlighted card
const tile = (k, v, hl = false) => `<div class="tile${hl ? " hl" : ""}"><div class="k">${k}</div><div class="v">${v}</div></div>`;
// busy(): animate the logo bars while the server is working
const busy = (on) => $("#eq").classList.toggle("busy", on);

/* segmented controls */
// seg('id'): which option is selected in a segmented button group (e.g. language Auto/EN/ES/JA)
const seg = (id) => $(`#${id} button.on`)?.dataset.v ?? "";
// make every segmented control switch its 'on' button when clicked, then fire a 'change' event
$$(".seg").forEach((g) => g.addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  e.preventDefault();
  $$("button", g).forEach((x) => x.classList.toggle("on", x === b));
  g.dispatchEvent(new Event("change"));
}));

/* tabs */
// TABS: clicking a tab button shows its panel and hides the others
$$("#tabs button").forEach((b) => b.addEventListener("click", () => {
  $$("#tabs button").forEach((x) => x.classList.toggle("active", x === b));
  $$(".tab").forEach((t) => t.classList.toggle("active", t.id === "tab-" + b.dataset.tab));
}));

/* theme */
// redraw = list of chart-drawing functions to run again when the theme changes
let redraw = [];
// button label says which theme you can switch TO
function setThemeLabel() { $("#themeBtn").textContent = document.documentElement.dataset.theme === "dark" ? "Light" : "Dark"; }
// THEME BUTTON: switch light <-> dark, remember the choice, redraw charts in the new colours
$("#themeBtn").addEventListener("click", () => {
  const t = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = t;
  // save the choice so the page opens in the same theme next time
  try { localStorage.setItem("vox-theme", t); } catch (e) {}
  setThemeLabel();
  requestAnimationFrame(() => redraw.forEach((f) => f()));
});
setThemeLabel();

/* ------------------------------------------------------------- status */
// LOAD STATUS: ask the server what is available and fill the chips and every dropdown
async function loadStatus(keepSelection = true) {
  // GET /api/status -> web/app.py status()
  STATUS = await api("/api/status");
  // models whose libraries are installed
  const avail = STATUS.models.filter((m) => m.available);
  // small green/orange dot for the status chips
  const dot = (ok) => `<span class="h-1.5 w-1.5 rounded-full ${ok ? "bg-ok" : "bg-acc"}"></span>`;
  // header chips: Spark ready?, Working/Idle, number of CPU cores
  $("#chips").innerHTML =
    `<span class="chip">${dot(STATUS.java)}Spark ${STATUS.java ? "ready" : "needs Java"}</span>` +
    `<span class="chip">${dot(!STATUS.busy)}${STATUS.busy ? "Working" : "Idle"}</span>` +
    `<span class="chip">${STATUS.cpu_count} cores</span>`;
  busy(STATUS.busy);
  // fill every model dropdown (Transcribe, Batch, Benchmark, Robustness)
  $$(".modelSel").forEach((sel) => {
    const prev = sel.value;
    sel.innerHTML = STATUS.models.map((m) =>
      `<option value="${m.name}" ${m.available ? "" : "disabled"}>${m.name} · ${m.params} · ${m.langs.map((l) => CODE[l]).join("/")}${m.available ? "" : " (not installed)"}</option>`).join("");
    // pick the default model (whisper-tiny) if it is available
    const def = avail.find((m) => m.name === STATUS.default_model) ? STATUS.default_model : (avail[0] || {}).name;
    // keep the user's previous choice if it still exists
    sel.value = keepSelection && prev && avail.find((m) => m.name === prev) ? prev : def;
  });
  // fill every dataset dropdown (every folder under data/ that has a manifest.csv)
  $$(".dataSel").forEach((sel) => {
    const prev = sel.value;
    sel.innerHTML = STATUS.datasets.map((d) =>
      `<option value="${esc(d.path)}">${esc(d.name)} · ${d.count} files · ${(d.languages || ["en"]).map((l) => CODE[l] || l).join("/")}</option>`).join("");
    if (keepSelection && prev && STATUS.datasets.find((d) => d.path === prev)) sel.value = prev;
  });
  // worker options for the Batch tab (1, 2, 4 ... up to the core count)
  const w = STATUS.worker_options;
  $("#bWorkers").innerHTML = w.map((n) => `<option value="${n}">${n}</option>`).join("");
  // default = the largest worker count
  $("#bWorkers").value = w[w.length - 1];
  // Benchmark tab: one checkbox per worker count
  if (!$("#kWorkers").children.length)
    $("#kWorkers").innerHTML = w.map((n) => `<label class="chip cursor-pointer text-fg"><input type="checkbox" value="${n}" checked class="h-3.5 w-3.5 accent-[var(--color-acc)]">${n}</label>`).join("");
  // 'How it works' tab: the table of models
  $("#mTable").innerHTML = `<tr><th>Model</th><th>Languages</th><th>Architecture</th><th>Params</th><th>Source</th><th>Status</th></tr>` +
    STATUS.models.map((m) => `<tr><td class="font-mono">${m.name}</td><td class="whitespace-nowrap">${m.langs.map((l) => CODE[l]).join(" · ")}</td><td>${esc(m.arch)}</td><td class="num">${m.params}</td><td class="font-mono text-xs text-mute">${m.hf || "bundled, offline"}</td><td class="text-mute">${m.available ? (m.loaded ? "loaded" : "ready") : "not installed"}</td></tr>`).join("");
  // check the selected model can handle the selected language
  langHint();
}

/* ===================================================== TRANSCRIBE TAB */
// the recorded/uploaded audio waiting to be transcribed, and its file name
let currentBlob = null, currentName = "";

// toWav16k(): convert ANY audio the browser can play (e.g. microphone WebM) into a 16 kHz mono WAV file
async function toWav16k(blob) {
  // Decode anything the browser can play, resample to 16 kHz mono, encode PCM16 WAV.
  // read the recording's raw bytes
  const buf = await blob.arrayBuffer();
  // Web Audio API: decode the compressed audio into samples
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const decoded = await ctx.decodeAudioData(buf.slice(0));
  ctx.close();
  // number of samples at 16 kHz
  const sr = 16000, len = Math.max(1, Math.ceil(decoded.duration * sr));
  // OfflineAudioContext with 1 channel at 16000 Hz = resample + downmix to mono
  const off = new OfflineAudioContext(1, len, sr);
  const src = off.createBufferSource(); src.buffer = decoded; src.connect(off.destination); src.start();
  // render it -> Float32 samples between -1 and 1
  const pcm = (await off.startRendering()).getChannelData(0);
  // a WAV file = 44-byte header + 2 bytes (16-bit) per sample
  const out = new DataView(new ArrayBuffer(44 + pcm.length * 2));
  // helper to write text like 'RIFF' into the header
  const w = (o, s) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  // WAV header: RIFF / WAVE / fmt chunk: PCM, 1 channel, 16000 Hz, 16 bits
  w(0, "RIFF"); out.setUint32(4, 36 + pcm.length * 2, true); w(8, "WAVE"); w(12, "fmt ");
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
  out.setUint32(24, sr, true); out.setUint32(28, sr * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true);
  w(36, "data"); out.setUint32(40, pcm.length * 2, true);
  // write every sample as a 16-bit integer (-32767..32767)
  for (let i = 0; i < pcm.length; i++) out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true);
  // the finished WAV file, ready to upload
  return new Blob([out], { type: "audio/wav" });
}

// setInput(): store the audio to transcribe (converted to WAV), show its name and a player
async function setInput(blob, name) {
  try { currentBlob = await toWav16k(blob); }
  catch (e) { currentBlob = blob; }          // let the server try (ffmpeg fallback)
  currentName = name;
  $("#fileName").textContent = name;
  const p = $("#player"); p.src = URL.createObjectURL(blob); p.hidden = false;
  $("#tGo").disabled = !!$("#tGo").dataset.bad;
}

// DROP ZONE: click to choose a file, or drag and drop a file onto it
const drop = $("#drop");
drop.addEventListener("click", () => $("#fileInput").click());
$("#pick").addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); $("#fileInput").click(); });
$("#fileInput").addEventListener("change", (e) => e.target.files[0] && setInput(e.target.files[0], e.target.files[0].name));
["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("border-acc"); }));
["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("border-acc"); }));
drop.addEventListener("drop", (e) => { const f = e.dataTransfer.files[0]; if (f) setInput(f, f.name); });

// MICROPHONE RECORDING
let rec = null, recStart = 0, recTimer = null;
$("#recBtn").addEventListener("click", async () => {
  // second click = stop recording
  if (rec && rec.state === "recording") { rec.stop(); return; }
  try {
    // ask the browser for microphone permission
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const chunks = [];
    // MediaRecorder records compressed audio (WebM/Opus) in chunks
    rec = new MediaRecorder(stream);
    rec.ondataavailable = (e) => chunks.push(e.data);
    // when stopped: release the microphone, reset the button, use the recording as input
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      clearInterval(recTimer); $("#recBtn").classList.remove("recording"); busy(false);
      $("#recLabel").textContent = "Record"; $("#recTime").textContent = "";
      setInput(new Blob(chunks, { type: rec.mimeType }), "microphone-recording.wav");
    };
    // start recording and a timer that shows the seconds
    rec.start(); recStart = Date.now(); busy(true);
    $("#recBtn").classList.add("recording"); $("#recLabel").textContent = "Stop";
    recTimer = setInterval(() => ($("#recTime").textContent = ((Date.now() - recStart) / 1000).toFixed(1) + "s"), 100);
  } catch (e) { toast("Microphone not available: " + e.message, true); }
});

// langHint(): warn (and disable Transcribe) if the model cannot handle the chosen language/translation
function langHint() {
  const lang = seg("tLang"), task = seg("tTask"), model = $("#tModel").value;
  const info = STATUS?.models.find((m) => m.name === model);
  let msg = "";
  // bad = impossible combination (e.g. wav2vec2-base + Japanese, or PocketSphinx + translate)
  const bad = !!(info && ((lang && !info.langs.includes(lang)) || (task === "translate" && !info.multilingual)));
  if (info && lang && !info.langs.includes(lang)) msg = `${model} supports ${info.langs.map((l) => LANG[l]).join(", ")} only. Choose a Whisper model for ${LANG[lang]}.`;
  else if (info && task === "translate" && !info.multilingual) msg = "Translation requires a Whisper model.";
  else if (lang === "ja" && model === "whisper-tiny") msg = "whisper-base or whisper-small are noticeably more accurate for Japanese.";
  $("#tHint").textContent = msg; $("#tHint").classList.toggle("hidden", !msg);
  $("#tGo").dataset.bad = bad ? "1" : ""; $("#tGo").disabled = bad || !currentBlob;
  // example sentence in the reference box, in the chosen language
  $("#tRef").placeholder = task === "translate" ? "Expected English translation" :
    lang === "ja" ? "今日はいい天気ですね。" : lang === "es" ? "El perro corre rápido por el parque." : "The birch canoe slid on the smooth planks.";
}
// re-check whenever language, task or model changes
["tLang", "tTask"].forEach((id) => $("#" + id).addEventListener("change", langHint));
$("#tModel").addEventListener("change", langHint);

// TRANSCRIBE BUTTON: send the WAV + settings to the server
$("#tGo").addEventListener("click", async () => {
  if (!currentBlob) return;
  const btn = $("#tGo"); btn.disabled = true; btn.textContent = "Transcribing…"; busy(true);
  // FormData = the form fields web/app.py transcribe() expects
  const fd = new FormData();
  fd.append("file", currentBlob, currentName.replace(/\.[^.]+$/, "") + ".wav");
  fd.append("model", $("#tModel").value);
  fd.append("reference", $("#tRef").value);
  fd.append("trim", $("#tTrim").checked);
  fd.append("snr_db", $("#tSnr").value);
  fd.append("language", seg("tLang"));
  fd.append("task", seg("tTask"));
  // POST /api/transcribe -> audio.preprocess -> models -> metrics; then show the result
  try { renderTranscript(await api("/api/transcribe", { method: "POST", body: fd })); loadStatus(); }
  catch (e) { toast(e.message, true); }
  finally { btn.disabled = !!btn.dataset.bad; btn.textContent = "Transcribe"; busy(false); }
});

// renderTranscript(): show the text, language badges, summary cards, alignment and waveforms
function renderTranscript(r) {
  $("#tEmpty").hidden = true; $("#tOut").hidden = false;
  $("#tText").textContent = r.text || "No speech recognised.";
  // ja = Japanese output (counted in characters, not words)
  const lg = r.language || "en", ja = lg === "ja" && r.task !== "translate";
  $("#tBadges").innerHTML =
    `<span class="chip">${LANG[lg] || lg}${r.requested_language === "auto" ? " · detected" : ""}</span>` +
    (r.task === "translate" ? `<span class="chip">Translated to English</span>` : "") +
    `<span class="chip font-mono">${esc(r.model)}</span>`;
  // t = timings from the server, i = audio info (duration before/after trimming)
  const t = r.timing, i = r.info;
  let tiles = "";
  // WER/CER cards only if a reference text was typed
  if (r.scores) tiles += tile(r.scores.unit === "char" ? "Error (chars)" : "WER", pct(r.scores.wer), true) + tile("CER", pct(r.scores.cer), true);
  tiles += tile("Audio", fmt(i.duration_s, 2) + "<small>s</small>") +
    tile("After trim", fmt(i.processed_s, 2) + "<small>s</small>") +
    tile("Inference", fmt(t.inference_s, 2) + "<small>s</small>") +
    tile("Speed", fmt(t.rtfx, 1) + "<small>× real-time</small>") +
    tile("Model load", fmt(t.model_load_s, 2) + "<small>s</small>") +
    tile(ja ? "Characters" : "Words", ja ? [...r.text.replace(/\s/g, "")].length : r.words);
  $("#tTiles").innerHTML = tiles;
  if (r.scores) renderAlignment(r.scores); else $("#tAlign").hidden = true;
  // draw the raw (top) and processed (bottom) waveforms; redrawn if the theme changes
  const draw = () => drawWave($("#cWave"), r.waveform_raw, r.waveform);
  redraw = redraw.filter((f) => f.kind !== "wave"); draw.kind = "wave"; redraw.push(draw); draw();
}

// align(): the same Levenshtein table as metrics.py, plus a BACKTRACE that labels every word:
// H = hit (correct), S = substituted, D = deleted (missed), I = inserted (extra)
function align(ref, hyp) {
  const n = ref.length, m = hyp.length, d = [];
  // first column: i deletions
  for (let i = 0; i <= n; i++) { d.push(new Array(m + 1).fill(0)); d[i][0] = i; }
  // first row: j insertions
  for (let j = 0; j <= m; j++) d[0][j] = j;
  // fill the table: same word -> copy the diagonal, otherwise 1 + the cheapest neighbour
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++)
    d[i][j] = ref[i - 1] === hyp[j - 1] ? d[i - 1][j - 1] : 1 + Math.min(d[i - 1][j - 1], d[i - 1][j], d[i][j - 1]);
  // walk back from the bottom-right corner to find which operation produced each step
  const ops = []; let i = n, j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && ref[i - 1] === hyp[j - 1] && d[i][j] === d[i - 1][j - 1]) { ops.push(["H", hyp[j - 1]]); i--; j--; }
    else if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + 1) { ops.push(["S", hyp[j - 1], ref[i - 1]]); i--; j--; }
    else if (i > 0 && d[i][j] === d[i - 1][j] + 1) { ops.push(["D", ref[i - 1]]); i--; }
    else { ops.push(["I", hyp[j - 1]]); j--; }
  }
  return ops.reverse();
}
// renderAlignment(): colour each word by its operation (green / red / struck out / underlined)
function renderAlignment(s) {
  const chars = s.unit === "char";
  // Japanese is compared character by character, other languages word by word
  const split = (x) => (chars ? [...x] : x.split(" ").filter(Boolean));
  const ops = align(split(s.ref_norm), split(s.hyp_norm));
  $("#tAlign").innerHTML = ops.map(([o, w, r]) => o === "H" ? `<span class="w">${esc(w)}</span>` :
    `<span class="w ${o}" title="${o === "S" ? "substituted for: " + esc(r) : o === "D" ? "deleted" : "inserted"}">${esc(w)}</span>`).join(chars ? "" : " ") +
    `<div class="mt-3 font-sans text-xs text-mute">${s.S} substituted · ${s.D} deleted · ${s.I} inserted · ${s.N} reference ${chars ? "characters" : "words"}${s.score_language === "ja" ? " · kanji and katakana compared as hiragana" : ""}</div>`;
  $("#tAlign").hidden = false;
}

// drawWave(): draw two waveform bars on the canvas: raw audio (grey) and processed audio (gradient)
function drawWave(c, raw, proc) {
  // sharp drawing on high-resolution screens
  const dpr = window.devicePixelRatio || 1; c.width = c.clientWidth * dpr; c.height = c.clientHeight * dpr;
  const g = c.getContext("2d"), W = c.width, H = c.height, h = H / 2;
  g.clearRect(0, 0, W, H);
  // lane(): draw one waveform as thin vertical bars
  const lane = (arr, y0, fill) => {
    if (!arr.length) return; const bw = W / arr.length; g.fillStyle = fill;
    arr.forEach((v, i) => { const a = Math.max(1, v * (h / 2 - 6)); g.fillRect(i * bw, y0 + h / 2 - a, Math.max(1, bw - 0.8), a * 2); });
  };
  const grad = g.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0, css("--color-acc")); grad.addColorStop(1, css("--color-acc2"));
  lane(raw, 0, css("--color-mute") + "66"); lane(proc, h, grad);
}

/* ============================================================== JOBS */
// startJob(): start a background job (batch/benchmark/noise) and poll its progress until it finishes
function startJob(kind, body, prefix, onDone) {
  const box = $(`#${prefix}Job`), bar = box.querySelector(".bar"), btn = $(`#${prefix}Go`);
  box.hidden = false; btn.disabled = true; bar.classList.add("indet"); busy(true);
  $(`#${prefix}Log`).textContent = ""; $(`#${prefix}Prog`).textContent = "queued";
  // POST /api/jobs/<kind> -> returns a job id immediately; the work runs on the server's job queue
  postJSON(`/api/jobs/${kind}`, body).then(({ id }) => {
    // poll(): ask GET /api/jobs/<id> for state, progress and log
    const poll = async () => {
      let j;
      try { j = await api(`/api/jobs/${id}`); } catch (e) { setTimeout(poll, 1500); return; }
      const p = j.progress;
      // progress bar width = done / total (Spark partitions or files)
      if (p.total) { bar.classList.remove("indet"); bar.firstElementChild.style.width = (100 * p.done / p.total) + "%"; }
      $(`#${prefix}Prog`).textContent = `${j.state}${j.waiting_for ? " · waiting for " + j.waiting_for : ""}${p.total ? ` · ${p.label} ${p.done}/${p.total}` : ""}${j.elapsed_s ? ` · ${j.elapsed_s}s` : ""}`;
      $(`#${prefix}Log`).textContent = j.log.join("\n");
      // finished: re-enable the button and show the result (or the error)
      if (j.state === "done" || j.state === "error") {
        btn.disabled = false; bar.classList.remove("indet"); busy(false);
        bar.firstElementChild.style.width = j.state === "done" ? "100%" : "0";
        if (j.state === "error") toast(j.error, true); else onDone && onDone(j);
        loadStatus(); return;
      }
      // not finished yet: ask again in 0.8 s
      setTimeout(poll, 800);
    };
    poll();
  }).catch((e) => { btn.disabled = false; busy(false); toast(e.message, true); });
}
// empty input -> null (the server then uses its default)
const intOrNull = (v) => (v ? parseInt(v, 10) : null);
const floatOrNull = (v) => (v === "" ? null : parseFloat(v));

/* ============================================================= BATCH */
// BATCH RUN BUTTON: send dataset, model, engine (Spark/local), workers, limit, noise, language, task
$("#bGo").addEventListener("click", () => startJob("batch", {
  manifest: $("#bData").value, model: $("#bModel").value, engine: $("#bEngine").value,
  workers: intOrNull($("#bWorkers").value), limit: intOrNull($("#bLimit").value), snr_db: floatOrNull($("#bSnr").value),
  language: seg("bLang") || null, task: $("#bTask").value,
}, "b", renderBatch));
// worker count only matters for Spark
$("#bEngine").addEventListener("change", (e) => ($("#bWorkers").disabled = e.target.value !== "spark"));

// renderBatch(): summary cards, files per Spark worker, per-file table and the CSV link
function renderBatch(j) {
  const s = j.summary, rows = j.rows || [];
  $("#bEmpty").hidden = true; $("#bOut").hidden = false; $("#bCsv").hidden = false;
  // detected languages, e.g. 'EN 38 ES 2'
  const det = Object.entries(s.detected_languages || {}).map(([l, n]) => `${CODE[l] || l}<small>${n}</small>`).join(" ");
  $("#bTiles").innerHTML =
    tile("WER", pct(s.wer), true) + tile("CER", pct(s.cer), true) +
    tile("Files", `${s.files}${s.failed ? `<small>${s.failed} failed</small>` : ""}`) +
    tile("Audio", fmt(s.audio_s / 60, 1) + "<small>min</small>") +
    tile("Wall time", fmt(s.wall_s, 1) + "<small>s</small>") +
    tile("Speed", fmt(s.rtfx, 1) + "<small>× RT</small>") +
    tile("Engine", `${s.engine === "spark" ? "Spark" : "Local"}<small>${s.master || ""}</small>`) +
    tile("Languages", det || "—");
  // count how many files each Spark worker (hostname:pid) processed - proof the work was spread out
  const counts = {}; rows.forEach((r) => (counts[r.worker] = (counts[r.worker] || 0) + 1));
  const max = Math.max(...Object.values(counts), 1);
  $("#bDist").innerHTML = Object.entries(counts).map(([w, c]) =>
    `<div class="grid grid-cols-[90px_1fr_32px] items-center gap-3 font-mono text-xs text-mute"><span title="${esc(w)}">pid ${esc(w.split(":").pop())}</span>
     <div class="h-1.5 rounded-full bg-gradient-to-r from-acc to-acc2" style="width:${(100 * c) / max}%"></div><span class="text-right text-fg">${c}</span></div>`).join("");
  // CSV download link -> GET /api/jobs/<id>/csv
  $("#bCsv").href = `/api/jobs/${j.id}/csv`;
  // per-file table: id, language, hypothesis, reference, WER, audio seconds, inference seconds, worker
  $("#bTable").innerHTML = `<tr><th>ID</th><th>Lang</th><th>Hypothesis</th><th>Reference</th><th>WER</th><th>Audio s</th><th>Infer s</th><th>Worker</th></tr>` +
    rows.map((r) => `<tr><td class="font-mono text-xs text-mute">${esc(r.id)}</td><td class="font-mono text-xs">${CODE[r.language] || esc(r.language || "")}</td>
      <td class="min-w-[200px]">${r.error ? `<span class="text-acc">${esc(r.error)}</span>` : esc(r.hypothesis)}</td>
      <td class="min-w-[200px] text-mute">${esc(r.reference)}</td>
      <td class="num ${r.wer > 0.5 ? "text-acc" : r.wer === 0 ? "text-ok" : ""}">${pct(r.wer)}</td>
      <td class="num">${fmt(r.duration_s)}</td><td class="num">${fmt(r.infer_s)}</td><td class="font-mono text-xs text-mute">${esc((r.worker || "").split(":").pop())}</td></tr>`).join("");
}

// DOWNLOAD BUTTONS (LibriSpeech / FLEURS): start a download job, then refresh the dataset list
$$("[data-download]").forEach((b) => b.addEventListener("click", () => {
  toast(`Downloading ${b.textContent.trim()}…`);
  busy(true);
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
// selectDataset(): choose a dataset in every dataset dropdown
function selectDataset(path) { $$(".dataSel").forEach((s) => { if ([...s.options].some((o) => o.value === path)) s.value = path; }); }

// UPLOAD BUTTON: send your own audio files -> data/uploads/... with a new manifest.csv
$("#bUpload").addEventListener("change", async (e) => {
  const files = [...e.target.files]; if (!files.length) return;
  const fd = new FormData(); files.forEach((f) => fd.append("files", f, f.name)); fd.append("name", "upload");
  try { const r = await api("/api/upload", { method: "POST", body: fd }); toast(`Uploaded ${r.count} audio files`); await loadStatus(false); selectDataset(r.manifest); }
  catch (err) { toast(err.message, true); }
  e.target.value = "";
});

/* ========================================================= BENCHMARK */
// BENCHMARK RUN BUTTON: dataset, model, limit and the ticked worker counts
$("#kGo").addEventListener("click", () => {
  const wc = $$("#kWorkers input:checked").map((x) => parseInt(x.value, 10));
  if (!wc.length) return toast("Select at least one worker count", true);
  startJob("benchmark", { manifest: $("#kData").value, model: $("#kModel").value, worker_counts: wc, limit: intOrNull($("#kLimit").value) },
    "k", (j) => { loadHistory().then(() => renderBench(j.result)); });
});

// runLabel(): name of a run for the chart and table
function runLabel(r) {
  if (r.engine === "single-node") return "1 thread";
  if (r.engine === "single-node-mt") return `${r.threads} threads`;
  return `Spark ×${r.workers}`;
}
// renderBench(): wall-time bars + speed-up line + ideal (linear) line, drawn as SVG, plus the table
function renderBench(res) {
  if (!res) return;
  $("#kEmpty").hidden = true; $("#kOut").hidden = false;
  const draw = () => {
    const ACC = css("--color-acc"), ACC2 = css("--color-acc2"), LINE = css("--color-line"), CARD = css("--color-card");
    // chart size and margins
    const runs = res.runs, W = 640, H = 300, L = 46, R = 46, T = 22, B = 48, iw = W - L - R, ih = H - T - B;
    const maxWall = Math.max(...runs.map((r) => r.wall_s)) * 1.15;
    // Spark x1 run = basis for the ideal linear-scaling line
    const spark1 = runs.find((r) => r.engine === "spark" && r.workers === 1);
    // ideal(): perfect scaling = Spark x1 speed-up multiplied by the number of workers
    const ideal = (r) => (r.engine === "spark" && spark1 && r.speedup_vs_single ? (spark1.speedup_vs_single || 1) * r.workers : null);
    const maxSp = Math.max(1, ...runs.map((r) => Math.max(r.speedup_vs_single || 0, ideal(r) || 0))) * 1.15;
    // x = position of each run, yW = wall-time scale (left), yS = speed-up scale (right)
    const bw = iw / runs.length, x = (i) => L + bw * i + bw / 2;
    const yW = (v) => T + ih - (v / maxWall) * ih, yS = (v) => T + ih - (v / maxSp) * ih;
    // gridlines and axis labels
    let s = `<svg viewBox="0 0 ${W} ${H}"><g class="grid">`;
    for (let k = 0; k <= 4; k++) { const y = T + (ih * k) / 4; s += `<line x1="${L}" x2="${W - R}" y1="${y}" y2="${y}"/>`;
      s += `<text x="${L - 8}" y="${y + 4}" text-anchor="end">${(maxWall * (1 - k / 4)).toFixed(0)}s</text>`;
      s += `<text x="${W - R + 8}" y="${y + 4}">${(maxSp * (1 - k / 4)).toFixed(1)}×</text>`; }
    s += `</g>`;
    // grey bar = wall time of each run, with its label underneath
    runs.forEach((r, i) => {
      s += `<rect x="${x(i) - bw * 0.22}" y="${yW(r.wall_s)}" width="${bw * 0.44}" height="${T + ih - yW(r.wall_s)}" rx="6" fill="${css("--color-mute")}38"><title>${r.wall_s}s</title></rect>`;
      s += `<text x="${x(i)}" y="${H - B + 20}" text-anchor="middle">${runLabel(r)}</text>`;
      s += `<text x="${x(i)}" y="${H - B + 34}" text-anchor="middle" style="opacity:.7">${r.wall_s.toFixed(1)}s</text>`;
    });
    // dashed line = ideal speed-up
    const idealPts = runs.map((r, i) => (ideal(r) ? `${x(i)},${yS(ideal(r))}` : null)).filter(Boolean);
    if (idealPts.length > 1) s += `<polyline points="${idealPts.join(" ")}" fill="none" stroke="${ACC2}" stroke-width="1.6" stroke-dasharray="5 5"/>`;
    // solid line + dots = measured speed-up vs single-node
    s += `<polyline points="${runs.map((r, i) => `${x(i)},${yS(r.speedup_vs_single || 0)}`).join(" ")}" fill="none" stroke="${ACC}" stroke-width="2.2" stroke-linejoin="round"/>`;
    runs.forEach((r, i) => (s += `<circle cx="${x(i)}" cy="${yS(r.speedup_vs_single || 0)}" r="4.5" fill="${CARD}" stroke="${ACC}" stroke-width="2.2"><title>${fmt(r.speedup_vs_single)}×</title></circle>`));
    $("#kChart").innerHTML = s + "</svg>";
  };
  // remember this chart so it is redrawn when the theme changes
  redraw = redraw.filter((f) => f.kind !== "bench"); draw.kind = "bench"; redraw.push(draw); draw();
  // table under the chart: wall time, files/s, RTFx, speed-up, efficiency, model load time, WER
  $("#kTable").innerHTML = `<tr><th>Run</th><th>Wall s</th><th>Files/s</th><th>RTFx</th><th>Speed-up</th><th>Efficiency</th><th>Model load s</th><th>WER</th></tr>` +
    res.runs.map((r) => `<tr><td class="font-mono">${runLabel(r)}</td><td class="num">${fmt(r.wall_s)}</td><td class="num">${fmt(r.files_per_s)}</td><td class="num">${fmt(r.rtfx)}</td>
    <td class="num text-acc">${fmt(r.speedup_vs_single)}×</td><td class="num">${r.efficiency != null ? pct(r.efficiency) : "—"}</td><td class="num">${fmt(r.model_load_s_total)}</td><td class="num">${pct(r.wer)}</td></tr>`).join("");
  $("#kMeta").textContent = `${res.model} · ${res.files} files · ${res.cpu_count} CPU cores · ${res.created}. Speed-up is relative to the single-thread run; efficiency = speed-up (Spark ×k vs ×1) / k.`;
}

/* ============================================================= NOISE */
// ROBUSTNESS RUN BUTTON: WER/CER at clean, 20, 10, 5, 0 dB on Spark
$("#nGo").addEventListener("click", () => startJob("noise",
  { manifest: $("#nData").value, model: $("#nModel").value, limit: intOrNull($("#nLimit").value), engine: "spark" },
  "n", (j) => { loadHistory().then(() => renderNoise(j.result)); }));

// renderNoise(): WER and CER lines vs noise level, drawn as SVG, plus the table
function renderNoise(res) {
  if (!res) return;
  $("#nEmpty").hidden = true; $("#nOut").hidden = false;
  const draw = () => {
    const ACC = css("--color-acc"), ACC2 = css("--color-acc2"), CARD = css("--color-card");
    const P = res.points, W = 640, H = 270, L = 46, R = 20, T = 26, B = 36, iw = W - L - R, ih = H - T - B;
    // y axis goes a little above the highest error rate
    const maxY = Math.max(0.1, ...P.map((p) => Math.max(p.wer || 0, p.cer || 0))) * 1.15;
    const x = (i) => L + (iw * (i + 0.5)) / P.length, y = (v) => T + ih - (v / maxY) * ih;
    let s = `<svg viewBox="0 0 ${W} ${H}"><g class="grid">`;
    for (let k = 0; k <= 4; k++) { const yy = T + (ih * k) / 4; s += `<line x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}"/><text x="${L - 8}" y="${yy + 4}" text-anchor="end">${((maxY * (1 - k / 4)) * 100).toFixed(0)}%</text>`; }
    s += `</g>`;
    // one line + dots for WER and one for CER
    [["wer", ACC], ["cer", ACC2]].forEach(([k, c]) => {
      s += `<polyline points="${P.map((p, i) => `${x(i)},${y(p[k] || 0)}`).join(" ")}" fill="none" stroke="${c}" stroke-width="2.2" stroke-linejoin="round"/>`;
      P.forEach((p, i) => (s += `<circle cx="${x(i)}" cy="${y(p[k] || 0)}" r="4.5" fill="${CARD}" stroke="${c}" stroke-width="2.2"><title>${k.toUpperCase()} ${pct(p[k])}</title></circle>`));
    });
    P.forEach((p, i) => (s += `<text x="${x(i)}" y="${H - B + 20}" text-anchor="middle">${p.label}</text>`));
    s += `<text x="${W - R}" y="${T - 8}" text-anchor="end" style="fill:${ACC}">WER</text><text x="${W - R - 44}" y="${T - 8}" text-anchor="end" style="fill:${ACC2}">CER</text>`;
    $("#nChart").innerHTML = s + "</svg>";
  };
  redraw = redraw.filter((f) => f.kind !== "noise"); draw.kind = "noise"; redraw.push(draw); draw();
  // table under the chart
  $("#nTable").innerHTML = `<tr><th>SNR</th><th>WER</th><th>CER</th><th>Wall s</th></tr>` +
    res.points.map((p) => `<tr><td class="font-mono">${p.label}</td><td class="num">${pct(p.wer)}</td><td class="num">${pct(p.cer)}</td><td class="num">${fmt(p.wall_s)}</td></tr>`).join("") +
    `<tr><td colspan="4" class="text-xs text-mute">${res.model} · ${res.files} files · ${res.engine} · ${res.created}</td></tr>`;
}

/* ============================================================ history */
// HISTORY: saved experiments from results/ (GET /api/results)
let HIST = [];
async function loadHistory() {
  HIST = await api("/api/results");
  // fill a history dropdown and show the newest saved run
  const fill = (sel, kind, render) => {
    const items = HIST.filter((h) => h.kind === kind);
    sel.innerHTML = items.length ? items.map((h, i) => `<option value="${i}">${h.created} · ${h.model} · ${h.files} files</option>`).join("") : `<option>No saved runs</option>`;
    sel.onchange = () => render(items[sel.value]);
    if (items.length) render(items[0]);
  };
  fill($("#kHist"), "benchmark", renderBench);
  fill($("#nHist"), "noise", renderNoise);
}

// START-UP: load the status (fills dropdowns), then the saved history
loadStatus(false).then(loadHistory).catch((e) => toast("Server not reachable: " + e.message, true));
