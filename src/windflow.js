// Wind-flow particles: advected in lon/lat through the 100 m wind field, drawn on a 2D canvas over the globe.
// Trails are stored as ECEF points and re-projected every frame, so they stay glued to the globe while the camera moves.
import { GRID, GRID_RECT } from './config.js';
import { clamp, RAMPS, css, D2R } from './util.js';
const C = window.Cesium;

const MAXP = 3800, TRAIL = 11, BUCKETS = 7, LEVELS = 3, LEVEL_ALPHA = [1, 0.42, 0.16];
const A = 6378137, E2 = 0.00669437999014;

function ecef(lonR, latR, h, out, o) {
  const s = Math.sin(latR), c = Math.cos(latR), n = A / Math.sqrt(1 - E2 * s * s);
  out[o] = (n + h) * c * Math.cos(lonR); out[o + 1] = (n + h) * c * Math.sin(lonR); out[o + 2] = (n * (1 - E2) + h) * s;
}

export class WindFlow {
  constructor(canvas, viewer, wx) {
    this.cv = canvas; this.ctx = canvas.getContext('2d'); this.viewer = viewer; this.wx = wx;
    this.enabled = true;
    this.lon = new Float32Array(MAXP); this.lat = new Float32Array(MAXP); this.age = new Float32Array(MAXP); this.life = new Float32Array(MAXP);
    this.trail = new Float32Array(MAXP * TRAIL * 3);     // ECEF ring (index 0 = newest)
    this.spd = new Float32Array(MAXP);
    this.scr = new Float32Array(MAXP * TRAIL * 2);       // projected px, NaN when hidden
    this.bbox = { w: GRID_RECT.west, e: GRID_RECT.east, s: GRID_RECT.south, n: GRID_RECT.north };
    this.span = 8e5; this.active = MAXP; this.quality = 1; this.vp = new C.Matrix4(); this.tmp = [0, 0]; this.frameNo = 0; this.dpr = 1;
    const NB = BUCKETS * LEVELS;
    this.buckets = Array.from({ length: NB }, () => new Uint16Array(MAXP)); this.bn = new Uint16Array(NB);
    this.colors = Array.from({ length: BUCKETS }, (_, b) => RAMPS.flow((b + 0.5) / BUCKETS));
    for (let i = 0; i < MAXP; i++) this.spawn(i, true);
    this.resize(); window.addEventListener('resize', () => this.resize());
    viewer.camera.moveEnd.addEventListener(() => this.updateView());
    viewer.camera.changed.addEventListener(() => this.updateView());
    this.updateView();
  }

  resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.cv.width = Math.round(innerWidth * this.dpr); this.cv.height = Math.round(innerHeight * this.dpr);
  }

  /** Work out which part of the world is on screen (bbox) and a length scale for particle speed. */
  updateView() {
    const cam = this.viewer.camera, scene = this.viewer.scene, W = innerWidth, H = innerHeight;
    let w = 1e9, e = -1e9, s = 1e9, n = -1e9, hits = 0;
    for (const [fx, fy] of [[0.1, 0.1], [0.9, 0.1], [0.5, 0.5], [0.1, 0.9], [0.9, 0.9], [0.5, 0.15], [0.5, 0.85]]) {
      const p = cam.pickEllipsoid(new C.Cartesian2(W * fx, H * fy), scene.globe.ellipsoid);
      if (!p) continue;
      const c = C.Cartographic.fromCartesian(p), lo = C.Math.toDegrees(c.longitude), la = C.Math.toDegrees(c.latitude);
      w = Math.min(w, lo); e = Math.max(e, lo); s = Math.min(s, la); n = Math.max(n, la); hits++;
    }
    const full = this.bboxFull = { w: GRID_RECT.west, e: GRID_RECT.east, s: GRID_RECT.south, n: GRID_RECT.north };
    if (hits < 3 || e < full.w || w > full.e || n < full.s || s > full.n) { this.bbox = full; this.active = hits < 3 ? MAXP : 0; this.span = 8e5; }
    else {
      const padx = (e - w) * 0.08, pady = (n - s) * 0.08;
      this.bbox = { w: Math.max(full.w, w - padx), e: Math.min(full.e, e + padx), s: Math.max(full.s, s - pady), n: Math.min(full.n, n + pady) };
      const widthM = (this.bbox.e - this.bbox.w) * 111320 * Math.cos(((this.bbox.n + this.bbox.s) / 2) * D2R);
      this.span = clamp(widthM, 2500, 1.4e6);
      const area = (this.bbox.e - this.bbox.w) * (this.bbox.n - this.bbox.s);
      this.active = Math.round(clamp(area / 9, 0.12, 1) * MAXP);
    }
  }

  spawn(i, scatterAge = false) {
    const b = this.bbox;
    this.lon[i] = b.w + Math.random() * (b.e - b.w); this.lat[i] = b.s + Math.random() * (b.n - b.s);
    this.life[i] = 70 + Math.random() * 90; this.age[i] = scatterAge ? Math.random() * this.life[i] : 0;
    const lr = this.lon[i] * D2R, tr = this.lat[i] * D2R, t = this.trail, o = i * TRAIL * 3;
    for (let k = 0; k < TRAIL; k++) ecef(lr, tr, 60, t, o + k * 3);
  }

  setEnabled(on) { this.enabled = on; if (!on) this.ctx.clearRect(0, 0, this.cv.width, this.cv.height); }

  frame(dtMs) {
    if (!this.enabled || !this.wx.ready) return;
    const ctx = this.ctx, W = this.cv.width, H = this.cv.height, dpr = this.dpr;
    ctx.clearRect(0, 0, W, H);
    const cam = this.viewer.camera;
    // streaks are a regional-scale view: fade them out as the camera drops towards the turbines
    const hFade = clamp((cam.positionCartographic.height - 1800) / 4500, 0, 1);
    if (hFade <= 0.01) return;
    C.Matrix4.multiply(cam.frustum.projectionMatrix, cam.viewMatrix, this.vp);
    const m = this.vp, cp = cam.positionWC;
    const k = clamp(dtMs / 16.7, 0.3, 3) * this.span / 9000;   // metres per (m/s) per frame
    const b = this.bbox, w = this.tmp, bn = this.bn; bn.fill(0);
    const frame = ++this.frameNo, lon = this.lon, lat = this.lat, trail = this.trail, scr = this.scr, n = Math.round(this.active * this.quality);
    const cw = innerWidth, ch = innerHeight;

    for (let i = 0; i < MAXP; i++) {
      if (i >= n) { scr[i * TRAIL * 2] = NaN; continue; }
      // advect
      let ok = this.wx.wind(lon[i], lat[i], w);
      this.age[i] += 1;
      if (!ok || this.age[i] > this.life[i] || lon[i] < b.w || lon[i] > b.e || lat[i] < b.s || lat[i] > b.n) { this.spawn(i); ok = this.wx.wind(lon[i], lat[i], w); if (!ok) { scr[i * TRAIL * 2] = NaN; continue; } }
      const sp = Math.hypot(w[0], w[1]); this.spd[i] = sp;
      lon[i] += (w[0] * k) / (111320 * Math.cos(lat[i] * D2R)); lat[i] += (w[1] * k) / 111320;
      // shift trail (newest first) every 2nd frame
      const o = i * TRAIL * 3;
      if (frame % 2 === 0) { trail.copyWithin(o + 3, o, o + (TRAIL - 1) * 3); }
      ecef(lon[i] * D2R, lat[i] * D2R, 60, trail, o);
      // project
      let vis = 0;
      for (let t = 0; t < TRAIL; t++) {
        const x = trail[o + t * 3], y = trail[o + t * 3 + 1], z = trail[o + t * 3 + 2], so = (i * TRAIL + t) * 2;
        const cx = m[0] * x + m[4] * y + m[8] * z + m[12], cy = m[1] * x + m[5] * y + m[9] * z + m[13], cwp = m[3] * x + m[7] * y + m[11] * z + m[15];
        const horizon = (x * cp.x + y * cp.y + z * cp.z) > (x * x + y * y + z * z) * 0.99985;
        if (cwp <= 0 || !horizon) { scr[so] = NaN; continue; }
        scr[so] = (cx / cwp * 0.5 + 0.5) * cw; scr[so + 1] = (1 - (cy / cwp * 0.5 + 0.5)) * ch; vis++;
      }
      if (vis < 2) continue;
      // fade near the edge of the weather grid and at both ends of a particle's life, so nothing pops in or shows a hard border
      const edge = Math.min(lon[i] - GRID_RECT.west, GRID_RECT.east - lon[i], lat[i] - GRID_RECT.south, GRID_RECT.north - lat[i]) / 0.8;
      const fade = Math.min(edge, this.age[i] / 14, (this.life[i] - this.age[i]) / 14, 1);
      const lvl = fade > 0.7 ? 0 : fade > 0.3 ? 1 : 2;
      const bi = Math.min(BUCKETS - 1, (sp / 20 * BUCKETS) | 0) * LEVELS + lvl;
      this.buckets[bi][bn[bi]++] = i;
    }

    ctx.globalCompositeOperation = 'lighter'; ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(1, 1.15 * dpr);
    const sc = dpr;
    for (let bi = 0; bi < BUCKETS * LEVELS; bi++) {
      const list = this.buckets[bi], cnt = bn[bi]; if (!cnt) continue;
      const col = this.colors[(bi / LEVELS) | 0], la = LEVEL_ALPHA[bi % LEVELS];
      for (let t = 0; t < TRAIL - 1; t++) {
        const a = 1 - t / (TRAIL - 1);
        ctx.strokeStyle = css(col, (0.62 * a * a + 0.03) * la * hFade);
        ctx.beginPath();
        for (let q = 0; q < cnt; q++) {
          const so = (list[q] * TRAIL + t) * 2, x0 = scr[so], x1 = scr[so + 2];
          if (x0 !== x0 || x1 !== x1) continue;
          const y0 = scr[so + 1], y1 = scr[so + 3];
          if (Math.abs(x0 - x1) > 200 || Math.abs(y0 - y1) > 200) continue;
          ctx.moveTo(x0 * sc, y0 * sc); ctx.lineTo(x1 * sc, y1 * sc);
        }
        ctx.stroke();
      }
    }
  }
}
