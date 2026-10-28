// Optional transition sounds, synthesised with the Web Audio API (no files).
// Off by default; the AudioContext is only created after a user gesture.
let ctx = null, master = null, enabled = false;

export const isEnabled = () => enabled;

export function setEnabled(on) {
  enabled = on;
  if (on) prime();
}

// Call synchronously inside a click handler so browsers allow audio.
export function prime() {
  if (!enabled) return;
  try {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      master = ctx.createGain(); master.gain.value = 0.32; master.connect(ctx.destination);
    }
    if (ctx.state === "suspended") ctx.resume();
  } catch (_) { ctx = null; }
}

function noise(seconds) {
  const b = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * seconds), ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const s = ctx.createBufferSource(); s.buffer = b; return s;
}
const ready = () => enabled && ctx && master;

// Portal: airy whoosh with a rising tone
export function whoosh(delay = 0, dur = 1.6) {
  if (!ready()) return;
  const t = ctx.currentTime + delay;
  const n = noise(dur + 0.2), bp = ctx.createBiquadFilter(), g = ctx.createGain();
  bp.type = "bandpass"; bp.Q.value = 0.9;
  bp.frequency.setValueAtTime(250, t); bp.frequency.exponentialRampToValueAtTime(4200, t + dur);
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.5, t + dur * 0.8); g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.15);
  n.connect(bp).connect(g).connect(master); n.start(t); n.stop(t + dur + 0.2);
  const o = ctx.createOscillator(), og = ctx.createGain();
  o.type = "sine"; o.frequency.setValueAtTime(180, t); o.frequency.exponentialRampToValueAtTime(1240, t + dur);
  og.gain.setValueAtTime(0.0001, t); og.gain.exponentialRampToValueAtTime(0.08, t + dur * 0.85); og.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.25);
  o.connect(og).connect(master); o.start(t); o.stop(t + dur + 0.3);
}

// Portal: soft shimmer at the flash
export function shimmer(delay = 0) {
  if (!ready()) return;
  const t = ctx.currentTime + delay;
  [1318.5, 1975.5, 2637].forEach((f, i) => {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = "sine"; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t + i * 0.03); g.gain.exponentialRampToValueAtTime(0.05, t + i * 0.03 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.03 + 0.9);
    o.connect(g).connect(master); o.start(t + i * 0.03); o.stop(t + 1.0);
  });
}

// Black hole: deep rumble that sinks in pitch
export function rumble(delay = 0, dur = 1.5) {
  if (!ready()) return;
  const t = ctx.currentTime + delay;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = "sine"; o.frequency.setValueAtTime(70, t); o.frequency.exponentialRampToValueAtTime(28, t + dur);
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.5, t + dur * 0.7); g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.1);
  o.connect(g).connect(master); o.start(t); o.stop(t + dur + 0.15);
  const n = noise(dur + 0.2), lp = ctx.createBiquadFilter(), ng = ctx.createGain();
  lp.type = "lowpass"; lp.frequency.setValueAtTime(300, t); lp.frequency.exponentialRampToValueAtTime(90, t + dur);
  ng.gain.setValueAtTime(0.0001, t); ng.gain.exponentialRampToValueAtTime(0.35, t + dur * 0.8); ng.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.1);
  n.connect(lp).connect(ng).connect(master); n.start(t); n.stop(t + dur + 0.2);
}

// Black hole: the white-hole burst
export function boom(delay = 0) {
  if (!ready()) return;
  const t = ctx.currentTime + delay;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(35, t + 0.5);
  g.gain.setValueAtTime(0.8, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
  o.connect(g).connect(master); o.start(t); o.stop(t + 0.75);
  shimmer(0.05);
}
