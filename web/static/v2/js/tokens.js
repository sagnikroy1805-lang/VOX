// ============================================================================
// VOX DESIGN TOKENS — the ONE source of truth for the whole UI.
// Login page, app interior and both WebGL transitions read their colours,
// blur, radii, durations and easings from here. applyTokens() copies them into
// CSS custom properties on :root, so the stylesheet always matches the JS.
// ============================================================================

export const TOKENS = {
  color: {
    black: "#000000",
    surface1: "#0A0A0B",
    surface2: "#121214",
    pink: "#F6D3DF",       // primary light pink (cherry-blossom petals)
    pinkMid: "#EFB8CB",
    pinkDeep: "#E08AA8",
    crimson: "#B4235A",    // blossom-bud crimson, small accents only
    text: "#FFFFFF",
    text2: "#A1A1AA",
  },
  glass: {
    bg: "rgba(18,18,20,0.45)",
    bgStrong: "rgba(18,18,20,0.62)",
    blur: 20,                               // px (16–24)
    border: "rgba(246,211,223,0.12)",
    borderHover: "rgba(246,211,223,0.30)",
    line: "rgba(246,211,223,0.08)",         // table rules, dividers
  },
  radius: { card: 20, pill: 999, input: 14, small: 12 },
  blob: { blur: 130, opacity: 0.55 },
  motion: {
    hover: 0.2,                             // s
    fadeFast: 0.3,
    fade: 0.45,
    enter: "power3.out",                    // GSAP entrances
    big: "expo.inOut",                      // GSAP big moves
    cssEnter: "cubic-bezier(.215,.61,.355,1)",
    cssBig: "cubic-bezier(.87,0,.13,1)",
  },
  login: {
    images: ["static/v2/img/blossom.jpg", "static/v2/img/neon-street.jpg"],  // add more here
    interval: 9000,                         // ms between crossfades
    fade: 1.8,                              // s crossfade
    blur: 1,                                // px background blur (barely there, photo stays sharp)
    overlay: 0.4,                           // black overlay strength
  },
  transition: { blackhole: 2.65, fallback: 0.3, maxRepeat: 2 },
  font: '"Inter Variable", "Inter", "Noto Sans JP", system-ui, "Segoe UI", sans-serif',
};

// Convert a hex token to [r,g,b] floats (0..1) for shaders.
export function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function prefersReducedMotion() {
  return matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function applyTokens(root = document.documentElement) {
  const c = TOKENS.color, g = TOKENS.glass, r = TOKENS.radius, m = TOKENS.motion;
  const set = (k, v) => root.style.setProperty(k, v);
  set("--black", c.black); set("--surface-1", c.surface1); set("--surface-2", c.surface2);
  set("--pink", c.pink); set("--pink-mid", c.pinkMid); set("--pink-deep", c.pinkDeep);
  set("--crimson", c.crimson); set("--text", c.text); set("--text-2", c.text2);
  set("--glass-bg", g.bg); set("--glass-bg-strong", g.bgStrong); set("--glass-blur", g.blur + "px");
  set("--glass-border", g.border); set("--glass-border-hover", g.borderHover); set("--line", g.line);
  set("--r-card", r.card + "px"); set("--r-pill", r.pill + "px"); set("--r-input", r.input + "px"); set("--r-small", r.small + "px");
  set("--blob-blur", TOKENS.blob.blur + "px"); set("--blob-opacity", TOKENS.blob.opacity);
  set("--t-hover", m.hover * 1000 + "ms"); set("--t-fade", m.fade * 1000 + "ms"); set("--t-fade-fast", m.fadeFast * 1000 + "ms");
  set("--ease-enter", m.cssEnter); set("--ease-big", m.cssBig);
  set("--login-blur", TOKENS.login.blur + "px"); set("--login-overlay", TOKENS.login.overlay);
  set("--font", TOKENS.font);
}
