// TRANSITION D — BLACK HOLE
// A black hole opens at the click point with a glowing pink accretion disk.
// Gravity lenses the page around it (with a mirrored Einstein-ring image),
// swirls it and pulls it in like spaghetti until nothing is left. The hole
// collapses to a point, flashes, and a white hole erupts the incoming page
// back out with a shockwave, settling exactly into place.
import { TOKENS } from "../tokens.js?v=3";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { animate, disposeScene } from "./util.js?v=3";

const C = TOKENS.color;

const VERT = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const FRAG = /* glsl */`
uniform sampler2D uA; uniform sampler2D uB;
uniform float uAspect; uniform vec2 uCenter; uniform float uTime;
uniform float uPhase;          // 0 = black hole eating page A, 1 = white hole giving page B
uniform float uRh;             // event horizon radius
uniform float uPull;           // how far the page has been dragged in
uniform float uSwirl;          // frame dragging
uniform float uDisk;           // accretion disk intensity
uniform float uCore;           // white-hole core brightness
uniform float uShock;          // white-hole shockwave radius
uniform float uFlash;          // full-screen flash
uniform vec3 uPink; uniform vec3 uPinkMid; uniform vec3 uPinkDeep; uniform vec3 uCrimson; uniform vec3 uWhite;
varying vec2 vUv;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }
float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { s += a * noise(p); p *= 2.03; a *= 0.5; } return s; }

vec3 stars(vec2 uv) {
  vec2 g = floor(uv * vec2(uAspect, 1.0) * 220.0);
  float h = hash(g);
  float tw = 0.6 + 0.4 * sin(uTime * 3.0 + h * 40.0);
  return (h > 0.9965 ? 1.0 : 0.0) * tw * mix(uPink, uWhite, h) * 0.8;
}

vec3 sampleTex(vec2 uv) {
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return stars(uv);
  return uPhase < 0.5 ? texture2D(uA, uv).rgb : texture2D(uB, uv).rgb;
}

void main() {
  vec2 asp = vec2(uAspect, 1.0);
  vec2 c = uCenter * asp;
  vec2 d = vUv * asp - c;
  float r = length(d) + 1e-5;
  float th = atan(d.y, d.x);

  // gravitational lensing (thin point lens): beta = theta - thetaE^2 / theta
  float rE = uRh * 1.9;
  float rs = r - rE * rE / r;
  // dragged in: content from further out appears closer to the hole
  rs = rs * (1.0 + uPull) + sign(rs) * uPull * 0.06;
  float ths = th + uSwirl / (r * 6.0 + 0.35);
  vec2 src = c + vec2(cos(ths), sin(ths)) * rs;
  vec3 col = sampleTex(src / asp);

  // spaghettification streaks + redshift near the hole
  float near = (uRh > 0.0) ? smoothstep(uRh * 5.0, uRh * 1.1, r) : 0.0;
  float streak = fbm(vec2(ths * 3.0, r * 18.0 - uTime * 4.0));
  col = mix(col, col * vec3(1.0, 0.55, 0.7) * (0.6 + streak), near * 0.7);
  col *= 1.0 - near * 0.35;

  // accretion disk (tilted ellipse), front half drawn over the hole
  if (uDisk > 0.0) {
    float tilt = 0.32;
    vec2 q = mat2(cos(tilt), -sin(tilt), sin(tilt), cos(tilt)) * d;
    float e = length(vec2(q.x, q.y / 0.24));
    float rd = uRh * 3.4;
    float band = smoothstep(uRh * 1.25, uRh * 1.7, e) * (1.0 - smoothstep(rd * 0.7, rd, e));
    float phi = atan(q.y / 0.24, q.x);
    float flow = fbm(vec2(phi * 5.0 - uTime * 6.0, e * 28.0));
    float dopp = 1.0 + 0.75 * cos(phi + 0.4);
    float hot = smoothstep(rd, uRh * 1.3, e);
    vec3 dc = mix(uCrimson, uPinkDeep, flow);
    dc = mix(dc, uPink, hot); dc = mix(dc, uWhite, hot * hot * 0.6);
    float behind = step(0.0, q.y) * (1.0 - smoothstep(uRh * 0.95, uRh * 1.05, r));   // back half hidden by the hole
    float disk = band * (0.55 + flow) * dopp * uDisk * (1.0 - behind);
    // lensed image of the far side of the disk, arcing over the hole
    float arc = exp(-pow((r - uRh * 1.45) / (uRh * 0.18), 2.0)) * smoothstep(-0.2, 0.6, d.y / r) * uDisk;
    col += dc * disk * 1.3 + mix(uPinkDeep, uPink, 0.5) * arc * (0.45 + 0.5 * flow);
  }
  // photon ring + event horizon
  if (uRh > 0.0) {
    float ring = exp(-pow((r - uRh * 1.04) / (uRh * 0.05), 2.0));
    col += mix(uPink, uWhite, 0.5) * ring * 1.6 * uDisk;
    col *= smoothstep(uRh * 0.98, uRh * 1.02, r);
  }
  // white hole: blazing core + shockwave
  if (uCore > 0.0) {
    col += mix(uPink, uWhite, 0.7) * uCore * exp(-r * 14.0) * 1.2 + uPinkDeep * uCore * exp(-r * 5.0) * 0.12;
  }
  if (uShock > 0.0) {
    float sw = exp(-pow((r - uShock) / 0.03, 2.0)) * (1.0 - smoothstep(0.6, 1.8, uShock));
    col += uPink * sw * 1.2;
  }
  col = mix(col, uWhite, uFlash);
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

export async function play(fromTex, toTex, opts) {
  const { renderer, THREE, width: W, height: H, origin, sound } = opts;
  const aspect = W / H;
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const composer = new EffectComposer(renderer);
  composer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5)); composer.setSize(W, H);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(W, H), 0, 0.55, 0.78);
  composer.addPass(bloom); composer.addPass(new OutputPass());

  const white = new THREE.Color(C.text).lerp(new THREE.Color(C.pink), 0.25);
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT, fragmentShader: FRAG, depthTest: false, depthWrite: false,
    uniforms: {
      uA: { value: fromTex }, uB: { value: toTex }, uAspect: { value: aspect },
      uCenter: { value: new THREE.Vector2(0.5 + (origin.x / W - 0.5) * 0.4, 0.5 + (0.5 - origin.y / H) * 0.4) }, uTime: { value: 0 },
      uPhase: { value: 0 }, uRh: { value: 0 }, uPull: { value: 0 }, uSwirl: { value: 0 }, uDisk: { value: 0 },
      uCore: { value: 0 }, uShock: { value: 0 }, uFlash: { value: 0 },
      uPink: { value: new THREE.Color(C.pink) }, uPinkMid: { value: new THREE.Color(C.pinkMid) }, uPinkDeep: { value: new THREE.Color(C.pinkDeep) },
      uCrimson: { value: new THREE.Color(C.crimson) }, uWhite: { value: white },
    },
  });
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat));

  const U = mat.uniforms;
  const tl = gsap.timeline({ paused: true });
  // 1) the hole opens and starts to feed
  tl.to(U.uRh, { value: 0.12, duration: 1.0, ease: "power2.inOut" }, 0);
  tl.to(U.uDisk, { value: 1, duration: 0.8, ease: "power2.out" }, 0.15);
  tl.to(U.uSwirl, { value: 1.6, duration: 1.0, ease: "power2.in" }, 0);
  tl.to(U.uPull, { value: 0.25, duration: 0.95, ease: "power2.in" }, 0.1);
  tl.to(bloom, { strength: 0.7, duration: 0.8, ease: "power2.out" }, 0.2);
  // 2) everything is swallowed
  tl.to(U.uPull, { value: 6, duration: 0.6, ease: "expo.in" }, 1.0);
  tl.to(U.uSwirl, { value: 7, duration: 0.6, ease: "power3.in" }, 1.0);
  // 3) collapse -> flash
  tl.to(U.uRh, { value: 0, duration: 0.2, ease: "power3.in" }, 1.48);
  tl.to(U.uDisk, { value: 0, duration: 0.2, ease: "power2.in" }, 1.48);
  tl.to(U.uFlash, { value: 0.55, duration: 0.1, ease: "power2.in" }, 1.6);
  tl.set(U.uPhase, { value: 1 }, 1.7);
  tl.set(U.uPull, { value: 6 }, 1.7);
  tl.set(U.uSwirl, { value: -6 }, 1.7);
  tl.set(U.uCore, { value: 1.4 }, 1.7);
  // 4) white hole erupts the next page
  tl.to(U.uFlash, { value: 0, duration: 0.25, ease: "power2.out" }, 1.7);
  tl.to(U.uPull, { value: 0, duration: 0.95, ease: "expo.out" }, 1.7);
  tl.to(U.uSwirl, { value: 0, duration: 0.95, ease: "power3.out" }, 1.7);
  tl.to(U.uCore, { value: 0, duration: 0.8, ease: "power2.out" }, 1.7);
  tl.to(U.uShock, { value: 2, duration: 0.85, ease: "power2.out" }, 1.7);
  tl.to(bloom, { strength: 0, duration: 0.7, ease: "power2.inOut" }, 1.9);
  tl.set(U.uShock, { value: 0 }, 2.65);
  tl.add(() => sound.rumble(0, 1.5), 0);
  tl.add(() => sound.boom(0), 1.62);

  const t0 = performance.now();
  const render = () => { U.uTime.value = (performance.now() - t0) / 1000; composer.render(); };
  render();
  opts.onCovered && opts.onCovered();
  await animate(tl, render);

  disposeScene(scene, [fromTex, toTex]);
  bloom.dispose(); composer.dispose();
}
