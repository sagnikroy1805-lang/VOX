// TransitionManager: intercepts page changes and plays a full-screen WebGL
// transition (Waveform Portal, Black Hole, Cherry Branch or Giant Bloom) between snapshots of the two pages.
//
// Every transition module exports the same interface:
//     play(fromTexture, toTexture, options) -> Promise
// options = { renderer, THREE, width, height, origin:{x,y}, sound, onCovered }
//
// Dev toggle: ?transition=portal | blackhole | branch | bloom | fade   (forces one, for demos/tests)
import * as THREE from "three";
import { TOKENS, prefersReducedMotion } from "../tokens.js?v=3";
import { snapshotContent, composite } from "./snapshot.js?v=3";
import * as sound from "./sound.js?v=3";
import { play as playPortal } from "./portal.js?v=3";
import { play as playBlackhole } from "./blackhole.js?v=3";
import { play as playBranch } from "./branch.js?v=3";
import { play as playBloom } from "./bloom.js?v=3";

const MODULES = { portal: playPortal, blackhole: playBlackhole, branch: playBranch, bloom: playBloom };
// transitions picked at random (the others can be forced with ?transition=name)
const ROTATION = ["portal", "blackhole", "branch", "bloom"];

export class TransitionManager {
  constructor({ fx, blockerParent = document.body }) {
    this.fx = fx;
    this.blockerParent = blockerParent;
    this.history = [];
    this.busy = false;
    this.forced = new URLSearchParams(location.search).get("transition");
    this.webgl = TransitionManager.detectWebGL();
    this.lowEnd = (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 2) ||
      (navigator.deviceMemory && navigator.deviceMemory <= 2);
    this.last = null;            // name of the last transition played (for tests/debug)
    // Snapshot cache: page content layers are captured ahead of time (on tab hover)
    // and reused until that page changes, so a click starts the transition at once.
    this.cache = new Map();      // key "route@scrollY" -> { ver, promise }
    this.ver = {};               // per-page version, bumped whenever its DOM or inputs change
    this.queue = Promise.resolve();
    const pages = document.getElementById("pages");
    if (pages) {
      const bump = (node) => { const pg = node && (node.nodeType === 1 ? node : node.parentElement)?.closest?.(".page"); const k = pg ? pg.dataset.page : "*"; this.ver[k] = (this.ver[k] || 0) + 1; };
      new MutationObserver((ms) => ms.forEach((m) => bump(m.target))).observe(pages, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["class", "hidden", "style", "disabled", "value"] });
      ["input", "change"].forEach((ev) => pages.addEventListener(ev, (e) => bump(e.target), true));
    }
    addEventListener("resize", () => this.cache.clear());
  }

  version(route) { return `${this.ver[route] || 0}.${this.ver["*"] || 0}`; }

  // Capture a page's content layer (serialised: html2canvas runs one at a time).
  capture(route, atTop) {
    const y = atTop ? 0 : Math.round(window.scrollY);
    const key = `${route}@${y}`, ver = this.version(route);
    const hit = this.cache.get(key);
    if (hit && hit.ver === ver) return hit.promise;
    const promise = (this.queue = this.queue.catch(() => {}).then(() => snapshotContent(route, { atTop })));
    this.cache.set(key, { ver, promise });
    promise.catch(() => this.cache.delete(key));
    return promise;
  }

  // Warm the cache for a likely transition (called on tab hover / focus).
  prefetch(from, to) {
    if (this.busy || !window.html2canvas || !this.webgl || prefersReducedMotion() || (this.lowEnd && !this.forced) || this.forced === "fade") return;
    if (!from || !to || from === to) return;
    this.capture(from, false);
    this.capture(to, true);
  }

  static detectWebGL() {
    try {
      const c = document.createElement("canvas");
      const gl = c.getContext("webgl2") || c.getContext("webgl");
      const ok = !!gl;
      gl && gl.getExtension("WEBGL_lose_context")?.loseContext();
      return ok;
    } catch (_) { return false; }
  }

  // Random pick, never the same one more than maxRepeat times in a row.
  pick() {
    if (this.forced && (MODULES[this.forced] || this.forced === "fade")) return this.forced;
    const names = ROTATION;
    let name = names[Math.floor(Math.random() * names.length)];
    const n = TOKENS.transition.maxRepeat;
    const recent = this.history.slice(-n);
    if (recent.length === n && recent.every((h) => h === name)) { const others = names.filter((x) => x !== name); name = others[Math.floor(Math.random() * others.length)]; }
    this.history.push(name); this.history = this.history.slice(-6);
    return name;
  }

  block(on) {
    if (on && !this.blocker) {
      this.blocker = document.createElement("div"); this.blocker.id = "blocker";
      this.blockerParent.appendChild(this.blocker);
    } else if (!on && this.blocker) { this.blocker.remove(); this.blocker = null; }
  }

  // Simple 300 ms crossfade (reduced motion / low-end / no WebGL / errors)
  crossfade(swap) {
    const el = document.getElementById("pages"), d = TOKENS.transition.fallback / 2;
    return new Promise((res) => {
      if (!window.gsap) { swap(); return res(); }
      gsap.to(el, { opacity: 0, duration: d, ease: "power1.in", onComplete: () => {
        swap();
        gsap.to(el, { opacity: 1, duration: d, ease: "power1.out", clearProps: "opacity", onComplete: res });
      } });
    });
  }

  makeTexture(canvas) {
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true;
    return t;
  }

  async run({ from, to, origin, swap }) {
    if (this.busy) return false;
    this.busy = true;
    this.block(true);
    sound.prime();
    const name = this.pick();
    this.last = name;
    const forced = this.forced && MODULES[this.forced];   // dev toggle overrides the low-end check
    const useFallback = name === "fade" || prefersReducedMotion() || !this.webgl || (this.lowEnd && !forced) || !window.html2canvas;
    let renderer = null, canvas = null, texA = null, texB = null;
    try {
      if (useFallback) { this.last = "fade"; await this.crossfade(swap); return true; }
      const W = document.documentElement.clientWidth, H = window.innerHeight;
      const t0 = performance.now();
      const [fromLayer, toLayer] = await Promise.all([this.capture(from, false), this.capture(to, true)]);
      const fromCanvas = composite(fromLayer), toCanvas = composite(toLayer);
      this.snapshotMs = Math.round(performance.now() - t0);

      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(W, H, false);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.setClearColor(0x000000, 1);
      canvas = renderer.domElement;
      canvas.style.visibility = "hidden";          // shown once the first frame is drawn
      this.fx.appendChild(canvas);
      texA = this.makeTexture(fromCanvas);
      texB = this.makeTexture(toCanvas);
      texA.anisotropy = texB.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());

      let covered = false;
      const onCovered = () => { if (!covered) { covered = true; canvas.style.visibility = "visible"; swap(); } };
      await MODULES[name](texA, texB, {
        renderer, THREE, width: W, height: H, labels: { from, to },
        origin: origin || { x: W / 2, y: H / 2 }, sound, onCovered,
      });
      onCovered();
      // Hand back to the real DOM page with a short fade.
      await new Promise((res) => (window.gsap ? gsap.to(canvas, { opacity: 0, duration: 0.22, ease: "power1.out", onComplete: res }) : res()));
      return true;
    } catch (err) {
      console.error("[VOX] transition failed, falling back to crossfade", err);
      if (canvas) canvas.style.opacity = 0;
      if (document.querySelector(`.page.active`)?.dataset.page !== to) await this.crossfade(swap);
      return true;
    } finally {
      texA && texA.dispose(); texB && texB.dispose();
      if (renderer) {
        renderer.dispose();
        renderer.forceContextLoss();
        renderer.domElement.remove();
      }
      this.block(false);
      this.busy = false;
    }
  }
}
