// TRANSITION F — GIANT BLOOM
// A single cherry blossom opens from the click point. Its five notched petals
// unfold one after another and grow until they cover the screen; each petal is a
// window onto the incoming page, tinted like a real petal (crimson base, pale tip,
// soft veins). The glowing stamens fade, the tint melts away, and the new page remains.
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
uniform float uR[5];           // length of each petal (unfolds one after another)
uniform float uOpen;           // 0 = closed bud (narrow petals), 1 = wide open
uniform float uRot;            // flower rotation
uniform float uTint;           // petal colouring over the incoming page
uniform float uStamen;         // glowing centre
uniform float uFill;           // final: whole screen = incoming page
uniform float uDim;            // darken the outgoing page
uniform vec3 uPink; uniform vec3 uPinkMid; uniform vec3 uPinkDeep; uniform vec3 uCrimson; uniform vec3 uWhite;
varying vec2 vUv;

const float TAU = 6.2831853;
float hash(float n) { return fract(sin(n) * 43758.5453); }

void main() {
  vec2 asp = vec2(uAspect, 1.0);
  vec2 d = (vUv - uCenter) * asp;
  float r = length(d) + 1e-5;
  float th = atan(d.y, d.x) - uRot;

  // which petal are we in, and the angle inside it (-1..1 across the petal)
  float sector = TAU / 5.0;
  float idx = floor(mod(th + sector * 0.5, TAU) / sector);
  float a = mod(th + sector * 0.5, sector) - sector * 0.5;
  float hw = sector * 0.5 * mix(0.35, 1.0, uOpen);          // petal angular half-width
  float u = a / hw;
  float R = idx < 0.5 ? uR[0] : idx < 1.5 ? uR[1] : idx < 2.5 ? uR[2] : idx < 3.5 ? uR[3] : uR[4];

  // petal outline: rounded, widest past the middle, with the cherry-blossom notch at the tip
  float prof = pow(max(0.0, 1.0 - u * u), 0.5);
  float rad = R * (0.25 + 0.75 * prof);
  rad *= 1.0 - 0.13 * exp(-pow(u / 0.16, 2.0)) * smoothstep(0.0, 1.0, R);
  float inside = (1.0 - smoothstep(rad - 0.004, rad + 0.004, r)) * step(abs(u), 1.0);

  vec3 a0 = texture2D(uA, vUv).rgb * (1.0 - uDim);
  vec3 b0 = texture2D(uB, vUv).rgb;

  // petal colouring: crimson at the base, pale pink tip, veins and a soft rim
  float t = clamp(r / max(R, 1e-3), 0.0, 1.0);
  vec3 pc = mix(uCrimson, uPinkDeep, smoothstep(0.0, 0.25, t));
  pc = mix(pc, uPink, smoothstep(0.25, 0.9, t));
  float vein = pow(abs(sin(u * 9.0 + t * 2.0)), 18.0) * (1.0 - t) * 0.5;
  float rim = smoothstep(rad * 0.86, rad, r) * inside;
  float shade = 0.75 + 0.25 * (1.0 - abs(u));                  // cupped petal shading
  vec3 petal = mix(b0, pc * shade, uTint * (0.55 - 0.35 * t)) + uPink * (vein * uTint * 0.6 + rim * uTint * 0.5);

  vec3 col = mix(a0, petal, inside);
  // soft shadow of the petals on the old page
  float sh = smoothstep(rad + 0.06, rad, r) * (1.0 - inside) * 0.45 * uTint;
  col *= 1.0 - sh;

  // stamens: a ring of filaments with glowing tips + a crimson heart
  float sr = 0.09;
  float ang = atan(d.y, d.x);
  float fil = 0.0;
  if (uStamen > 0.001 && r < 0.14) for (int i = 0; i < 14; i++) {
    float fa = float(i) / 14.0 * TAU + hash(float(i)) * 0.3;
    float fl = sr * (0.75 + 0.5 * hash(float(i) + 7.0));
    vec2 tip = vec2(cos(fa), sin(fa)) * fl;
    vec2 dir = normalize(tip);
    float along = clamp(dot(d, dir), 0.0, fl);
    float line = exp(-pow(length(d - dir * along) / 0.0025, 2.0));
    float head = exp(-pow(length(d - tip) / 0.009, 2.0));
    fil += line * 0.5 + head * 1.6;
  }
  vec3 stamen = uCrimson * exp(-pow(r / 0.035, 2.0)) * 1.3 + mix(uPink, uWhite, 0.4) * fil;
  col += stamen * uStamen;

  col = mix(col, b0, uFill);
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
  const bloom = new UnrealBloomPass(new THREE.Vector2(W, H), 0, 0.5, 0.7);
  composer.addPass(bloom); composer.addPass(new OutputPass());

  const cx = 0.5 + (origin.x / W - 0.5) * 0.55, cy = 0.5 + (0.5 - origin.y / H) * 0.55;
  const mat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, depthTest: false, depthWrite: false,
    uniforms: {
      uA: { value: fromTex }, uB: { value: toTex }, uAspect: { value: aspect }, uCenter: { value: new THREE.Vector2(cx, cy) },
      uTime: { value: 0 }, uR: { value: [0, 0, 0, 0, 0] }, uOpen: { value: 0 }, uRot: { value: -0.9 },
      uTint: { value: 1 }, uStamen: { value: 0 }, uFill: { value: 0 }, uDim: { value: 0 },
      uPink: { value: new THREE.Color(C.pink) }, uPinkMid: { value: new THREE.Color(C.pinkMid) }, uPinkDeep: { value: new THREE.Color(C.pinkDeep) },
      uCrimson: { value: new THREE.Color(C.crimson) }, uWhite: { value: new THREE.Color(C.text) },
    } });
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat));

  const U = mat.uniforms;
  const maxR = Math.hypot(Math.max(cx, 1 - cx) * aspect, Math.max(cy, 1 - cy)) * 2.4;
  const petals = { p0: 0, p1: 0, p2: 0, p3: 0, p4: 0 };
  const tl = gsap.timeline({ paused: true });
  tl.to(U.uDim, { value: 0.45, duration: 0.7, ease: "power2.out" }, 0);
  // bud appears and swells
  [0, 1, 2, 3, 4].forEach((i) => tl.to(petals, { [`p${i}`]: 0.07, duration: 0.45, ease: "back.out(2)" }, 0.05 + i * 0.03));
  tl.to(U.uStamen, { value: 1, duration: 0.5, ease: "power2.out" }, 0.35);
  tl.to(bloom, { strength: 0.8, duration: 0.6 }, 0.3);
  // petals unfold one after another and grow past the screen
  tl.to(U.uOpen, { value: 1, duration: 0.9, ease: "power3.out" }, 0.45);
  [0, 1, 2, 3, 4].forEach((i) => tl.to(petals, { [`p${i}`]: maxR, duration: 1.5, ease: "expo.inOut" }, 0.55 + i * 0.07));
  tl.to(U.uRot, { value: 0.15, duration: 2.0, ease: "power2.out" }, 0.3);
  // settle into the new page
  tl.to(U.uStamen, { value: 0, duration: 0.45, ease: "power2.in" }, 1.9);
  tl.to(U.uTint, { value: 0, duration: 0.55, ease: "power2.inOut" }, 1.95);
  tl.to(bloom, { strength: 0, duration: 0.5 }, 1.95);
  tl.to(U.uFill, { value: 1, duration: 0.35, ease: "power2.inOut" }, 2.25);
  tl.add(() => sound.whoosh(0, 1.2), 0.5);
  tl.add(() => sound.shimmer(0), 0.35);

  const render = () => {
    U.uR.value[0] = petals.p0; U.uR.value[1] = petals.p1; U.uR.value[2] = petals.p2; U.uR.value[3] = petals.p3; U.uR.value[4] = petals.p4;
    composer.render();
  };
  render();
  opts.onCovered && opts.onCovered();
  await animate(tl, render);
  disposeScene(scene, [fromTex, toTex]);
  bloom.dispose(); composer.dispose();
}
