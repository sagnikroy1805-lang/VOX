// TRANSITION C — CHERRY-BLOSSOM STORM
// The outgoing page is cut into thousands of tiles. Rippling out from the click,
// each tile curls into a cherry-blossom petal (still carrying its piece of the page)
// and is swept into a glowing pink 3D whirlwind. The petals then fly back, flatten
// into tiles of the incoming page and lock into place.
import { TOKENS } from "../tokens.js?v=3";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { animate, disposeScene, fitCamera } from "./util.js?v=3";
import { paintBackground } from "./snapshot.js?v=3";

const C = TOKENS.color;

const VERT = /* glsl */`
attribute vec2 aUv;      // tile centre in page uv
attribute vec4 aRand;
uniform float uT; uniform float uSpin; uniform float uAspect; uniform vec2 uCell; uniform vec2 uOrigin;
varying vec2 vTexUv; varying vec2 vLocal; varying float vW; varying float vB; varying vec4 vRand;

mat3 rx(float a) { float c = cos(a), s = sin(a); return mat3(1.,0.,0., 0.,c,s, 0.,-s,c); }
mat3 ry(float a) { float c = cos(a), s = sin(a); return mat3(c,0.,-s, 0.,1.,0., s,0.,c); }
mat3 rz(float a) { float c = cos(a), s = sin(a); return mat3(c,s,0., -s,c,0., 0.,0.,1.); }

void main() {
  vec2 world = vec2(2.0 * uAspect, 2.0);
  vec3 P0 = vec3((aUv - 0.5) * world, 0.0);
  float dist = length((aUv - uOrigin) * vec2(uAspect, 1.0)) / length(vec2(uAspect, 1.0));
  float outS = dist * 0.22 + aRand.x * 0.04;
  float pOut = smoothstep(outS, outS + 0.3, uT);
  float inS = 0.55 + aRand.y * 0.12;
  float pIn = smoothstep(inS, inS + 0.33, uT);
  float w = pOut * (1.0 - pIn);

  // the whirlwind: a leaning funnel that widens towards the top
  float h = aRand.w * 2.0 - 1.0;
  float R = 0.15 + aRand.z * 1.25 * (0.45 + 0.55 * (h * 0.5 + 0.5));
  float ang = aRand.x * 6.2832 + uSpin * (1.0 + 2.2 * (1.0 - aRand.z));
  vec3 S = vec3(cos(ang) * R + h * 0.22, h * 1.2 + sin(uSpin * 0.8 + aRand.y * 6.0) * 0.07, sin(ang) * R * 0.85 - 0.15);
  vec3 pos = mix(P0, S, w);
  pos.z += sin(w * 3.1416) * 0.5 * (aRand.y - 0.25);

  vec2 lp = position.xy;                                   // -0.5..0.5
  float petalSize = 0.038 * (0.7 + aRand.z * 0.7);
  vec2 size = mix(uCell * world * 1.004, vec2(petalSize * 0.8, petalSize), smoothstep(0.0, 0.35, w));
  vec3 v = vec3(lp * size, 0.0);
  v.z += lp.x * lp.x * size.x * 1.6 * w;                  // petals curl
  vec3 a = (aRand.xyz * 10.0 + vec3(uSpin * (0.6 + aRand.y), uSpin * (0.4 + aRand.z), uSpin * 0.3)) * w;
  v = rz(a.z) * ry(a.y) * rx(a.x) * v;

  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos + v, 1.0);
  vTexUv = aUv + lp * uCell;
  vLocal = lp * 2.0; vW = w; vB = step(inS, uT); vRand = aRand;
}`;

const FRAG = /* glsl */`
uniform sampler2D uA; uniform sampler2D uB; uniform vec3 uPink; uniform vec3 uPinkDeep; uniform vec3 uCrimson;
varying vec2 vTexUv; varying vec2 vLocal; varying float vW; varying float vB; varying vec4 vRand;
void main() {
  vec3 page = vB > 0.5 ? texture2D(uB, vTexUv).rgb : texture2D(uA, vTexUv).rgb;
  float m = smoothstep(0.0, 0.4, vW);
  vec2 q = vLocal;
  float body = length(vec2(q.x * 1.18, (q.y + 0.12) * 0.98));
  float petal = 1.0 - smoothstep(0.9, 1.0, body);
  float notch = 1.0 - smoothstep(0.16, 0.22, length(vec2(q.x * 1.5, q.y - 0.95)));
  petal *= 1.0 - notch;
  float mask = mix(1.0, petal, m);
  if (mask < 0.5) discard;
  vec3 pc = mix(uPink, uPinkDeep, smoothstep(-0.6, 0.6, -q.y));
  pc = mix(pc, uCrimson, smoothstep(0.3, 1.0, -q.y) * 0.8);
  pc *= 0.45 + 0.4 * vRand.w;                                  // varied, mostly mid-tone petals
  vec3 col = mix(page, pc, m * 0.8);
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

const BG_VERT = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const BG_FRAG = `uniform sampler2D uBg; uniform float uDim; varying vec2 vUv;
void main(){ vec3 c = texture2D(uBg, vUv).rgb; float vig = smoothstep(1.2, 0.2, length(vUv - 0.5) * 1.5);
  gl_FragColor = vec4(c * mix(1.0, 0.5 * vig + 0.15, uDim), 1.0);
  #include <colorspace_fragment>
}`;

export async function play(fromTex, toTex, opts) {
  const { renderer, THREE, width: W, height: H, origin, sound } = opts;
  const aspect = W / H;
  const scene = new THREE.Scene();
  const camera = fitCamera(THREE, W, H, 40);
  const d = camera.userData.d;

  const composer = new EffectComposer(renderer);
  composer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5)); composer.setSize(W, H);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(W, H), 0, 0.5, 0.62);
  composer.addPass(bloom); composer.addPass(new OutputPass());

  // background stage (the app's pink glow), revealed as the tiles leave
  const bgTex = new THREE.CanvasTexture(paintBackground(W, H, 0.5)); bgTex.colorSpace = THREE.SRGBColorSpace;
  const bgMat = new THREE.ShaderMaterial({ vertexShader: BG_VERT, fragmentShader: BG_FRAG, uniforms: { uBg: { value: bgTex }, uDim: { value: 0 } }, depthWrite: false });
  const bg = new THREE.Mesh(new THREE.PlaneGeometry(2 * aspect, 2), bgMat);
  const bgZ = -3, s = ((d - bgZ) / d) * 1.25; bg.position.z = bgZ; bg.scale.set(s, s, 1); scene.add(bg);

  // tiles -> petals
  const cols = W > 1100 ? 84 : W > 700 ? 64 : 40;
  const rows = Math.max(8, Math.round(cols / aspect));
  const N = cols * rows;
  const base = new THREE.PlaneGeometry(1, 1);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = base.index; geo.attributes.position = base.attributes.position; geo.attributes.uv = base.attributes.uv;
  const aUv = new Float32Array(N * 2), aRand = new Float32Array(N * 4);
  for (let j = 0, k = 0; j < rows; j++) for (let i = 0; i < cols; i++, k++) {
    aUv[k * 2] = (i + 0.5) / cols; aUv[k * 2 + 1] = (j + 0.5) / rows;
    for (let r = 0; r < 4; r++) aRand[k * 4 + r] = Math.random();
  }
  geo.setAttribute("aUv", new THREE.InstancedBufferAttribute(aUv, 2));
  geo.setAttribute("aRand", new THREE.InstancedBufferAttribute(aRand, 4));
  geo.instanceCount = N;
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT, fragmentShader: FRAG, side: THREE.DoubleSide,
    uniforms: {
      uA: { value: fromTex }, uB: { value: toTex }, uT: { value: 0 }, uSpin: { value: 0 }, uAspect: { value: aspect },
      uCell: { value: new THREE.Vector2(1 / cols, 1 / rows) }, uOrigin: { value: new THREE.Vector2(origin.x / W, 1 - origin.y / H) },
      uPink: { value: new THREE.Color(C.pink) }, uPinkDeep: { value: new THREE.Color(C.pinkDeep) }, uCrimson: { value: new THREE.Color(C.crimson) },
    },
  });
  const petals = new THREE.Mesh(geo, mat); petals.frustumCulled = false; scene.add(petals);

  const U = mat.uniforms, st = { dolly: 0, sway: 0 };
  const T = 2.75;
  const tl = gsap.timeline({ paused: true });
  tl.to(U.uT, { value: 1, duration: T, ease: "none" }, 0);
  tl.to(U.uSpin, { value: 8.5, duration: T, ease: "power1.inOut" }, 0);
  tl.to(bgMat.uniforms.uDim, { value: 1, duration: 0.8, ease: "power2.out" }, 0.1);
  tl.to(bgMat.uniforms.uDim, { value: 0, duration: 0.7, ease: "power2.inOut" }, T - 0.8);
  tl.to(st, { dolly: 1, duration: T / 2, ease: "sine.inOut", yoyo: true, repeat: 1 }, 0);
  tl.to(st, { sway: 1, duration: T / 2, ease: "sine.inOut", yoyo: true, repeat: 1 }, 0);
  tl.to(bloom, { strength: 0.45, duration: 0.7, ease: "power2.out" }, 0.35);
  tl.to(bloom, { strength: 0, duration: 0.5, ease: "power2.in" }, T - 0.75);
  tl.add(() => sound.whoosh(0, 1.3), 0.1);
  tl.add(() => sound.whoosh(0, 1.0), 1.45);

  const render = () => {
    camera.position.z = d - st.dolly * 0.3;
    camera.position.x = Math.sin(st.sway * Math.PI) * 0.12;
    camera.rotation.z = st.sway * 0.08;
    camera.lookAt(0, 0, 0); camera.rotation.z += st.sway * 0.08;
    composer.render();
  };
  render();
  opts.onCovered && opts.onCovered();
  await animate(tl, render);

  disposeScene(scene, [fromTex, toTex]);
  base.dispose();
  bloom.dispose(); composer.dispose();
}
