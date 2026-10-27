// TRANSITION B — WAVEFORM PORTAL
// 1. A shockwave ripple spreads from the exact click point across the outgoing page.
// 2. The page is swirled and sucked into the centre of a 3D tunnel of circular audio waveforms.
// 3. The camera flies down the tunnel (expo.inOut) while the rings pulse like a live
//    spectrogram — additive blending + UnrealBloom glow, closer rings brighter.
// 4. A bright pink-white portal at the end grows until it fills the view (it already
//    shows the incoming page), a soft flash fades, and the page settles from 1.05 to 1.0.
import { TOKENS } from "../tokens.js?v=3";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { animate, disposeScene, glowTexture, fitCamera } from "./util.js?v=3";

const C = TOKENS.color;
const RING_COLORS = [C.pink, C.pinkMid, C.pinkDeep, C.crimson];
const RINGS = 46, SPACING = 0.95, SEG = 168, FOV = 50;

const VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

const PAGE_FRAG = /* glsl */`
uniform sampler2D uTex; uniform vec2 uOrigin; uniform float uAspect; uniform float uRadius;
uniform float uGlow; uniform float uSuck; uniform float uAlpha; uniform vec3 uPink;
varying vec2 vUv;
vec2 rot(vec2 p, float a) { float c = cos(a), s = sin(a); return vec2(c * p.x - s * p.y, s * p.x + c * p.y); }
void main() {
  vec2 asp = vec2(uAspect, 1.0);
  vec2 d = (vUv - uOrigin) * asp;
  float dist = length(d);
  vec2 dir = dist > 1e-4 ? d / dist : vec2(0.0);
  float x = dist - uRadius;
  float band = exp(-(x * x) / 0.0022) * smoothstep(0.0, 0.06, uRadius);
  float wake = smoothstep(0.0, -0.5, x) * exp(x * 3.0) * smoothstep(0.0, 0.06, uRadius);   // fading ripples behind the front
  float disp = (sin(x * 70.0) * band * 0.022) + sin(x * 34.0) * wake * 0.006;
  vec2 uv = vUv - dir / asp * disp;
  // swirl + pull toward the centre (into the tunnel)
  vec2 c = (uv - 0.5) * asp;
  c = rot(c, uSuck * 2.6 * (1.2 - min(length(c), 1.2)));
  uv = c / asp + 0.5;
  float ca = band * 0.008 + uSuck * 0.01;
  vec3 col;
  col.r = texture2D(uTex, uv + dir / asp * ca).r;
  col.g = texture2D(uTex, uv).g;
  col.b = texture2D(uTex, uv - dir / asp * ca).b;
  col += uPink * band * 1.1 * uGlow;
  col *= 1.0 - 0.18 * wake * uGlow;
  float edge = smoothstep(0.0, 0.02, min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y)));
  gl_FragColor = vec4(col, uAlpha * mix(1.0, edge, step(0.001, uSuck)));
  #include <colorspace_fragment>
}`;

const PORTAL_VERT = /* glsl */`
varying vec2 vUv; varying vec2 vScreen;
void main() {
  vUv = uv;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  vScreen = p.xy / p.w * 0.5 + 0.5;
  gl_Position = p;
}`;
const PORTAL_FRAG = /* glsl */`
uniform sampler2D uTex; uniform float uFlare; uniform float uShow; uniform vec3 uPink; uniform vec3 uWhite;
varying vec2 vUv; varying vec2 vScreen;
void main() {
  float r = length(vUv - 0.5) * 2.0;
  vec3 page = texture2D(uTex, vScreen).rgb;
  float rim = smoothstep(0.62, 0.97, r);
  vec3 col = mix(uWhite, page, uShow * (1.0 - rim));
  col += uPink * rim * 2.2 + uWhite * (1.0 - r) * uFlare * 0.9;
  float a = 1.0 - smoothstep(0.97, 1.0, r);
  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
}`;
const QUAD_FRAG = /* glsl */`
uniform sampler2D uTex; uniform float uAlpha; varying vec2 vUv;
void main() { gl_FragColor = vec4(texture2D(uTex, vUv).rgb, uAlpha);
  #include <colorspace_fragment>
}`;

function ringWave(i, th, t) {
  const ph = i * 0.73;
  const f = 0.55 * Math.sin(3 * th + t * 2.1 + ph) + 0.3 * Math.sin(7 * th - t * 3.3 + ph * 1.7) + 0.18 * Math.sin(13 * th + t * 5 + ph * 0.5);
  const spikes = Math.pow(Math.abs(Math.sin(8 * th + ph + t * 1.5)), 12) * 0.9;
  const beat = 0.5 + 0.5 * Math.sin(t * 9 - i * 0.55);
  return (f * 0.5 + spikes) * (0.05 + 0.15 * beat * beat);
}

function ribbonGeometry(THREE) {
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array((SEG + 1) * 2 * 3);
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  const idx = [];
  for (let k = 0; k < SEG; k++) { const a = 2 * k, b = a + 1, c = a + 2, d = a + 3; idx.push(a, b, c, b, d, c); }
  g.setIndex(idx);
  return g;
}

export async function play(fromTex, toTex, opts) {
  const { renderer, THREE, width: W, height: H, origin, sound } = opts;
  const aspect = W / H;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(C.black);
  const camera = fitCamera(THREE, W, H, FOV);
  const d = camera.userData.d;
  scene.add(camera);

  const pr = Math.min(window.devicePixelRatio || 1, 1.5);
  const composer = new EffectComposer(renderer);
  composer.setPixelRatio(pr); composer.setSize(W, H);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(W, H), 0, 0.6, 0.3);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  // 1) outgoing page with the ripple shader
  const maxR = Math.max(...[[0, 0], [1, 0], [0, 1], [1, 1]].map(([u, v]) => Math.hypot((u - origin.x / W) * aspect, v - (1 - origin.y / H)))) + 0.15;
  const pageMat = new THREE.ShaderMaterial({
    vertexShader: VERT, fragmentShader: PAGE_FRAG, transparent: true, depthWrite: false,
    uniforms: { uTex: { value: fromTex }, uOrigin: { value: new THREE.Vector2(origin.x / W, 1 - origin.y / H) }, uAspect: { value: aspect },
      uRadius: { value: 0 }, uGlow: { value: 0 }, uSuck: { value: 0 }, uAlpha: { value: 1 }, uPink: { value: new THREE.Color(C.pink) } },
  });
  const page = new THREE.Mesh(new THREE.PlaneGeometry(2 * aspect, 2), pageMat);
  page.renderOrder = 10; scene.add(page);

  // 2) tunnel of circular waveforms
  const rings = [];
  for (let i = 0; i < RINGS; i++) {
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(RING_COLORS[i % 4]), transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const m = new THREE.Mesh(ribbonGeometry(THREE), mat);
    m.position.z = -0.8 - i * SPACING; m.frustumCulled = false;
    m.userData.base = 1.22 + 0.05 * Math.sin(i * 1.7);
    scene.add(m); rings.push(m);
  }
  const endZ = rings[RINGS - 1].position.z - 1.4;

  // sparkles along the tunnel walls (speed sensation)
  const N = 1400, pp = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const a = Math.random() * Math.PI * 2, r = 1.15 + Math.random() * 1.6;
    pp[i * 3] = Math.cos(a) * r; pp[i * 3 + 1] = Math.sin(a) * r; pp[i * 3 + 2] = 1 - Math.random() * (1 - endZ);
  }
  const pg = new THREE.BufferGeometry(); pg.setAttribute("position", new THREE.BufferAttribute(pp, 3));
  const sparkMat = new THREE.PointsMaterial({ size: 0.05, map: glowTexture(THREE, C.pinkMid, 64), color: new THREE.Color(C.pinkMid),
    transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true });
  const sparks = new THREE.Points(pg, sparkMat); sparks.frustumCulled = false; scene.add(sparks);

  // 3) the portal at the end of the tunnel (a window onto the incoming page)
  const white = new THREE.Color(C.text).lerp(new THREE.Color(C.pink), 0.35);
  const portalMat = new THREE.ShaderMaterial({ vertexShader: PORTAL_VERT, fragmentShader: PORTAL_FRAG, transparent: true, depthWrite: false,
    uniforms: { uTex: { value: toTex }, uFlare: { value: 0 }, uShow: { value: 1 }, uPink: { value: new THREE.Color(C.pink) }, uWhite: { value: white } } });
  const portal = new THREE.Mesh(new THREE.CircleGeometry(1.15, 128), portalMat);
  portal.position.z = endZ; scene.add(portal);
  const halo = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: glowTexture(THREE, C.pink), transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false }));
  halo.scale.set(6, 6, 1); halo.position.z = endZ - 0.05; scene.add(halo);

  // 4) camera-attached final page quad + flash
  const fh = 2 * Math.tan(THREE.MathUtils.degToRad(FOV / 2)) * 1.0;
  const finalMat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: QUAD_FRAG, transparent: true, depthTest: false, depthWrite: false,
    uniforms: { uTex: { value: toTex }, uAlpha: { value: 0 } } });
  const finalQuad = new THREE.Mesh(new THREE.PlaneGeometry(fh * aspect, fh), finalMat);
  finalQuad.position.z = -1; finalQuad.renderOrder = 50; finalQuad.visible = false; camera.add(finalQuad);
  const flashMat = new THREE.MeshBasicMaterial({ color: white, transparent: true, opacity: 0, depthTest: false, depthWrite: false });
  const flash = new THREE.Mesh(new THREE.PlaneGeometry(fh * aspect * 1.6, fh * 1.6), flashMat);
  flash.position.z = -0.9; flash.renderOrder = 60; camera.add(flash);

  // ---------------------------------------------------------- timeline
  const st = { scale: 1, rings: 0, s: 1.05, roll: 0 };
  const startZ = d, stopZ = endZ + 0.55;
  const U = pageMat.uniforms;
  const tl = gsap.timeline({ paused: true });
  tl.to(U.uRadius, { value: maxR, duration: 0.85, ease: "power2.out" }, 0);
  tl.to(U.uGlow, { value: 1, duration: 0.12, ease: "power1.out" }, 0);
  tl.to(U.uGlow, { value: 0.4, duration: 0.5 }, 0.6);
  tl.to(U.uSuck, { value: 1, duration: 0.66, ease: "expo.in" }, 0.42);
  tl.to(st, { scale: 0.001, duration: 0.66, ease: "expo.in" }, 0.42);
  tl.to(U.uAlpha, { value: 0, duration: 0.18 }, 0.92);
  tl.to(st, { rings: 1, duration: 0.6, ease: "power2.out" }, 0.35);
  tl.to(sparkMat, { opacity: 0.9, duration: 0.5 }, 0.5);
  tl.to(bloom, { strength: 1.35, duration: 0.5, ease: "power2.out" }, 0.7);
  tl.to(bloom, { strength: 0.55, duration: 0.45, ease: "power2.inOut" }, 1.4);
  tl.to(camera.position, { z: stopZ, duration: 1.62, ease: TOKENS.motion.big }, 0.52);
  tl.to(st, { roll: 0.85, duration: 1.62, ease: TOKENS.motion.big }, 0.52);
  tl.to(halo.material, { opacity: 0.4, duration: 0.6 }, 1.45);
  tl.to(portalMat.uniforms.uFlare, { value: 0.7, duration: 0.3, ease: "power2.in" }, 1.82);
  tl.to(bloom, { strength: 0, duration: 0.25, ease: "power2.in" }, 1.9);
  tl.to(flashMat, { opacity: 0.92, duration: 0.1, ease: "power2.in" }, 2.06);
  tl.add(() => { finalQuad.visible = true; finalMat.uniforms.uAlpha.value = 1; portal.visible = halo.visible = sparks.visible = false; rings.forEach((r) => (r.visible = false)); }, 2.16);
  tl.to(flashMat, { opacity: 0, duration: 0.45, ease: "power2.out" }, 2.16);
  tl.to(st, { s: 1, duration: 0.45, ease: TOKENS.motion.enter }, 2.16);
  tl.add(() => sound.whoosh(0, 1.55), 0.45);
  tl.add(() => sound.shimmer(0), 2.1);

  const clock = { t0: performance.now() };
  const render = () => {
    const t = (performance.now() - clock.t0) / 1000;
    page.scale.set(st.scale, st.scale, 1);
    page.rotation.z = (1 - st.scale) * 0.6;
    page.visible = st.scale > 0.002 && U.uAlpha.value > 0.001;
    const p = Math.min(1, Math.max(0, (startZ - camera.position.z) / (startZ - stopZ)));
    camera.fov = FOV + 32 * Math.sin(p * Math.PI);
    camera.rotation.z = st.roll;
    camera.updateProjectionMatrix();
    const cz = camera.position.z;
    for (let i = 0; i < RINGS; i++) {
      const m = rings[i];
      const dist = cz - m.position.z;
      if (dist < 0.05) { m.visible = false; continue; }
      m.visible = finalQuad.visible ? false : true;
      const near = Math.min(1, Math.max(0, (dist - 0.15) / 0.9));
      m.material.opacity = st.rings * near * Math.min(1, 3.4 / dist);
      const pos = m.geometry.attributes.position.array, R = m.userData.base;
      const wdt = 0.012 + 0.012 * (0.5 + 0.5 * Math.sin(t * 9 - i * 0.55));
      for (let k = 0; k <= SEG; k++) {
        const th = (k / SEG) * Math.PI * 2, r = R * (1 + ringWave(i, th, t)), c = Math.cos(th), s = Math.sin(th);
        const j = k * 6;
        pos[j] = c * (r - wdt); pos[j + 1] = s * (r - wdt); pos[j + 2] = 0;
        pos[j + 3] = c * (r + wdt); pos[j + 4] = s * (r + wdt); pos[j + 5] = 0;
      }
      m.geometry.attributes.position.needsUpdate = true;
    }
    finalQuad.scale.set(st.s, st.s, 1);
    composer.render();
  };
  render();
  opts.onCovered && opts.onCovered();
  await animate(tl, render);

  scene.remove(camera);
  disposeScene(camera, [fromTex, toTex]);
  disposeScene(scene, [fromTex, toTex]);
  bloom.dispose();
  composer.dispose();
}
