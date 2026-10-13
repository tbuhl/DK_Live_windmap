export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
export const lerp = (a, b, t) => a + (b - a) * t;
export const D2R = Math.PI / 180;

export function fmt(n, d = 0) {
  if (n == null || !Number.isFinite(n)) return '–';
  return n.toLocaleString('en-GB', { minimumFractionDigits: d, maximumFractionDigits: d });
}

export function pad(n) { return String(n).padStart(2, '0'); }
export function hhmm(ms, utc = false) {
  const d = new Date(ms);
  return utc ? `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Tiny pub/sub
const handlers = {};
export const bus = {
  on(evt, fn) { (handlers[evt] ||= []).push(fn); },
  emit(evt, ...a) { (handlers[evt] || []).forEach(f => f(...a)); },
};

// ── colour ramps ───────────────────────────────────────────────────────────────
const hex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
export function ramp(stops) {
  const s = stops.map(([t, c]) => [t, hex(c)]);
  return function (t, out = [0, 0, 0]) {
    t = clamp(t, 0, 1);
    let i = 0;
    while (i < s.length - 2 && t > s[i + 1][0]) i++;
    const [t0, c0] = s[i], [t1, c1] = s[i + 1];
    const u = clamp((t - t0) / (t1 - t0 || 1), 0, 1);
    out[0] = c0[0] + (c1[0] - c0[0]) * u; out[1] = c0[1] + (c1[1] - c0[1]) * u; out[2] = c0[2] + (c1[2] - c0[2]) * u;
    return out;
  };
}
export const RAMPS = {
  output: ramp([[0, '#27406b'], [0.08, '#2b7bd6'], [0.3, '#19d3e6'], [0.58, '#4dffa8'], [0.85, '#ffe14d'], [1, '#ff9d2e']]),
  size:   ramp([[0, '#3d6fb0'], [0.4, '#4fd6f0'], [0.75, '#ffd23f'], [1, '#ff6a3d']]),
  age:    ramp([[0, '#ff9d3d'], [0.5, '#ffe07a'], [1, '#5ee1ff']]),
  flow:   ramp([[0, '#3a8cff'], [0.28, '#4fd8ff'], [0.55, '#d4fbff'], [0.8, '#ffe7a6'], [1, '#ffab3d']]),
  flow:   ramp([[0, '#3a8cff'], [0.28, '#4fd8ff'], [0.55, '#d4fbff'], [0.8, '#ffe7a6'], [1, '#ffab3d']]),
  wake:   ramp([[0, '#2ee6ff'], [0.25, '#5a7bff'], [0.5, '#c14dff'], [0.8, '#ff4f8b'], [1, '#ffd0e0']]),
  wind:   ramp([[0, '#2e6bd8'], [0.2, '#25c1e8'], [0.4, '#3dff9c'], [0.6, '#f4ee45'], [0.8, '#ff9a3c'], [1, '#ff3d8b']]),
  temp:   ramp([[0, '#3b4de0'], [0.3, '#38b6ff'], [0.5, '#8be08a'], [0.7, '#ffd23f'], [1, '#ff4f3d']]),
  pres:   ramp([[0, '#b05bff'], [0.35, '#4a8dff'], [0.6, '#5ee1ff'], [0.8, '#ffe07a'], [1, '#ff7a45']]),
  precip: ramp([[0, '#2c4a7a'], [0.3, '#37a8ff'], [0.6, '#7cf0d2'], [1, '#ffffff']]),
};
export const css = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
export function rampGradient(fn, n = 12) {
  const parts = [];
  for (let i = 0; i <= n; i++) parts.push(css(fn(i / n)) + ' ' + (i / n * 100).toFixed(0) + '%');
  return `linear-gradient(90deg,${parts.join(',')})`;
}

// ── network ────────────────────────────────────────────────────────────────────
export async function fetchJSON(url, { timeout = 20000, headers } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers });
    if (!r.ok) { const e = new Error(`HTTP ${r.status} ${url.slice(0, 80)}`); e.status = r.status; throw e; }
    return await r.json();
  } finally { clearTimeout(t); }
}

// Serialises requests with a minimum gap (Energinet rate-limits bursts with HTTP 429).
export class Queue {
  constructor(gap = 700) { this.gap = gap; this.tail = Promise.resolve(); this.block = 0; }
  add(fn) {
    const run = async () => {
      const wait = this.block - Date.now();
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      try { return await fn(); }
      catch (e) { if (e.status === 429) this.block = Date.now() + 12000; throw e; }
      finally { await new Promise(r => setTimeout(r, this.gap)); }
    };
    const p = this.tail.then(run, run);
    this.tail = p.catch(() => {});
    return p;
  }
}

export function store(key, val) {
  try { if (val === undefined) { const s = localStorage.getItem(key); return s ? JSON.parse(s) : null; } localStorage.setItem(key, JSON.stringify(val)); } catch { return null; }
}
