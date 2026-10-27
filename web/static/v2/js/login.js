// LOGIN PAGE: crossfading photo background with Ken Burns + glass form,
// and the seamless hand-off into the app (photos dissolve into the pink blobs,
// the "VOX" title flies into the nav logo).
import { TOKENS, prefersReducedMotion } from "./tokens.js?v=3";
import { $, $$ } from "./ui.js?v=3";

const L = TOKENS.login, M = TOKENS.motion;
let cycleTimer = null, idx = 0, layers = [];

function preload(src) {
  return new Promise((res) => {
    const im = new Image();
    im.onload = () => (im.decode ? im.decode().catch(() => {}).then(() => res(im)) : res(im));
    im.onerror = () => res(null);
    im.src = src;
  });
}


function show(i, instant = false) {
  const next = layers[i];
  layers.forEach((l) => l !== next && l.classList.contains("on") && fadeOut(l, instant));
  next.classList.add("on");
  if (window.gsap) gsap.fromTo(next, { opacity: instant ? 1 : 0 }, { opacity: 1, duration: instant ? 0 : L.fade, ease: "sine.inOut" });
  else next.style.opacity = 1;
}
function fadeOut(l, instant) {
  l.classList.remove("on");
  if (window.gsap) gsap.to(l, { opacity: 0, duration: instant ? 0 : L.fade, ease: "sine.inOut" });
  else l.style.opacity = 0;
}

export async function startLogin() {
  const box = $("#photos");
  box.innerHTML = "";
  layers = L.images.map((src) => {
    const d = document.createElement("div");
    d.className = "photo"; d.style.backgroundImage = `url("${src}")`;
    box.appendChild(d); return d;
  });
  await preload(L.images[0]);
  idx = 0; show(0, false);
  const card = $("#loginForm");
  if (window.gsap) gsap.fromTo(card, { y: 24, opacity: 0, filter: "blur(8px)" }, { y: 0, opacity: 1, filter: "blur(0px)", duration: 1.1, ease: M.enter, delay: 0.15, clearProps: "filter" });
  // Preload the rest before the first crossfade, so there is never a flash.
  Promise.all(L.images.slice(1).map(preload)).then(() => {
    clearInterval(cycleTimer);
    cycleTimer = setInterval(() => { idx = (idx + 1) % layers.length; show(idx); }, L.interval);
  });
  setTimeout(() => $("#email").focus({ preventScroll: true }), 400);
}

export function stopLogin() { clearInterval(cycleTimer); if (window.gsap) gsap.killTweensOf(layers); }

function shake(el) {
  if (!window.gsap || prefersReducedMotion()) return;
  gsap.fromTo(el, { x: 0 }, { x: 0, duration: 0.5, ease: "none", keyframes: { x: [0, -10, 9, -6, 4, 0] } });
}

export function bindLogin(onSuccess) {
  const form = $("#loginForm"), email = $("#email"), pw = $("#password");
  [email, pw].forEach((f) => f.addEventListener("input", () => f.classList.remove("bad")));
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const okEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value.trim());
    const okPw = pw.value.length > 0;
    email.classList.toggle("bad", !okEmail); pw.classList.toggle("bad", !okPw);
    if (!okEmail || !okPw) { shake(form); (okEmail ? pw : email).focus(); return; }
    try { sessionStorage.setItem("vox-auth", email.value.trim()); } catch (_) {}
    onSuccess();
  });
}

// ------------------------------------------------------------ hand-off to app
// The login photos fade/blur away while their pink wash swells and dissolves into
// the app's glow blobs; the VOX title flies into the nav logo; the app rises in.
export function handoff(revealApp) {
  const login = $("#login"), app = $("#app"), bg = $("#bg");
  const reduced = prefersReducedMotion() || !window.gsap;
  app.hidden = false;
  if (reduced) {
    bg.classList.add("on"); login.style.display = "none"; stopLogin(); revealApp(false); return;
  }
  gsap.set(app, { opacity: 1 });
  const nav = $(".topnav"), content = $$(".page.active .card, .page.active .hero-wrap > *, .page.active .page-head");
  const brand = $("#loginBrand"), target = $("#navBrand");
  const a = brand.getBoundingClientRect(), b = target.getBoundingClientRect();   // measure before anything moves
  const fs = parseFloat(getComputedStyle(target).fontSize);
  // lift the title out of the card so the card can fade while the title flies to the nav logo
  const cs = getComputedStyle(brand);
  const keep = { fontSize: cs.fontSize, fontWeight: cs.fontWeight, fontFamily: cs.fontFamily, letterSpacing: cs.letterSpacing,
    paddingLeft: cs.paddingLeft, color: cs.color, textShadow: cs.textShadow, whiteSpace: "nowrap" };
  const rg = document.createRange(); rg.selectNodeContents(brand);
  const textLeft = rg.getBoundingClientRect().left - parseFloat(cs.paddingLeft);
  document.body.appendChild(brand);
  gsap.set(brand, { ...keep, position: "fixed", left: textLeft, top: a.top, margin: 0, zIndex: 30, lineHeight: a.height + "px" });
  gsap.set(target, { opacity: 0 });
  gsap.set(nav, { opacity: 0, y: -20 });
  gsap.set(content, { opacity: 0, y: 26 });
  const blobs = $$("#bg .blob");
  const tl = gsap.timeline({ onComplete: () => { login.style.display = "none"; stopLogin(); revealApp(true); } });
  // 1) the card melts away
  tl.to("#loginForm .field, #loginForm .btn", { opacity: 0, y: 10, filter: "blur(6px)", duration: 0.4, stagger: 0.05, ease: "power2.in" }, 0);
  tl.to("#loginForm", { opacity: 0, scale: 0.96, duration: 0.55, ease: "power2.inOut" }, 0.12);
  // 2) photos blur up and dissolve; the pink wash swells into the app's blobs
  tl.to(".photo", { filter: `blur(${L.blur * 4}px)`, duration: 1.5, ease: M.big }, 0.1);
  tl.to(".login-wash", { opacity: 1, duration: 0.6, ease: "sine.inOut" }, 0.1);
  tl.add(() => bg.classList.add("on"), 0.45);
  tl.fromTo(blobs, { scale: 1.35 }, { scale: 1, duration: 2.0, ease: M.enter, stagger: 0.08, clearProps: "scale" }, 0.45);
  tl.to([".photos", ".login-overlay"], { opacity: 0, duration: 1.2, ease: "sine.inOut" }, 0.55);
  tl.to(".login-wash", { opacity: 0, duration: 1.0, ease: "sine.inOut" }, 1.0);
  // 3) "VOX" flies into the nav logo
  tl.to(brand, { left: b.left, top: b.top, fontSize: fs, lineHeight: b.height + "px", letterSpacing: 0.32 * fs + "px", paddingLeft: 0,
    textShadow: "0 0 0px rgba(246,211,223,0)", duration: 1.15, ease: M.big }, 0.3);
  tl.to(nav, { opacity: 1, y: 0, duration: 0.8, ease: M.enter }, 0.95);
  tl.set(target, { opacity: 1 }, 1.45);
  tl.to(brand, { opacity: 0, duration: 0.15 }, 1.45);
  tl.to(content, { opacity: 1, y: 0, duration: 0.9, ease: M.enter, stagger: 0.05, clearProps: "transform,opacity" }, 1.25);
}

export function logout() {
  try { sessionStorage.removeItem("vox-auth"); } catch (_) {}
  document.documentElement.classList.remove("authed");
  const login = $("#login"), app = $("#app"), bg = $("#bg");
  const finish = () => {
    app.hidden = true; bg.classList.remove("on");
    login.style.display = "";
    gsap.set([".photos", ".login-overlay", ".login-wash", ".photo", "#loginForm", "#loginForm .field", "#loginForm .btn"], { clearProps: "all" });
    $("#password").value = "";
    const brand = $("#loginBrand"); $("#loginForm").prepend(brand); gsap.set(brand, { clearProps: "all" });
    startLogin();
  };
  if (!window.gsap || prefersReducedMotion()) { finish(); return; }
  gsap.to(app, { opacity: 0, duration: TOKENS.motion.fade, ease: "power2.in", onComplete: () => { gsap.set(app, { clearProps: "opacity" }); finish(); } });
}
