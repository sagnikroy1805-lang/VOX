// TRANSITION E — GROWING CHERRY BRANCH  (GPU version)
// A tapered cherry branch reaches in from the edge of the screen and grows across it;
// clusters of blossoms open along it. Petals drift down, and wherever a petal settles
// the incoming page shows through in a soft circle, until the whole screen has turned
// over. The branch then fades, leaving the new page.
//
// Performance: the branch is painted ONCE (colour + a "grow-time" map) and revealed
// in the shader; blossoms, falling petals and the reveal circles are instanced quads
// whose motion is computed on the GPU — only a few uniforms change per frame.
import { TOKENS } from "../tokens.js?v=3";
import { animate, disposeScene } from "./util.js?v=3";

const C = TOKENS.color;
const T = 2.8;              // total duration (s)
const GROW = 1.25;          // branch growth window (s)

const rnd = (a, b) => a + Math.random() * (b - a);

// ------------------------------------------------------------ shaders
const FULL_VERT = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy * 2.0, 0.0, 1.0); }`;

const BASE_FRAG = /* glsl */`
uniform sampler2D uA; uniform sampler2D uB; uniform sampler2D uMask; uniform sampler2D uBranch; uniform sampler2D uTimeMap;
uniform float uT; uniform float uDim; uniform float uFill; uniform float uBranchA;
varying vec2 vUv;
void main() {
  float m = clamp(max(texture2D(uMask, vUv).r, uFill), 0.0, 1.0);
  vec3 a = texture2D(uA, vUv).rgb * (1.0 - uDim);
  vec3 col = mix(a, texture2D(uB, vUv).rgb, smoothstep(0.05, 0.9, m));
  vec4 br = texture2D(uBranch, vUv);
  float born = texture2D(uTimeMap, vUv).r * ${GROW.toFixed(2)};
  float grown = smoothstep(born - 0.015, born + 0.015, uT) * uBranchA;
  col = mix(col, br.rgb, br.a * grown);
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

// screen-space instanced sprite (pixel coordinates, y down)
const SPRITE_VERT = /* glsl */`
attribute vec2 aPos; attribute float aSize; attribute float aRot; attribute float aT0; attribute float aKind;
uniform float uT; uniform vec2 uRes;
varying vec2 vUv; varying float vKind; varying float vK;
void main() {
  float k = clamp((uT - aT0) / 0.5, 0.0, 1.0);
  float m = k - 1.0;
  float s = k == 0.0 ? 0.0 : 1.0 + 2.70158 * m * m * m + 1.70158 * m * m;   // back.out (no pow of negatives)
  vec2 p = vec2(position.x, -position.y) * aSize * s;   // canvas sprites are y-down
  float r = aRot + (1.0 - k) * 0.9;
  p = mat2(cos(r), sin(r), -sin(r), cos(r)) * p;
  vec2 px = aPos + p;
  gl_Position = vec4(px.x / uRes.x * 2.0 - 1.0, 1.0 - px.y / uRes.y * 2.0, 0.0, 1.0);
  vUv = uv; vKind = aKind; vK = k;
}`;
const FLOWER_FRAG = /* glsl */`
uniform sampler2D uAtlas; uniform float uA;
varying vec2 vUv; varying float vKind; varying float vK;
void main() {
  vec4 c = texture2D(uAtlas, vec2(vUv.x * 0.5 + vKind * 0.5, vUv.y));
  if (c.a < 0.01 || vK <= 0.0) discard;
  gl_FragColor = vec4(c.rgb, c.a * uA);
  #include <colorspace_fragment>
}`;

const PETAL_VERT = /* glsl */`
attribute vec2 aStart; attribute vec4 aMove;   // vy, sway, freq, phase
attribute vec4 aSpin;                         // size, spin, flip, tint
attribute vec2 aTimes;                        // t0, tLand
uniform float uT; uniform vec2 uRes;
varying vec2 vUv; varying float vTint; varying float vAlpha;
void main() {
  float dt = uT - aTimes.x;
  float dl = aTimes.y - aTimes.x;
  float dc = clamp(dt, 0.0, dl);
  float y = aStart.y + dc * aMove.x + dc * dc * 18.0;
  float x = aStart.x + sin(dc * aMove.z + aMove.w) * aMove.y + dc * 40.0;
  float land = clamp((uT - aTimes.y) / 0.35, 0.0, 1.0);
  vAlpha = step(0.0, dt) * (1.0 - land);
  float rot = aMove.w + dc * aSpin.y;
  float flip = cos(dc * aSpin.z + aMove.w) * 0.8 + 0.2;
  vec2 p = vec2(position.x, -position.y) * vec2(aSpin.x * 0.82 * flip, aSpin.x);
  p = mat2(cos(rot), sin(rot), -sin(rot), cos(rot)) * p;
  vec2 px = vec2(x, y) + p;
  gl_Position = vec4(px.x / uRes.x * 2.0 - 1.0, 1.0 - px.y / uRes.y * 2.0, 0.0, 1.0);
  vUv = uv; vTint = aSpin.w;
}`;
const PETAL_FRAG = /* glsl */`
uniform sampler2D uPetal; uniform vec3 uPink; uniform vec3 uPinkMid; uniform vec3 uPinkDeep; uniform float uA;
varying vec2 vUv; varying float vTint; varying float vAlpha;
void main() {
  vec4 c = texture2D(uPetal, vUv);
  if (c.a < 0.02 || vAlpha <= 0.0) discard;
  vec3 tint = vTint < 0.33 ? uPink : vTint < 0.66 ? uPinkMid : uPinkDeep;
  gl_FragColor = vec4(c.rgb * tint, c.a * vAlpha * uA);
  #include <colorspace_fragment>
}`;

// reveal circles, rendered into a half-resolution mask target
const MASK_VERT = /* glsl */`
attribute vec2 aLand; attribute vec2 aInfo;   // tLand, radius
uniform float uT; uniform vec2 uRes;
varying vec2 vUv;
void main() {
  float k = clamp((uT - aInfo.x) / 0.6, 0.0, 1.0);
  k = 1.0 - pow(1.0 - k, 3.0);
  vec2 px = aLand + position.xy * aInfo.y * 2.0 * k;
  gl_Position = vec4(px.x / uRes.x * 2.0 - 1.0, 1.0 - px.y / uRes.y * 2.0, 0.0, 1.0);
  vUv = uv;
}`;
const MASK_FRAG = /* glsl */`
varying vec2 vUv;
void main() { float d = length(vUv - 0.5) * 2.0; float a = 1.0 - smoothstep(0.55, 1.0, d); if (a <= 0.0) discard; gl_FragColor = vec4(a, a, a, 1.0); }`;

// ------------------------------------------------------------ painting helpers
function petalPath(g, s) {
  g.beginPath();
  g.moveTo(0, 0);
  g.bezierCurveTo(-s * 0.56, -s * 0.22, -s * 0.52, -s * 0.94, -s * 0.13, -s);
  g.lineTo(0, -s * 0.85);
  g.lineTo(s * 0.13, -s);
  g.bezierCurveTo(s * 0.52, -s * 0.94, s * 0.56, -s * 0.22, 0, 0);
  g.closePath();
}

// atlas: left = open blossom, right = bud (256x256 each)
function flowerAtlas() {
  const c = document.createElement("canvas"); c.width = 512; c.height = 256;
  const g = c.getContext("2d");
  g.save(); g.translate(128, 128);
  for (let i = 0; i < 5; i++) {
    g.save(); g.rotate((i / 5) * Math.PI * 2);
    const gr = g.createLinearGradient(0, 0, 0, -118);
    gr.addColorStop(0, C.crimson); gr.addColorStop(0.28, C.pinkDeep); gr.addColorStop(0.7, C.pinkMid); gr.addColorStop(1, C.pink);
    g.fillStyle = gr; petalPath(g, 118); g.fill();
    g.strokeStyle = "rgba(180,35,90,.25)"; g.lineWidth = 1.5;
    for (let v = -1; v <= 1; v++) { g.beginPath(); g.moveTo(0, -10); g.quadraticCurveTo(v * 16, -60, v * 26, -96); g.stroke(); }
    g.restore();
  }
  g.fillStyle = C.crimson; g.beginPath(); g.arc(0, 0, 20, 0, Math.PI * 2); g.fill();
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2 + (i % 2) * 0.1, l = 46 + (i % 3) * 10;
    g.strokeStyle = C.pinkDeep; g.lineWidth = 2.2; g.beginPath(); g.moveTo(0, 0); g.lineTo(Math.cos(a) * l, Math.sin(a) * l); g.stroke();
    g.fillStyle = C.pink; g.beginPath(); g.arc(Math.cos(a) * l, Math.sin(a) * l, 4.5, 0, Math.PI * 2); g.fill();
  }
  g.restore();
  g.save(); g.translate(384, 150);
  const bg = g.createLinearGradient(0, 40, 0, -100);
  bg.addColorStop(0, C.crimson); bg.addColorStop(0.5, C.pinkDeep); bg.addColorStop(1, C.pinkMid);
  g.fillStyle = bg;
  g.beginPath(); g.ellipse(0, -40, 46, 64, 0, 0, Math.PI * 2); g.fill();
  g.strokeStyle = "rgba(180,35,90,.4)"; g.lineWidth = 2; g.beginPath(); g.moveTo(0, 20); g.quadraticCurveTo(-10, -40, 0, -100); g.stroke();
  g.fillStyle = "#2a0d1c"; g.beginPath(); g.moveTo(-26, 14); g.quadraticCurveTo(0, 40, 26, 14); g.quadraticCurveTo(0, 30, -26, 14); g.fill();
  g.restore();
  return c;
}

function petalSprite() {
  const c = document.createElement("canvas"); c.width = c.height = 128;
  const g = c.getContext("2d"); g.translate(64, 122);
  const gr = g.createLinearGradient(0, 0, 0, -116);
  gr.addColorStop(0, "rgba(200,120,150,1)"); gr.addColorStop(0.4, "#ffffff"); gr.addColorStop(1, "#ffffff");
  g.fillStyle = gr; petalPath(g, 116); g.fill();
  return c;
}

// smooth path through control points (Catmull-Rom), dense points ~step px apart
function smoothPath(ctrl, step = 2) {
  const out = [];
  for (let i = 0; i < ctrl.length - 1; i++) {
    const p0 = ctrl[Math.max(0, i - 1)], p1 = ctrl[i], p2 = ctrl[i + 1], p3 = ctrl[Math.min(ctrl.length - 1, i + 2)];
    const len = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]), n = Math.max(2, Math.ceil(len / step));
    for (let j = 0; j < n; j++) {
      const t = j / n, t2 = t * t, t3 = t2 * t;
      out.push([0, 1].map((k) => 0.5 * (2 * p1[k] + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3)));
    }
  }
  out.push(ctrl[ctrl.length - 1]);
  return out;
}

function buildTree(W, H, fromLeft) {
  const S = Math.min(W, H) / 900;
  const dir = fromLeft ? 1 : -1, x0 = fromLeft ? -30 : W + 30;
  const y0 = H * rnd(0.08, 0.2);
  const ctrl = [[x0, y0]];
  const n = 6;
  for (let i = 1; i <= n; i++) {
    const f = i / n;
    ctrl.push([x0 + dir * W * 0.86 * f, y0 + H * (0.12 * Math.sin(f * 3.1) + 0.22 * f * f) + rnd(-H * 0.03, H * 0.03)]);
  }
  const branches = [{ pts: smoothPath(ctrl), w0: 34 * S + 6, w1: 3, t0: 0, t1: GROW * 0.78 }];
  const main = branches[0].pts;
  const k = 7;
  for (let i = 0; i < k; i++) {
    const at = Math.floor(main.length * (0.12 + 0.8 * (i / k) + rnd(-0.03, 0.03)));
    const [bx, by] = main[at];
    const up = i % 2 === 0 ? -1 : 1;
    const L = Math.min(W, H) * rnd(0.18, 0.34) * (1 - (i / k) * 0.4);
    const a = Math.atan2(up * 0.6 + 0.4, dir * 1.0);
    const c2 = [[bx, by]];
    for (let j = 1; j <= 3; j++) c2.push([bx + Math.cos(a) * L * j / 3 + rnd(-12, 12), by + Math.sin(a) * L * j / 3 + j * j * 8 * S + rnd(-10, 10)]);
    const ft = (at / main.length) * branches[0].t1;
    const width = (branches[0].w0 + (branches[0].w1 - branches[0].w0) * (at / main.length)) * 0.55;
    branches.push({ pts: smoothPath(c2), w0: width, w1: 2, t0: ft, t1: ft + rnd(0.3, 0.45) });
  }
  const flowers = [];
  branches.forEach((b, bi) => {
    const every = bi === 0 ? 70 : 46;
    for (let i = Math.floor(b.pts.length * (bi === 0 ? 0.25 : 0.2)); i < b.pts.length; i += Math.max(8, Math.round(every * rnd(0.6, 1.3)))) {
      const [x, y] = b.pts[i], t = b.t0 + (b.t1 - b.t0) * (i / b.pts.length);
      const cluster = Math.round(rnd(2, 4.5));
      for (let c = 0; c < cluster; c++)
        flowers.push({ x: x + rnd(-22, 22) * S, y: y + rnd(-20, 16) * S, size: rnd(18, 34) * S + 6, rot: rnd(0, 6.28), t0: t + rnd(0.05, 0.3), kind: Math.random() < 0.22 ? 1 : 0 });
    }
    const [ex, ey] = b.pts[b.pts.length - 1];
    flowers.push({ x: ex, y: ey, size: 26 * S + 6, rot: rnd(0, 6.28), t0: b.t1 + 0.05, kind: 0 });
  });
  return { branches, flowers };
}

function paintBranches(W, H, branches) {
  const col = document.createElement("canvas"), tm = document.createElement("canvas");
  col.width = tm.width = W; col.height = tm.height = H;
  const g = col.getContext("2d"), h = tm.getContext("2d");
  h.fillStyle = "#fff"; h.fillRect(0, 0, W, H);                // white = never grows here
  branches.forEach((b) => {
    const n = b.pts.length;
    b.pts.forEach(([x, y], i) => {
      const f = i / (n - 1), w = b.w0 + (b.w1 - b.w0) * Math.pow(f, 0.8), t = b.t0 + (b.t1 - b.t0) * f;
      const v = Math.round(Math.min(1, t / GROW) * 254);
      h.fillStyle = `rgb(${v},${v},${v})`; h.beginPath(); h.arc(x, y, w / 2 + 1, 0, Math.PI * 2); h.fill();
      g.fillStyle = "#1c0710"; g.beginPath(); g.arc(x, y, w / 2, 0, Math.PI * 2); g.fill();
    });
    b.pts.forEach(([x, y], i) => {
      const f = i / (n - 1), w = b.w0 + (b.w1 - b.w0) * Math.pow(f, 0.8);
      g.fillStyle = "rgba(224,138,168,.16)"; g.beginPath(); g.arc(x, y - w * 0.22, w * 0.2, 0, Math.PI * 2); g.fill();
      if (i % 9 === 0 && w > 6) { g.fillStyle = "rgba(0,0,0,.35)"; g.fillRect(x - w * 0.3, y - 1, w * 0.6, 2); }
    });
  });
  return { col, tm };
}

// ------------------------------------------------------------ play
export async function play(fromTex, toTex, opts) {
  const { renderer, THREE, width: W, height: H, origin, sound } = opts;
  const res = new THREE.Vector2(W, H);
  const fromLeft = origin.x < W * 0.5;
  const S = Math.min(W, H) / 900;

  const { branches, flowers } = buildTree(W, H, fromLeft);
  const { col, tm } = paintBranches(W, H, branches);
  const tex = (c, srgb) => { const t = new THREE.CanvasTexture(c); if (srgb) t.colorSpace = THREE.SRGBColorSpace; t.minFilter = THREE.LinearFilter; t.generateMipmaps = false; return t; };
  const branchTex = tex(col, true), timeTex = tex(tm, false);
  const atlasTex = tex(flowerAtlas(), true), petalTex = tex(petalSprite(), true);

  const maskRT = new THREE.WebGLRenderTarget(Math.ceil(W / 2), Math.ceil(H / 2), { depthBuffer: false });
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  // falling petals: from the blossoms, plus a drift from above so the whole screen turns over
  const P = [];
  flowers.forEach((f) => { if (Math.random() < 0.8) P.push([f.x, f.y, f.t0 + rnd(0.25, 0.8)]); });
  const extra = Math.round((W * H) / 6500);
  for (let i = 0; i < extra; i++) P.push([rnd(-40, W + 40), rnd(-H * 0.5, H * 0.35), rnd(0.45, 1.5)]);
  const N = P.length;
  const aStart = new Float32Array(N * 2), aMove = new Float32Array(N * 4), aSpin = new Float32Array(N * 4), aTimes = new Float32Array(N * 2);
  const aLand = new Float32Array(N * 2), aInfo = new Float32Array(N * 2);
  P.forEach(([x, y, t0], i) => {
    const vy = rnd(H * 0.4, H * 0.7), sway = rnd(16, 46) * (S + 0.4), fr = rnd(1.4, 3.0), ph = rnd(0, 6.28);
    const dl = rnd(0.45, Math.max(0.5, 2.1 - t0));            // every petal settles before the end
    const land = y + vy * dl + 18 * dl * dl;
    aStart.set([x, y], i * 2); aMove.set([vy, sway, fr, ph], i * 4);
    aSpin.set([rnd(10, 18) * (S + 0.45), rnd(-3, 3), rnd(2, 5), Math.random()], i * 4);
    aTimes.set([t0, t0 + dl], i * 2);
    aLand.set([(x + Math.sin(dl * fr + ph) * sway + dl * 40) / 2, land / 2], i * 2);
    aInfo.set([t0 + dl, rnd(70, 150) * (Math.max(W, H) / 1400 + 0.3) / 2], i * 2);
  });
  const quad = new THREE.PlaneGeometry(1, 1);
  const inst = (attrs, count) => {
    const g = new THREE.InstancedBufferGeometry();
    g.index = quad.index; g.attributes.position = quad.attributes.position; g.attributes.uv = quad.attributes.uv;
    Object.entries(attrs).forEach(([k, [arr, n]]) => g.setAttribute(k, new THREE.InstancedBufferAttribute(arr, n)));
    g.instanceCount = count; return g;
  };

  // reveal mask (half resolution)
  const maskScene = new THREE.Scene();
  const maskMat = new THREE.ShaderMaterial({ vertexShader: MASK_VERT, fragmentShader: MASK_FRAG, transparent: true, depthTest: false, depthWrite: false,
    blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    uniforms: { uT: { value: 0 }, uRes: { value: new THREE.Vector2(W / 2, H / 2) } } });
  const maskMesh = new THREE.Mesh(inst({ aLand: [aLand, 2], aInfo: [aInfo, 2] }, N), maskMat); maskMesh.frustumCulled = false;
  maskScene.add(maskMesh);

  // main scene
  const scene = new THREE.Scene();
  const baseMat = new THREE.ShaderMaterial({ vertexShader: FULL_VERT, fragmentShader: BASE_FRAG, depthTest: false, depthWrite: false,
    uniforms: { uA: { value: fromTex }, uB: { value: toTex }, uMask: { value: maskRT.texture }, uBranch: { value: branchTex }, uTimeMap: { value: timeTex },
      uT: { value: 0 }, uDim: { value: 0 }, uFill: { value: 0 }, uBranchA: { value: 1 } } });
  const base = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), baseMat); base.renderOrder = 0; base.frustumCulled = false; scene.add(base);

  const fl = flowers.length;
  const fPos = new Float32Array(fl * 2), fSize = new Float32Array(fl), fRot = new Float32Array(fl), fT0 = new Float32Array(fl), fKind = new Float32Array(fl);
  flowers.forEach((f, i) => { fPos.set([f.x, f.y], i * 2); fSize[i] = f.size * 2; fRot[i] = f.rot; fT0[i] = f.t0; fKind[i] = f.kind; });
  const flowerMat = new THREE.ShaderMaterial({ vertexShader: SPRITE_VERT, fragmentShader: FLOWER_FRAG, transparent: true, side: THREE.DoubleSide, depthTest: false, depthWrite: false,
    uniforms: { uT: { value: 0 }, uRes: { value: res }, uAtlas: { value: atlasTex }, uA: { value: 1 } } });
  const flowerMesh = new THREE.Mesh(inst({ aPos: [fPos, 2], aSize: [fSize, 1], aRot: [fRot, 1], aT0: [fT0, 1], aKind: [fKind, 1] }, fl), flowerMat);
  flowerMesh.frustumCulled = false; flowerMesh.renderOrder = 1; scene.add(flowerMesh);

  const petalMat = new THREE.ShaderMaterial({ vertexShader: PETAL_VERT, fragmentShader: PETAL_FRAG, transparent: true, side: THREE.DoubleSide, depthTest: false, depthWrite: false,
    uniforms: { uT: { value: 0 }, uRes: { value: res }, uPetal: { value: petalTex }, uA: { value: 1 },
      uPink: { value: new THREE.Color(C.pink) }, uPinkMid: { value: new THREE.Color(C.pinkMid) }, uPinkDeep: { value: new THREE.Color(C.pinkDeep) } } });
  const petalMesh = new THREE.Mesh(inst({ aStart: [aStart, 2], aMove: [aMove, 4], aSpin: [aSpin, 4], aTimes: [aTimes, 2] }, N), petalMat);
  petalMesh.frustumCulled = false; petalMesh.renderOrder = 2; scene.add(petalMesh);

  // timeline
  const st = { t: 0 };
  const tl = gsap.timeline({ paused: true });
  tl.to(st, { t: T, duration: T, ease: "none" }, 0);
  tl.to(baseMat.uniforms.uDim, { value: 0.4, duration: 0.8, ease: "power2.out" }, 0);
  tl.to(baseMat.uniforms.uFill, { value: 1, duration: 0.5, ease: "power2.inOut" }, T - 0.7);
  tl.to([baseMat.uniforms.uBranchA, flowerMat.uniforms.uA, petalMat.uniforms.uA], { value: 0, duration: 0.5, ease: "power2.in" }, T - 0.55);
  tl.add(() => sound.whoosh(0, 1.4), 0.5);
  tl.add(() => sound.shimmer(0), 0.3);

  const render = () => {
    maskMat.uniforms.uT.value = baseMat.uniforms.uT.value = flowerMat.uniforms.uT.value = petalMat.uniforms.uT.value = st.t;
    renderer.setRenderTarget(maskRT); renderer.setClearColor(0x000000, 1); renderer.clear(); renderer.render(maskScene, camera);
    renderer.setRenderTarget(null); renderer.render(scene, camera);
  };
  render();
  opts.onCovered && opts.onCovered();
  await animate(tl, render);

  disposeScene(scene, [fromTex, toTex, maskRT.texture]);
  disposeScene(maskScene);
  quad.dispose(); maskRT.dispose();
}
