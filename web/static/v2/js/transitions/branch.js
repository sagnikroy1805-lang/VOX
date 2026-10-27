// TRANSITION E — GROWING CHERRY BRANCH
// A dark cherry branch grows across the screen from the click point and flowers
// bloom along it. Petals drift down; wherever a petal settles, the incoming page
// shows through in a soft circle, until the whole screen has turned over. The
// branch then fades away, leaving the new page.
import { TOKENS } from "../tokens.js?v=3";
import { animate, disposeScene } from "./util.js?v=3";

const C = TOKENS.color;

const VERT = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const FRAG = /* glsl */`
uniform sampler2D uA; uniform sampler2D uB; uniform sampler2D uMask; uniform sampler2D uOver;
uniform float uDim; uniform float uFill; uniform float uOverA;
varying vec2 vUv;
void main() {
  float m = max(texture2D(uMask, vUv).r, uFill);
  vec3 a = texture2D(uA, vUv).rgb * (1.0 - uDim);
  vec3 b = texture2D(uB, vUv).rgb;
  vec3 col = mix(a, b, smoothstep(0.05, 0.95, m));
  vec4 o = texture2D(uOver, vUv) * uOverA;  // branch + blossoms + petals (premultiplied), faded at the end
  col = col * (1.0 - o.a) + o.rgb;
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

const rnd = (a, b) => a + Math.random() * (b - a);
const ease = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : 1 - Math.pow(1 - t, 3));

// ---------- procedural branch: list of segments with grow times ----------
function buildBranch(W, H, ox, oy) {
  const segs = [], flowers = [];
  const tx = ox < W / 2 ? W * 1.05 : -W * 0.05;             // grow towards the far side
  const ty = H * rnd(0.25, 0.75);
  function grow(x, y, ang, len, width, depth, t0) {
    const steps = Math.max(3, Math.round(len / 34));
    let px = x, py = y, a = ang, t = t0;
    for (let i = 0; i < steps; i++) {
      a += rnd(-0.28, 0.28);
      const sl = len / steps;
      const nx = px + Math.cos(a) * sl, ny = py + Math.sin(a) * sl;
      const w = width * (1 - (i / steps) * 0.65);
      const dt = 0.9 * (sl / Math.max(W, H)) * (1 + depth * 0.4);
      segs.push({ x1: px, y1: py, x2: nx, y2: ny, w, t0: t, t1: t + dt });
      t += dt;
      if (depth < 3 && Math.random() < 0.28 - depth * 0.05)
        grow(nx, ny, a + (Math.random() < 0.5 ? -1 : 1) * rnd(0.5, 1.0), len * rnd(0.32, 0.5), w * 0.6, depth + 1, t);
      if (Math.random() < (depth === 0 ? 0.35 : 0.6))
        flowers.push({ x: nx + rnd(-10, 10), y: ny + rnd(-10, 10), r: rnd(11, 22) * (Math.min(W, H) / 800 + 0.4), rot: rnd(0, 6.28), t0: t + rnd(0.05, 0.25), bud: Math.random() < 0.25 });
      px = nx; py = ny;
    }
  }
  const ang = Math.atan2(ty - oy, tx - ox);
  const len = Math.hypot(tx - ox, ty - oy) * 1.05;
  grow(ox, oy, ang, len, Math.min(W, H) * 0.02, 0, 0.05);
  return { segs, flowers };
}

function drawPetalShape(g, s) {        // one cherry petal, pointing up, length s
  g.beginPath();
  g.moveTo(0, 0);
  g.bezierCurveTo(-s * 0.55, -s * 0.25, -s * 0.5, -s * 0.95, -s * 0.12, -s);
  g.lineTo(0, -s * 0.86);                                     // the little notch
  g.lineTo(s * 0.12, -s);
  g.bezierCurveTo(s * 0.5, -s * 0.95, s * 0.55, -s * 0.25, 0, 0);
  g.closePath();
}

export async function play(fromTex, toTex, opts) {
  const { renderer, THREE, width: W, height: H, origin, sound } = opts;
  const scale = Math.min(window.devicePixelRatio || 1, 1.5);
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  // overlay canvas (branch, blossoms, falling petals) and reveal mask (half res)
  const over = document.createElement("canvas"); over.width = Math.round(W * scale); over.height = Math.round(H * scale);
  const og = over.getContext("2d"); og.scale(scale, scale);
  const mask = document.createElement("canvas"); mask.width = Math.round(W / 2); mask.height = Math.round(H / 2);
  const mg = mask.getContext("2d");
  const dot = document.createElement("canvas"); dot.width = dot.height = 128;
  { const g = dot.getContext("2d"), gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, "rgba(255,255,255,1)"); gr.addColorStop(0.55, "rgba(255,255,255,.9)"); gr.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = gr; g.fillRect(0, 0, 128, 128); }
  const overTex = new THREE.CanvasTexture(over); overTex.colorSpace = THREE.SRGBColorSpace; overTex.premultiplyAlpha = true;
  const maskTex = new THREE.CanvasTexture(mask);

  const mat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, depthTest: false, depthWrite: false,
    uniforms: { uA: { value: fromTex }, uB: { value: toTex }, uMask: { value: maskTex }, uOver: { value: overTex }, uDim: { value: 0 }, uFill: { value: 0 }, uOverA: { value: 1 } } });
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat));

  const ox = Math.min(W - 40, Math.max(40, origin.x)), oy = Math.min(H * 0.6, Math.max(H * 0.18, origin.y));
  const { segs, flowers } = buildBranch(W, H, ox, oy);

  // falling petals: from blossoms, plus a drift from above so the whole screen turns over
  const petals = [];
  const cover = Math.round((W * H) / 9000);
  flowers.forEach((f) => { for (let k = 0; k < 3; k++) petals.push({ x: f.x, y: f.y, t0: f.t0 + rnd(0.25, 0.9) }); });
  for (let k = 0; k < cover; k++) petals.push({ x: rnd(-40, W + 40), y: rnd(-H * 0.5, -10), t0: rnd(0.55, 1.5) });
  petals.forEach((p) => Object.assign(p, {
    land: rnd(H * 0.05, H * 1.0), vy: rnd(H * 0.35, H * 0.6), sway: rnd(18, 50), fr: rnd(1.5, 3.2), ph: rnd(0, 6.28),
    s: rnd(9, 17) * (Math.min(W, H) / 800 + 0.45), spin: rnd(-3, 3), flip: rnd(2, 5), landed: false, lt: 0, R: rnd(70, 140) * (Math.max(W, H) / 1400 + 0.3),
    col: [C.pink, C.pinkMid, C.pinkDeep][Math.floor(Math.random() * 3)],
  }));

  const st = { t: 0, fade: 0 };
  const T = 2.75;
  const tl = gsap.timeline({ paused: true });
  tl.to(st, { t: T, duration: T, ease: "none" }, 0);
  tl.to(mat.uniforms.uDim, { value: 0.35, duration: 0.8, ease: "power2.out" }, 0);
  tl.to(mat.uniforms.uFill, { value: 1, duration: 0.45, ease: "power2.in" }, T - 0.6);
  tl.to(mat.uniforms.uOverA, { value: 0, duration: 0.5, ease: "power2.in" }, T - 0.55);
  tl.add(() => sound.whoosh(0, 1.4), 0.6);

  const branchCol = "#2a0d1c", barkHi = "rgba(224,138,168,.35)";
  const render = () => {
    const t = st.t;
    // ---- reveal mask
    mg.setTransform(1, 0, 0, 1, 0, 0);
    mg.clearRect(0, 0, mask.width, mask.height);
    petals.forEach((p) => {
      if (!p.landed) return;
      const k = ease((t - p.lt) / 0.6), r = p.R * k * 0.5;
      if (r > 0.5) mg.drawImage(dot, p.lx / 2 - r, p.ly / 2 - r, r * 2, r * 2);
    });
    // ---- overlay
    og.clearRect(0, 0, W, H);
    og.globalAlpha = 1 - st.fade;
    og.lineCap = "round";
    segs.forEach((s) => {
      const k = (t - s.t0) / (s.t1 - s.t0);
      if (k <= 0) return;
      const f = Math.min(1, k);
      const x2 = s.x1 + (s.x2 - s.x1) * f, y2 = s.y1 + (s.y2 - s.y1) * f;
      og.strokeStyle = branchCol; og.lineWidth = s.w;
      og.beginPath(); og.moveTo(s.x1, s.y1); og.lineTo(x2, y2); og.stroke();
      og.strokeStyle = barkHi; og.lineWidth = Math.max(1, s.w * 0.18);
      og.beginPath(); og.moveTo(s.x1, s.y1 - s.w * 0.25); og.lineTo(x2, y2 - s.w * 0.25); og.stroke();
    });
    flowers.forEach((f) => {
      const k = ease((t - f.t0) / 0.45);
      if (k <= 0) return;
      og.save(); og.translate(f.x, f.y); og.rotate(f.rot);
      const n = f.bud ? 1 : 5, open = f.bud ? 0.55 : 0.35 + 0.65 * k;
      for (let i = 0; i < n; i++) {
        og.save(); og.rotate((i / 5) * Math.PI * 2);
        const gr = og.createLinearGradient(0, 0, 0, -f.r * k);
        gr.addColorStop(0, C.crimson); gr.addColorStop(0.35, C.pinkDeep); gr.addColorStop(1, C.pink);
        og.fillStyle = gr; og.scale(open, 1);
        drawPetalShape(og, f.r * k); og.fill(); og.restore();
      }
      if (!f.bud) {                                            // stamens
        og.fillStyle = C.crimson; og.beginPath(); og.arc(0, 0, f.r * 0.18 * k, 0, 6.283); og.fill();
        og.strokeStyle = C.pinkDeep; og.lineWidth = 1;
        for (let i = 0; i < 9; i++) { const a = (i / 9) * 6.283, l = f.r * 0.55 * k;
          og.beginPath(); og.moveTo(0, 0); og.lineTo(Math.cos(a) * l, Math.sin(a) * l); og.stroke();
          og.fillStyle = C.pink; og.beginPath(); og.arc(Math.cos(a) * l, Math.sin(a) * l, 1.6, 0, 6.283); og.fill(); }
      }
      og.restore();
    });
    petals.forEach((p) => {
      const dt = t - p.t0;
      if (dt <= 0) return;
      let y = p.y + dt * p.vy + dt * dt * 18;
      const x = p.x + Math.sin(dt * p.fr + p.ph) * p.sway + dt * 40;
      if (!p.landed && y >= p.land) { p.landed = true; p.lt = t; p.lx = x; p.ly = p.land; }
      if (p.landed) { const k = (t - p.lt) / 0.35; if (k >= 1) return; og.globalAlpha = (1 - k) * (1 - st.fade); y = p.land; }
      else og.globalAlpha = 1 - st.fade;
      og.save(); og.translate(x, y); og.rotate(p.ph + dt * p.spin); og.scale(Math.cos(dt * p.flip + p.ph) * 0.8 + 0.2, 1);
      og.fillStyle = p.col; drawPetalShape(og, p.s); og.fill(); og.restore();
    });
    og.globalAlpha = 1;
    overTex.needsUpdate = true; maskTex.needsUpdate = true;
    renderer.render(scene, camera);
  };
  render();
  opts.onCovered && opts.onCovered();
  await animate(tl, render);
  disposeScene(scene, [fromTex, toTex]);
}
