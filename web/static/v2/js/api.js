// Talks to the FastAPI backend (web/app.py). Add ?demo=1 to the URL to run the
// UI against a built-in simulated server (for previews without Python/Spark).
import { demoFetch } from "./demo.js?v=3";

export const DEMO = new URLSearchParams(location.search).has("demo");

async function rawFetch(path, opts) {
  return DEMO ? demoFetch(path, opts) : fetch(path, opts);
}

export async function api(path, opts = {}) {
  const r = await rawFetch(path, opts);
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).detail || msg; } catch (_) {}
    throw new Error(msg);
  }
  return r.json();
}

export const postJSON = (p, body) =>
  api(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
