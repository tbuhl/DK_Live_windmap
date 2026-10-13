// Farm-level wake analysis: triggers when the camera is close to a wind farm, runs the Gaussian wake model in a worker with the
// current (or forecast) hub-height wind speed and direction, paints effective output onto turbines and a wake-deficit overlay on the ground.
import { clamp, bus, D2R, RAMPS, css, $, fmt } from './util.js';
import { centerGround } from './globe.js';
import { computeWake } from './wakecore.js';
const C = window.Cesium;

const M_LON = 111320, M_LAT = 110574;
const MAX_H = 70000, MAX_N = 650;          // analysis switches on from ~70 km up (roughly two zoom levels above a single farm)

export class WakeAnalysis {
  constructor(viewer, turbines) {
    this.viewer = viewer; this.t = turbines; this.enabled = true; this.active = false;
    this.busy = false; this.dirty = false; this.id = 0; this.last = 0; this.entity = null; this.timer = 0;
    try { this.worker = new Worker(new URL('./wake-worker.js', import.meta.url), { type: 'module' }); this.worker.onmessage = e => this.done(e.data); this.worker.onerror = e => { console.warn('wake worker failed, falling back', e.message); this.worker = null; }; }
    catch (e) { this.worker = null; }
    this.canvas = document.createElement('canvas');
    this.card = $('#wakecard');
    viewer.camera.moveEnd.addEventListener(() => this.schedule(350));
    bus.on('turbines:wind', () => this.schedule(500));
    bus.on('archive:mode', on => { this.archive = on; if (on) this.clear(); else this.schedule(200); });
  }

  setEnabled(on) { this.enabled = on; if (!on) this.clear(); else this.schedule(50); }
  schedule(ms) { clearTimeout(this.timer); this.timer = setTimeout(() => this.run(), ms); }

  clear() {
    this.active = false; this.t.clearWake();
    if (this.entity) this.entity.show = false;
    this.card.hidden = true; bus.emit('wake:stats', null);
  }

  run() {
    if (!this.enabled || this.archive || !this.t.enabled) return this.clear();
    const cam = this.viewer.camera, h = cam.positionCartographic.height;
    if (h > (this.active ? MAX_H * 1.2 : MAX_H)) return this.clear();
    if (this.busy) { this.dirty = true; return; }
    const g = centerGround(this.viewer), d = this.t.d, R = clamp(h * 1.4, 4000, 42000) + 5000;
    const lon0 = g.lon, lat0 = g.lat, kx = M_LON * Math.cos(lat0 * D2R), cand = [];
    for (let i = 0; i < this.t.n; i++) {
      if (!this.t.visible[i]) continue;
      const x = (d.lon[i] - lon0) * kx, y = (d.lat[i] - lat0) * M_LAT, q = x * x + y * y;
      if (q < R * R) cand.push([q, i]);
    }
    if (cand.length < 4) return this.clear();
    cand.sort((a, b) => a[0] - b[0]);
    const idx = cand.slice(0, MAX_N).map(c => c[1]), n = idx.length;
    const T = { x: new Float64Array(n), y: new Float64Array(n), D: new Float64Array(n), cap: new Float64Array(n), u: new Float64Array(n), dir: new Float64Array(n), ti: new Float64Array(n) };
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, uSum = 0, dx = 0, dy = 0;
    idx.forEach((i, k) => {
      T.x[k] = (d.lon[i] - lon0) * kx; T.y[k] = (d.lat[i] - lat0) * M_LAT; T.D[k] = d.rotor[i]; T.cap[k] = d.cap[i];
      T.u[k] = this.t.ws[i]; T.dir[k] = this.t.dir[i]; T.ti[k] = d.off[i] ? 0.06 : 0.11;
      x0 = Math.min(x0, T.x[k]); x1 = Math.max(x1, T.x[k]); y0 = Math.min(y0, T.y[k]); y1 = Math.max(y1, T.y[k]);
      uSum += T.u[k]; dx += -Math.sin(T.dir[k] * D2R); dy += -Math.cos(T.dir[k] * D2R);
    });
    // raster bounds = the turbines plus the full downwind wake (offshore wakes stay measurable for >10 km), fine enough to resolve a rotor
    const mdx = dx / (Math.hypot(dx, dy) || 1), mdy = dy / (Math.hypot(dx, dy) || 1), offShare = idx.reduce((a, i) => a + d.off[i], 0) / n, L = offShare > 0.5 ? 16000 : 9000;
    let bx0 = 1e9, bx1 = -1e9, by0 = 1e9, by1 = -1e9;
    for (const [cx, cy] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) for (const t of [0, L]) { const px = cx + mdx * t, py = cy + mdy * t; bx0 = Math.min(bx0, px); bx1 = Math.max(bx1, px); by0 = Math.min(by0, py); by1 = Math.max(by1, py); }
    const pad = 1500, W = bx1 - bx0 + 2 * pad, Hh = by1 - by0 + 2 * pad, cell = clamp(Math.max(W, Hh) / 640, 18, 130);
    const nx = Math.min(700, Math.ceil(W / cell)), ny = Math.min(700, Math.ceil(Hh / cell));
    const raster = { x0: bx0 - pad, y0: by0 - pad, dx: cell, nx, ny };
    this.ctx = { idx, lon0, lat0, kx, raster, meanU: uSum / n, meanDir: (Math.atan2(-dx, -dy) / D2R + 360) % 360, n, center: g };
    this.busy = true; const id = ++this.id;
    if (this.worker) this.worker.postMessage({ id, T, raster, rowWidth: Math.max(300, 6 * (T.D.reduce((a, b) => a + b, 0) / n)) });
    else { const r = computeWake(T, { raster, rowWidth: 500 }); this.done({ id, ms: 0, ...r, raster: r.raster }); }
  }

  done(m) {
    this.busy = false;
    if (this.dirty) { this.dirty = false; this.schedule(30); }
    if (m.id !== this.id || !this.ctx) return;
    const { idx, raster, lon0, lat0, kx } = this.ctx, d = this.t.d;
    if (!this.enabled || this.archive) return this.clear();
    this.active = true;
    this.t.applyWake(idx, m.ueff, m.frac);
    // aggregate
    let gross = 0, net = 0, worst = 1, worstI = -1, sp = 0, sn = 0;
    idx.forEach((i, k) => { if (this.t.ws[i] > 0.5) { sp += m.ueff[k] / this.t.ws[i]; sn++; } const c = d.cap[i] / 1000; gross += c * m.fracGross[k]; net += c * m.frac[k]; const e = m.fracGross[k] > 0.02 ? m.frac[k] / m.fracGross[k] : 1; if (e < worst) { worst = e; worstI = i; } });
    const stats = { n: idx.length, gross: gross * 0.93, net: net * 0.93, loss: gross > 0 ? 1 - net / gross : 0, speedLoss: sn ? 1 - sp / sn : 0, worst, worstI, meanU: this.ctx.meanU, dir: this.ctx.meanDir, rows: m.rows, ms: m.ms, center: this.ctx.center };
    this.paintOverlay(m.raster, raster, lon0, lat0, kx);
    this.renderCard(stats);
    bus.emit('wake:stats', stats);
  }

  paintOverlay(R, g, lon0, lat0, kx) {
    if (!R) return;
    const cv = this.canvas; cv.width = g.nx; cv.height = g.ny;
    const ctx = cv.getContext('2d'), img = ctx.createImageData(g.nx, g.ny), out = [0, 0, 0];
    for (let y = 0; y < g.ny; y++) for (let x = 0; x < g.nx; x++) {
      const v = R[y * g.nx + x], o = ((g.ny - 1 - y) * g.nx + x) * 4;
      if (v < 0.012) { img.data[o + 3] = 0; continue; }
      RAMPS.wake(clamp(v / 0.42, 0, 1), out);       // low deficits get colour too, so the long tail stays visible
      img.data[o] = out[0]; img.data[o + 1] = out[1]; img.data[o + 2] = out[2]; img.data[o + 3] = Math.pow(clamp((v - 0.012) / 0.06, 0, 1), 0.65) * 225;
    }
    ctx.putImageData(img, 0, 0);
    const copy = document.createElement('canvas'); copy.width = g.nx; copy.height = g.ny; copy.getContext('2d').drawImage(cv, 0, 0);
    const west = lon0 + g.x0 / kx, east = lon0 + (g.x0 + g.nx * g.dx) / kx, south = lat0 + g.y0 / M_LAT, north = lat0 + (g.y0 + g.ny * g.dx) / M_LAT;
    const rect = C.Rectangle.fromDegrees(west, south, east, north), mat = new C.ImageMaterialProperty({ image: copy, transparent: true });
    if (!this.entity) this.entity = this.viewer.entities.add({ rectangle: { coordinates: rect, material: mat, classificationType: C.ClassificationType.TERRAIN } });
    else { this.entity.rectangle.coordinates = rect; this.entity.rectangle.material = mat; this.entity.show = true; }
  }

  renderCard(s) {
    const farm = this.t.farmName(this.ctx.idx[0]) || 'Wind farm area';
    const compass = a => ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round(a / 22.5) % 16];
    const bars = s.rows.length > 1 ? s.rows.map(r => `<i style="height:${(14 + clamp((r.eff - 0.5) / 0.5, 0, 1) * 86).toFixed(0)}%;background:${css(RAMPS.output(clamp((r.eff - 0.3) / 0.7, 0, 1)))}" title="${(r.eff * 100).toFixed(0)}% · ${r.n} WTG"></i>`).join('') : '';
    const lossCol = s.loss > 0.2 ? 'var(--mag)' : s.loss > 0.08 ? 'var(--amber)' : 'var(--green)';
    this.card.hidden = false;
    this.card.innerHTML = `<div class="wh"><b>WAKE ANALYSIS</b><span>${farm} · ${s.n} WTG in view</span></div>
      <div class="wgrid">
        <div><label>HUB WIND</label><b>${s.meanU.toFixed(1)} m/s</b><small>from ${compass(s.dir)} ${Math.round(s.dir)}°</small></div>
        <div><label>GROSS → NET</label><b>${s.gross.toFixed(1)} → ${s.net.toFixed(1)}<small> MW</small></b><small>${(s.net / Math.max(s.gross, 1e-6) * 100).toFixed(0)}% of free-stream</small></div>
        <div><label>WAKE LOSS</label><b style="color:${lossCol}">${(s.loss * 100).toFixed(1)}%</b><small>wind speed −${(s.speedLoss * 100).toFixed(1)}% · worst WTG ${(s.worst * 100).toFixed(0)}%</small></div>
      </div>
      ${bars ? `<div class="rows"><div class="rb">${bars}</div><div class="rl"><span>upwind</span><span>row efficiency 50–100% ▸ downwind</span></div></div>` : ''}
      ${s.loss < 0.005 && s.meanU > 11 ? '<div class="wf" style="color:var(--dim)">Above rated wind speed: wakes slow the wind but the turbines still hit full power.</div>' : ''}
      <div class="wf">Gaussian wake (Niayifar &amp; Porté-Agel 2016) · ${s.ms.toFixed(0)} ms · follows the timeline's wind</div>`;
  }
}
