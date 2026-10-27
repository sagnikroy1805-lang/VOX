// VOX app entry: tokens -> login -> app shell -> router + transitions.
import { applyTokens, TOKENS, prefersReducedMotion } from "./tokens.js?v=3";
import { $, $$ } from "./ui.js?v=3";
import { startLogin, bindLogin, handoff, logout } from "./login.js?v=3";
import { initPages, onPageShown } from "./pages.js?v=3";
import { TransitionManager } from "./transitions/TransitionManager.js?v=3";
import * as sound from "./transitions/sound.js?v=3";

applyTokens();

const ROUTES = ["dashboard", "transcribe", "batch", "benchmark", "robustness", "how"];
let current = null;
let pagesReady = false;
const tm = new TransitionManager({ fx: $("#fx") });
window.VOX = { tm, go: (r, o) => navigate(r, o) };      // handy for demos / tests

const routeFromHash = () => {
  const r = (location.hash || "").replace(/^#\/?/, "");
  return ROUTES.includes(r) ? r : "dashboard";
};

function setActive(route) {
  $$(".page").forEach((p) => p.classList.toggle("active", p.dataset.page === route));
  $$(".tab").forEach((t) => {
    const on = t.dataset.route === route;
    t.classList.toggle("active", on);
    t.setAttribute("aria-selected", on ? "true" : "false");
  });
  current = route;
  document.title = route === "dashboard" ? "VOX" : `VOX · ${$(`.tab[data-route="${route}"]`).textContent}`;
}

async function navigate(route, origin, { push = true } = {}) {
  if (!ROUTES.includes(route) || route === current || tm.busy) return;
  const from = current;
  const ok = await tm.run({
    from, to: route, origin,
    swap: () => {
      setActive(route);
      window.scrollTo(0, 0);
      if (push) history.pushState({ route }, "", `#/${route}`);
      onPageShown(route);
    },
  });
  if (ok) {
    const h = $(`.page[data-page="${route}"] h1, .page[data-page="${route}"] h2`);
    if (h) { h.setAttribute("tabindex", "-1"); h.focus({ preventScroll: true }); }
  }
}

function originOf(e, el) {
  if (e && e.clientX) return { x: e.clientX, y: e.clientY };
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

function bindNav() {
  $$(".tab").forEach((t) => { const i = document.createElement("i"); i.className = "ind"; t.appendChild(i); });
  $$(".tab, #navLogo, [data-go]").forEach((el) => el.addEventListener("click", (e) => {
    e.preventDefault();
    sound.prime();                                   // must happen inside the user gesture
    navigate(el.dataset.route || el.dataset.go, originOf(e, el));
  }));
  // hovering a tab warms the snapshot cache, so the click starts instantly
  $$(".tab, [data-go]").forEach((el) => ["pointerenter", "focus"].forEach((ev) => el.addEventListener(ev, () => {
    clearTimeout(el._pf); el._pf = setTimeout(() => tm.prefetch(current, el.dataset.route || el.dataset.go), 60);
  })));
  addEventListener("popstate", () => navigate(routeFromHash(), null, { push: false }));
  $("#logoutBtn").addEventListener("click", () => logout());

  const sb = $("#soundBtn");
  let on = false;
  try { on = localStorage.getItem("vox-sound") === "1"; } catch (_) {}
  const paint = () => { sb.classList.toggle("on", on); sb.setAttribute("aria-pressed", on ? "true" : "false");
    sb.querySelector(".x").style.display = on ? "none" : ""; sb.querySelector(".w1").style.display = on ? "" : "none"; };
  sound.setEnabled(false); paint();
  if (on) {   // remembered preference: only enable audio after the first user gesture
    const arm = () => { sound.setEnabled(true); removeEventListener("pointerdown", arm, true); };
    addEventListener("pointerdown", arm, true);
  }
  sb.addEventListener("click", () => {
    on = !on; sound.setEnabled(on); paint();
    try { localStorage.setItem("vox-sound", on ? "1" : "0"); } catch (_) {}
  });
}

function enterApp(animated) {
  if (!pagesReady) { initPages(); pagesReady = true; }
  setActive(routeFromHash());
  history.replaceState({ route: current }, "", `#/${current}`);
  onPageShown(current);
  if (animated === "fresh" && window.gsap && !prefersReducedMotion()) {
    // already logged in (page refresh): gentle entrance
    $("#bg").classList.add("on");
    gsap.from(".topnav", { y: -20, opacity: 0, duration: 0.8, ease: TOKENS.motion.enter });
    gsap.from(".page.active .card, .page.active .hero-wrap > *, .page.active .page-head", { y: 24, opacity: 0, duration: 0.9, ease: TOKENS.motion.enter, stagger: 0.05, delay: 0.1, clearProps: "transform,opacity" });
  }
}

function boot() {
  bindNav();
  bindLogin(() => {
    // build the app underneath first so the hand-off can measure the nav logo
    if (!pagesReady) { initPages(); pagesReady = true; }
    setActive(routeFromHash());
    handoff(() => enterApp(false));
  });
  let authed = false;
  try { authed = !!sessionStorage.getItem("vox-auth"); } catch (_) {}
  if (authed) {
    $("#login").style.display = "none";
    $("#app").hidden = false;
    $("#bg").classList.add("on");
    enterApp("fresh");
  } else {
    startLogin();
  }
}

boot();
