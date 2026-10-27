// Shared helpers for the WebGL transitions.
import { TOKENS } from "../tokens.js?v=3";

export const DEBUG = new URLSearchParams(location.search).has("debug");
export const ROUTE_NAMES = { dashboard: "Dashboard", transcribe: "Transcribe", batch: "Batch", benchmark: "Benchmark", robustness: "Robustness", how: "How it works" };

// Run a paused GSAP timeline, rendering every tick; resolves when it ends.
export function animate(tl, render) {
  return new Promise((resolve) => {
    const tick = () => render();
    gsap.ticker.add(tick);
    tl.eventCallback("onComplete", () => { gsap.ticker.remove(tick); render(); resolve(); });
    if (DEBUG) window.__voxTl = tl;      // ?debug: lets tests scrub the timeline
    if (DEBUG && window.__voxHold) tl.pause(0); else tl.play(0);
  });
}

// Free every geometry, material and texture in a scene graph.
export function disposeScene(root, keep = []) {
  const seen = new Set(keep);
  const freeTex = (t) => { if (t && t.isTexture && !seen.has(t)) { seen.add(t); t.dispose(); } };
  root.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    mats.forEach((m) => {
      Object.values(m).forEach(freeTex);
      if (m.uniforms) Object.values(m.uniforms).forEach((u) => freeTex(u && u.value));
      m.dispose();
    });
  });
  if (root.environment) freeTex(root.environment);
  if (root.background && root.background.isTexture) freeTex(root.background);
}

// Soft round sprite texture (pink glow) drawn on a canvas.
export function glowTexture(THREE, color = TOKENS.color.pink, size = 256) {
  const c = document.createElement("canvas"); c.width = c.height = size;
  const g = c.getContext("2d"), r = size / 2;
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0, color); grad.addColorStop(0.25, color + "aa"); grad.addColorStop(1, color + "00");
  g.fillStyle = grad; g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

export function color(THREE, hex) { return new THREE.Color(hex); }   // hex -> linear THREE.Color

// Perspective camera whose z=0 plane exactly fills the viewport (world height = 2).
export function fitCamera(THREE, width, height, fov) {
  const cam = new THREE.PerspectiveCamera(fov, width / height, 0.01, 200);
  const d = 1 / Math.tan(THREE.MathUtils.degToRad(fov / 2));
  cam.position.set(0, 0, d);
  cam.userData.d = d;
  return cam;
}
