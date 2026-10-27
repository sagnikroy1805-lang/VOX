// Snapshots a page of the app into a canvas (for use as a WebGL texture).
// The glass cards are rendered by html2canvas on a transparent background and
// composited over a canvas re-painting of the live pink blobs, so frame 0 of a
// transition matches what is on screen.
import { TOKENS } from "../tokens.js?v=3";

const BLOB_COLORS = { b1: TOKENS.color.pinkDeep, b2: TOKENS.color.crimson, b3: TOKENS.color.pinkMid, b4: TOKENS.color.pink };

export function snapshotScale() { return Math.min(window.devicePixelRatio || 1, 1.5); }

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// Paint the background (black + blurred blobs) at the blobs' current positions.
export function paintBackground(W, H, scale = snapshotScale()) {
  const c = document.createElement("canvas");
  c.width = Math.round(W * scale); c.height = Math.round(H * scale);
  const g = c.getContext("2d");
  g.fillStyle = TOKENS.color.black; g.fillRect(0, 0, c.width, c.height);
  g.save();
  g.scale(scale, scale);
  g.filter = `blur(${TOKENS.blob.blur * scale}px)`;   // canvas filters ignore the transform
  document.querySelectorAll("#bg .blob").forEach((el) => {
    const r = el.getBoundingClientRect();
    const op = parseFloat(getComputedStyle(el).opacity) || 0;
    const key = [...el.classList].find((k) => BLOB_COLORS[k]);
    if (!key || op <= 0) return;
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2, rad = Math.max(r.width, r.height) / 2;
    // CSS radial-gradient(circle, …) defaults to farthest-corner: radius = r·√2, clipped by border-radius 50%
    const grad = g.createRadialGradient(cx, cy, 0, cx, cy, rad * Math.SQRT2);
    grad.addColorStop(0, hexA(BLOB_COLORS[key], op));
    grad.addColorStop(0.7, hexA(BLOB_COLORS[key], 0));
    g.fillStyle = grad;
    g.beginPath(); g.arc(cx, cy, rad, 0, Math.PI * 2); g.fill();
  });
  g.restore();
  return c;
}

// Content layer only (transparent): the glass cards, nav and text of one page.
// route: page to show; atTop: render as if scrolled to the top.
export async function snapshotContent(route, { atTop = false } = {}) {
  const W = document.documentElement.clientWidth, H = window.innerHeight, scale = snapshotScale();
  const sx = atTop ? 0 : window.scrollX, sy = atTop ? 0 : window.scrollY;
  return window.html2canvas(document.body, {
    backgroundColor: null, scale, logging: false, useCORS: true, imageTimeout: 0,
    x: sx, y: sy, width: W, height: H, scrollX: -sx, scrollY: -sy, windowWidth: W, windowHeight: H,
    ignoreElements: (el) => el.id === "bg" || el.id === "fx" || el.id === "toast" || el.id === "login" || el.id === "blocker" || el.tagName === "AUDIO",
    onclone: (doc) => {
      doc.querySelectorAll(".page").forEach((p) => p.classList.toggle("active", p.dataset.page === route));
      doc.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.route === route));
      // html2canvas cannot paint gradient text: use the primary pink instead.
      doc.querySelectorAll(".grad").forEach((e) => { e.style.background = "none"; e.style.color = TOKENS.color.pink; e.style.webkitTextFillColor = TOKENS.color.pink; });
      // Only the first screenful matters; keep big tables cheap to render.
      doc.querySelectorAll(".tbl table").forEach((t) => [...t.rows].slice(24).forEach((r) => r.remove()));
      const app = doc.getElementById("app"); if (app) app.style.opacity = "1";
    },
  });
}

// Final texture source: the live blob background with the content layer on top.
export function composite(content) {
  const W = document.documentElement.clientWidth, H = window.innerHeight;
  const bg = paintBackground(W, H, snapshotScale());
  bg.getContext("2d").drawImage(content, 0, 0, bg.width, bg.height);
  if (new URLSearchParams(location.search).has("debug")) (window.__voxSnaps = window.__voxSnaps || []).push(bg);
  return bg;
}

export async function snapshotPage(route, opts) { return composite(await snapshotContent(route, opts)); }
