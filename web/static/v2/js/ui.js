// Small shared UI helpers.
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

export const fmt = (v, d = 2) => (v === null || v === undefined || Number.isNaN(v) ? "—" : Number(v).toFixed(d));
export const pct = (v) => (v === null || v === undefined ? "—" : (v * 100).toFixed(1) + "%");
export const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
export const tile = (k, v, hl = false) => `<div class="tile${hl ? " hl" : ""}"><div class="k">${k}</div><div class="v">${v}</div></div>`;
export const LANG = { en: "English", es: "Español", ja: "日本語" };
export const CODE = { en: "EN", es: "ES", ja: "JA" };

export function toast(msg, err = false) {
  const t = $("#toast");
  t.textContent = msg; t.hidden = false; t.classList.toggle("err", err);
  if (window.gsap) gsap.fromTo(t, { y: 16, opacity: 0 }, { y: 0, opacity: 1, duration: 0.35, ease: "power3.out" });
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    if (window.gsap) gsap.to(t, { y: 10, opacity: 0, duration: 0.3, onComplete: () => (t.hidden = true) });
    else t.hidden = true;
  }, err ? 7000 : 3500);
}

// Status dot in the nav: ok (pink glow) / busy (pulsing) / bad (crimson)
export function setStatus(state, title) {
  const d = $("#statusDot");
  d.className = "status-dot " + state;
  if (title) d.title = title;
}
