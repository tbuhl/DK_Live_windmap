// Wake model core (no DOM): Niayifar & Porté-Agel (2016) Gaussian wake [Bastankhah & Porté-Agel 2014 deficit,
// turbulence-dependent expansion] with squared-sum superposition and effective-wind-speed propagation.
// Mirrors PyWake's NiayifarGaussianDeficit + SquaredSum + PropagateDownwind (verified by scripts/wake_validate.py).
// Used by wake-worker.js in the browser and by Node for validation.

export const D2R = Math.PI / 180;

// generic turbine curves, shared with the live-output model ─────────────────────────────
export function ratedSpeed(capKW) { return capKW > 3000 ? 11.5 : capKW > 1000 ? 12.5 : 13.5; }
export function powerFraction(v, ratedAt) {
  if (v < 3) return 0;
  if (v < ratedAt) { const x = (v - 3) / (ratedAt - 3); return x * x * (3 - 2 * x) * 0.55 + Math.pow(x, 3) * 0.45; }
  if (v <= 22) return 1;
  return Math.max(0, 1 - (v - 22) / 8);
}
/** generic thrust coefficient curve: ~0.82 below rated, falling away above it */
export function thrustCoefficient(u, capKW) {
  const vr = ratedSpeed(capKW);
  if (u < 3) return 0;
  if (u < 4.5) return 0.55 + 0.27 * (u - 3) / 1.5;
  if (u <= 0.82 * vr) return 0.82;
  if (u < vr) return 0.82 - 0.20 * (u - 0.82 * vr) / (0.18 * vr);
  if (u <= 25) return Math.max(0.03, 0.62 * Math.pow(vr / u, 2.6));
  return 0.03;
}

const CTLIM = 0.899, CEPS = 0.2, A1 = 0.38, A2 = 4e-3;
export const ct2a = ct => ct * (0.2460 + ct * (0.0586 + ct * 0.0883));      // Madsen et al. (2020)
export const expansionK = ti => A1 * ti + A2;

/** wake width (m) at downwind distance x behind a rotor of diameter D */
export function sigma(k, x, D, ct) {
  const s = Math.sqrt(1 - Math.min(CTLIM, ct)), beta = 0.5 * (1 + s) / s;
  return k * x + CEPS * Math.sqrt(beta) * D;
}
/** velocity deficit (m/s) at (dw, cw) metres from a source with effective speed uRef and thrust ct */
export function deficit(uRef, ct, D, k, dw, cw) {
  if (dw <= 0 || ct <= 0) return 0;
  const sg = sigma(k, dw, D, ct), s2 = sg * sg;
  const centre = uRef * Math.min(1, 2 * ct2a(ct * D * D / (8 * s2)));
  return centre * Math.exp(-0.5 * cw * cw / s2);
}

/**
 * T: {x[], y[] (m, east/north), D[], cap[] (kW), u[] (ambient hub speed), dir[] (deg, direction the wind comes FROM), ti[]}
 * opts: {raster: {x0, y0, dx, nx, ny}, rowWidth}
 * returns {ueff[], frac[], fracGross[], ct[], raster?: Float32Array (wake deficit fraction 0..1), rows?: [{p, eff, n}]}
 */
export function computeWake(T, opts = {}) {
  const n = T.x.length, dxv = new Float64Array(n), dyv = new Float64Array(n);
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) {
    const th = T.dir[i] * D2R; dxv[i] = -Math.sin(th); dyv[i] = -Math.cos(th);     // unit vector the wind blows towards
    mx += dxv[i]; my += dyv[i];
  }
  const ml = Math.hypot(mx, my) || 1; mx /= ml; my /= ml;
  const proj = new Float64Array(n), order = Array.from({ length: n }, (_, i) => i);
  for (let i = 0; i < n; i++) proj[i] = T.x[i] * mx + T.y[i] * my;
  order.sort((a, b) => proj[a] - proj[b]);                                        // most upstream first
  const ueff = new Float64Array(n), ct = new Float64Array(n), kk = new Float64Array(n);
  for (let r = 0; r < n; r++) {
    const i = order[r]; let sum2 = 0;
    for (let q = 0; q < r; q++) {
      const j = order[q];
      if (ct[j] <= 0) continue;
      const ddx = T.x[i] - T.x[j], ddy = T.y[i] - T.y[j];
      const dw = ddx * dxv[j] + ddy * dyv[j];
      if (dw <= 0 || dw > 45 * T.D[j]) continue;
      const cw = ddx * -dyv[j] + ddy * dxv[j];
      if (Math.abs(cw) > 5 * (kk[j] * dw + 1.2 * T.D[j]) + T.D[i]) continue;      // beyond ~5 sigma: negligible
      const d = deficit(ueff[j], ct[j], T.D[j], kk[j], dw, cw);
      sum2 += d * d;
    }
    ueff[i] = Math.max(0, T.u[i] - Math.sqrt(sum2));
    ct[i] = thrustCoefficient(ueff[i], T.cap[i]); kk[i] = expansionK(T.ti[i]);
  }
  const frac = new Float64Array(n), fracGross = new Float64Array(n);
  for (let i = 0; i < n; i++) { const vr = ratedSpeed(T.cap[i]); frac[i] = powerFraction(ueff[i], vr); fracGross[i] = powerFraction(T.u[i], vr); }
  const out = { ueff, frac, fracGross, ct };

  // efficiency by row along the mean wind direction (the classic Horns Rev row plot)
  const rw = opts.rowWidth || 600, rows = new Map();
  let pmin = Infinity; for (let i = 0; i < n; i++) pmin = Math.min(pmin, proj[i]);
  for (let i = 0; i < n; i++) {
    const b = Math.floor((proj[i] - pmin) / rw); let e = rows.get(b); if (!e) rows.set(b, e = { p: b, net: 0, gross: 0, n: 0 });
    e.net += frac[i] * T.cap[i]; e.gross += fracGross[i] * T.cap[i]; e.n++;
  }
  out.rows = [...rows.values()].sort((a, b) => a.p - b.p).map(e => ({ p: e.p, n: e.n, eff: e.gross > 0 ? e.net / e.gross : 1 }));

  if (opts.raster) {
    const { x0, y0, dx, nx, ny } = opts.raster, R = new Float32Array(nx * ny);
    const reach = new Float64Array(n); for (let j = 0; j < n; j++) reach[j] = 45 * T.D[j];
    for (let j = 0; j < n; j++) {
      if (ct[j] <= 0) continue;
      const D = T.D[j], k = kk[j], uref = ueff[j], amb = Math.max(T.u[j], 0.1);
      // bounding box of this wake's influence → only visit cells inside it
      const lx = T.x[j], ly = T.y[j], len = Math.min(reach[j], 20000);
      const ex = lx + dxv[j] * len, ey = ly + dyv[j] * len, half = 5 * (k * len + 1.2 * D) + D;
      const minx = Math.min(lx, ex) - half, maxx = Math.max(lx, ex) + half, miny = Math.min(ly, ey) - half, maxy = Math.max(ly, ey) + half;
      const i0 = Math.max(0, Math.floor((minx - x0) / dx)), i1 = Math.min(nx - 1, Math.ceil((maxx - x0) / dx));
      const j0 = Math.max(0, Math.floor((miny - y0) / dx)), j1 = Math.min(ny - 1, Math.ceil((maxy - y0) / dx));
      for (let cy = j0; cy <= j1; cy++) for (let cx = i0; cx <= i1; cx++) {
        const px = x0 + (cx + 0.5) * dx, py = y0 + (cy + 0.5) * dx, ddx = px - lx, ddy = py - ly;
        const dw = ddx * dxv[j] + ddy * dyv[j]; if (dw <= 0 || dw > len) continue;
        const cw = ddx * -dyv[j] + ddy * dxv[j];
        const d = deficit(uref, ct[j], D, k, dw, cw) / amb;
        const idx = cy * nx + cx; R[idx] = Math.sqrt(R[idx] * R[idx] + d * d);
      }
    }
    out.raster = R;
  }
  return out;
}
