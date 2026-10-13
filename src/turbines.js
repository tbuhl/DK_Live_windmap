// All Danish turbines: glow sprites at distance, real 3D spinning models up close, live output estimate from the wind field,
// archive playback of historical capacity factors, and per-turbine wake-adjusted output.
import { clamp, RAMPS, bus, D2R, fetchJSON } from './util.js';
import { turbineModelUrl } from './model.js';
import { FARMS } from './config.js';
const C = window.Cesium;

export async function loadTurbineData() {
  const d = await fetchJSON('data/turbines.json', { timeout: 60000 });
  d.year = d.con.map(c => (c == null ? null : Math.floor(c / 12)));
  return d;
}

// ── power curve (fraction of rated power) ────────────────────────────────────────
export function ratedSpeed(capKW) { return capKW > 3000 ? 11.5 : capKW > 1000 ? 12.5 : 13.5; }
export function powerFraction(v, ratedAt) {
  if (v < 3) return 0;
  if (v < ratedAt) { const x = (v - 3) / (ratedAt - 3); return x * x * (3 - 2 * x) * 0.55 + Math.pow(x, 3) * 0.45; }
  if (v <= 22) return 1;
  return Math.max(0, 1 - (v - 22) / 8);
}

function glowSprite() {
  const s = 64, c = document.createElement('canvas'); c.width = c.height = s;
  const g = c.getContext('2d'), r = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.16, 'rgba(255,255,255,.95)');
  r.addColorStop(0.3, 'rgba(255,255,255,.38)'); r.addColorStop(0.6, 'rgba(255,255,255,.08)'); r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r; g.fillRect(0, 0, s, s); return c.toDataURL();
}
function ringSprite() {
  const s = 96, c = document.createElement('canvas'); c.width = c.height = s; const g = c.getContext('2d');
  g.strokeStyle = '#5ee1ff'; g.lineWidth = 3; g.shadowColor = '#5ee1ff'; g.shadowBlur = 8;
  g.beginPath(); g.arc(s / 2, s / 2, 30, 0, 7); g.stroke();
  g.lineWidth = 3;
  for (let k = 0; k < 4; k++) { const a = k * Math.PI / 2; g.beginPath(); g.moveTo(s / 2 + Math.cos(a) * 36, s / 2 + Math.sin(a) * 36); g.lineTo(s / 2 + Math.cos(a) * 46, s / 2 + Math.sin(a) * 46); g.stroke(); }
  return c.toDataURL();
}

const MODEL_MAX_H = 22000;
const muniName = s => (s || '').replace(/^\d+\s*-\s*/, '').trim();

export class Turbines {
  constructor(viewer, d, wx) {
    this.viewer = viewer; this.d = d; this.wx = wx; this.n = d.n;
    this.mode = 'live'; this.showOn = true; this.showOff = true; this.yearMax = 2026; this.includeUnknown = true;
    this.ws = new Float32Array(this.n); this.dir = new Float32Array(this.n); this.frac = new Float32Array(this.n);
    this.wsEff = new Float32Array(this.n); this.fracEff = new Float32Array(this.n); this.wakeOn = new Uint8Array(this.n);   // wake analysis results
    this.modelMW = 0;
    this.selected = -1; this.models = new Map(); this.modelUrl = turbineModelUrl();
    this.visible = new Uint8Array(this.n); this.live = new Uint8Array(this.n);
    this.maxModels = 200;
    this.enabled = true; this.nearHide = false;   // glow sprites are hidden under a model only once the model is big enough to read
    this.archive = null;                          // {frame, cf:Uint8Array(n), exist:Uint8Array(n)} when the archive is playing
    this.tmp = [0, 0]; this.col = new C.Color();
    this.lastKey = new Int32Array(this.n).fill(-1); this.lastShow = new Int8Array(this.n).fill(-1);
    for (let i = 0; i < this.n; i++) this.live[i] = d.dec[i] == null ? 1 : 0;

    // glow sprites (decommissioned turbines exist too, but only show in the archive)
    this.bbs = new C.BillboardCollection({ scene: viewer.scene });
    const img = glowSprite();
    for (let i = 0; i < this.n; i++) {
      const px = clamp(4 + 8 * Math.sqrt(d.cap[i] / 4000), 4, 17);
      this.bbs.add({
        id: i, image: img, position: C.Cartesian3.fromDegrees(d.lon[i], d.lat[i], d.hub[i]), show: false,
        width: px, height: px, scaleByDistance: new C.NearFarScalar(1500, 1.0, 1.5e6, 0.95), disableDepthTestDistance: 2.5e4,
      });
    }
    viewer.scene.primitives.add(this.bbs);

    // selection ring
    this.ringBB = new C.BillboardCollection({ scene: viewer.scene });
    this.ring = this.ringBB.add({ image: ringSprite(), width: 56, height: 56, show: false, disableDepthTestDistance: Infinity });
    viewer.scene.primitives.add(this.ringBB);

    this.buildFarms();
    this.applyWind(); this.recolor();
    bus.on('weather', () => this.applyWind());
    viewer.scene.preRender.addEventListener(() => this.preRender());
    this.lastNear = 0; this.lastT = performance.now();
  }

  // ── farms: register parks + proximity groups for unparked turbines; names from a small gazetteer, else municipality ──
  buildFarms() {
    const { d, n } = this;
    const farm = new Int32Array(n).fill(-1), P = d.parks.length;
    for (let i = 0; i < n; i++) if (d.park[i] >= 0) farm[i] = d.park[i];
    // proximity union-find for the rest (1.2 km), live turbines only
    const parent = new Int32Array(n).map((_, i) => i), find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const cell = new Map(), cs = 0.015;   // ~1.7 km grid
    const key = (a, b) => a * 100003 + b;
    for (let i = 0; i < n; i++) {
      if (farm[i] >= 0 || !this.live[i]) continue;
      const cx = Math.floor(d.lon[i] / cs), cy = Math.floor(d.lat[i] / cs);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const arr = cell.get(key(cx + dx, cy + dy)); if (!arr) continue;
        for (const j of arr) {
          const dist = Math.hypot((d.lat[i] - d.lat[j]) * 111.3, (d.lon[i] - d.lon[j]) * 111.3 * 0.56);
          if (dist < 1.2) parent[find(i)] = find(j);
        }
      }
      const k = key(cx, cy); (cell.get(k) || cell.set(k, []).get(k)).push(i);
    }
    const ids = new Map();
    for (let i = 0; i < n; i++) if (farm[i] < 0 && this.live[i]) { const r = find(i); if (!ids.has(r)) ids.set(r, P + ids.size); farm[i] = ids.get(r); }
    this.farmId = farm;
    const farms = new Map();
    for (let i = 0; i < n; i++) {
      if (farm[i] < 0 || !this.live[i]) continue;
      let f = farms.get(farm[i]); if (!f) farms.set(farm[i], f = { id: farm[i], n: 0, mw: 0, lat: 0, lon: 0, off: 0, muni: {} });
      f.n++; f.mw += d.cap[i] / 1000; f.lat += d.lat[i]; f.lon += d.lon[i]; f.off += d.off[i];
      const m = muniName(d.muni[i]); if (m) f.muni[m] = (f.muni[m] || 0) + 1;
    }
    for (const f of farms.values()) {
      f.lat /= f.n; f.lon /= f.n;
      for (const [name, lon, lat, rKm] of FARMS) if (Math.hypot((f.lat - lat) * 111.3, (f.lon - lon) * 111.3 * Math.cos(lat * D2R)) <= rKm) { f.name = name; break; }
      if (!f.name) { const top = Object.entries(f.muni).sort((a, b) => b[1] - a[1])[0]; f.fallback = top ? top[0] : null; }
    }
    this.farms = farms;
    this.labels = new C.LabelCollection({ scene: viewer_scene(this) });
    this.named = [];
    const seen = new Set();
    for (const f of farms.values()) {
      const label = f.name || (f.n >= 12 && f.fallback ? `${f.fallback}` : null);
      if (!label || f.n < 3) continue;
      if (f.name) { if (seen.has(f.name)) continue; seen.add(f.name); }
      this.named.push({ name: label, lon: f.lon, lat: f.lat, n: f.n, mw: f.mw });
    }
    // merge gazetteer farms that span several parks into one label (Kriegers Flak, Horns Rev ...)
    const byName = new Map();
    for (const f of farms.values()) if (f.name) { const e = byName.get(f.name) || { name: f.name, lon: 0, lat: 0, n: 0, mw: 0 }; e.lon += f.lon * f.n; e.lat += f.lat * f.n; e.n += f.n; e.mw += f.mw; byName.set(f.name, e); }
    this.named = this.named.filter(x => !byName.has(x.name));
    for (const e of byName.values()) if (e.n >= 3) this.named.push({ name: e.name, lon: e.lon / e.n, lat: e.lat / e.n, n: e.n, mw: e.mw });
    for (const c of this.named) {
      this.labels.add({
        position: C.Cartesian3.fromDegrees(c.lon, c.lat, 120), text: `${c.name.toUpperCase()}  ·  ${c.n} WTG · ${c.mw.toFixed(0)} MW`,
        font: '600 13px Rajdhani, sans-serif', fillColor: C.Color.fromCssColorString('#bff3ff'), outlineColor: C.Color.fromCssColorString('#02060a'), outlineWidth: 4,
        style: C.LabelStyle.FILL_AND_OUTLINE, horizontalOrigin: C.HorizontalOrigin.CENTER, verticalOrigin: C.VerticalOrigin.BOTTOM,
        pixelOffset: new C.Cartesian2(0, -16), scaleByDistance: new C.NearFarScalar(8000, 1.1, 300000, 0.8), disableDepthTestDistance: 2e4, id: 'label',
      });
    }
    this.viewer.scene.primitives.add(this.labels);
    this.labelsOn = true;
  }

  farmName(i) {
    const f = this.farms.get(this.farmId[i]); return f ? (f.name || f.fallback || null) : null;
  }

  // ── wind → output ──
  applyWind() {
    const { d, wx, tmp } = this;
    if (!wx.ready) return;
    let mw = 0;
    for (let i = 0; i < this.n; i++) {
      if (!this.live[i]) continue;
      if (!wx.wind(d.lon[i], d.lat[i], tmp)) { this.ws[i] = 0; this.frac[i] = 0; continue; }
      const s100 = Math.hypot(tmp[0], tmp[1]);
      const alpha = d.off[i] ? 0.09 : 0.16, hub = this.ws[i] = s100 * Math.pow(clamp(d.hub[i], 25, 220) / 100, alpha);
      this.dir[i] = (Math.atan2(-tmp[0], -tmp[1]) / D2R + 360) % 360;
      this.frac[i] = powerFraction(hub, ratedSpeed(d.cap[i]));
      mw += d.cap[i] * this.frac[i] * 0.93 / 1000;
    }
    this.modelMW = mw;
    if (!this.archive) this.recolor();
    this.models.forEach((m, i) => this.placeModel(m, i));
    bus.emit('turbines:model', mw);
    bus.emit('turbines:wind');
  }

  /** wake analysis hands back effective speeds for a subset of turbines */
  applyWake(idx, wsEff, fracEff) {
    this.wakeOn.fill(0);
    for (let k = 0; k < idx.length; k++) { const i = idx[k]; this.wsEff[i] = wsEff[k]; this.fracEff[i] = fracEff[k]; this.wakeOn[i] = 1; }
    if (!this.archive) this.recolor();
  }
  clearWake() { if (this.wakeOn.some(v => v)) { this.wakeOn.fill(0); if (!this.archive) this.recolor(); } }

  // ── appearance ──
  setMode(m) { this.mode = m; this.refresh(); }
  setFilter(f) { Object.assign(this, f); this.refresh(); }
  setEnabled(on) {
    this.enabled = on; this.bbs.show = on; this.labels.show = on && this.labelsOn;
    this.models.forEach(m => { if (m.model) m.model.show = on; });
    if (!on) this.ring.show = false; else this.updateRing();
  }
  setLabels(on) { this.labelsOn = on; this.labels.show = on && this.enabled; }
  refresh() { this.archive ? this.applyArchive(this.archive.frame, true) : this.recolor(); }

  /** diff-based billboard update: only touches billboards whose colour / visibility actually changed */
  paint(i, show, r, g, b, a) {
    const bb = this.bbs.get(i), s = show && !(this.nearHide && this.models.get(i)?.active) ? 1 : 0;
    if (this.lastShow[i] !== s) { bb.show = !!s; this.lastShow[i] = s; }
    if (!show) return;
    const key = ((r | 0) << 20) ^ ((g | 0) << 12) ^ ((b | 0) << 4) ^ ((a * 15) | 0);
    if (this.lastKey[i] === key) return;
    this.lastKey[i] = key;
    C.Color.fromBytes(r, g, b, a * 255, this.col); bb.color = this.col;
  }

  colorFor(i, out) {
    const d = this.d, mode = this.mode, yr = d.year[i];
    let a = 0.95, rgb;
    if (mode === 'live') {
      if (!this.wx.ready) { rgb = [94, 200, 255]; a = 0.8; }   // no wind data yet: neutral cyan
      else { const f = this.wakeOn[i] ? this.fracEff[i] : this.frac[i]; rgb = RAMPS.output(Math.pow(f, 0.8)); a = f < 0.02 ? 0.45 : 0.95; }
    } else if (mode === 'cap') rgb = RAMPS.size(Math.log(Math.max(d.cap[i], 5) / 20) / Math.log(15000 / 20));
    else { rgb = RAMPS.age(yr == null ? 0.5 : (yr - 1978) / 48); a = yr == null ? 0.4 : 0.95; }
    out[0] = rgb[0]; out[1] = rgb[1]; out[2] = rgb[2]; out[3] = a; return out;
  }

  recolor() {
    const { d } = this, c4 = [0, 0, 0, 0];
    let shown = 0, mw = 0;
    for (let i = 0; i < this.n; i++) {
      const yr = d.year[i];
      const vis = this.live[i] && (d.off[i] ? this.showOff : this.showOn) && (yr == null ? this.includeUnknown : yr <= this.yearMax);
      this.visible[i] = vis ? 1 : 0;
      if (!vis) { this.paint(i, false); continue; }
      shown++; mw += d.cap[i] / 1000;
      this.colorFor(i, c4); this.paint(i, true, c4[0], c4[1], c4[2], c4[3]);
    }
    this.shown = shown; this.shownMW = mw;
    bus.emit('turbines:filter', { shown, mw });
  }

  // ── archive ──
  setArchive(hist) { this.archive = hist ? { hist, frame: -1 } : null; if (!hist) { this.lastKey.fill(-1); this.recolor(); } else this.clearModels(); }
  /** frame f: draws every turbine that existed then, coloured by its capacity factor */
  applyArchive(f, force = false) {
    const A = this.archive; if (!A) return;
    const h = A.hist, d = this.d, N = this.n, cf = h.frame(f), tIdx = h.frameMonthIdx(f);
    A.frame = f; let n = 0, mw = 0, prodMW = 0;
    for (let i = 0; i < N; i++) {
      const con = d.con[i], dec = d.dec[i];
      const exists = (con == null || con <= tIdx) && (dec == null || dec > tIdx) && (d.off[i] ? this.showOff : this.showOn);
      this.visible[i] = exists ? 1 : 0;
      if (!exists) { this.paint(i, false); continue; }
      n++; mw += d.cap[i] / 1000; const v = cf[i] / 250; prodMW += d.cap[i] / 1000 * v;
      const rgb = RAMPS.output(Math.min(1, v / 0.62));
      this.paint(i, true, rgb[0], rgb[1], rgb[2], v < 0.01 ? 0.4 : 0.95);
    }
    bus.emit('archive:frame', { f, n, mw, prodMW });
  }

  // ── details ──
  describe(i) {
    const d = this.d, f = this.farms.get(this.farmId[i]);
    return {
      i, gsrn: d.gsrn[i], lon: d.lon[i], lat: d.lat[i], make: d.makes[d.make[i]], type: d.types[d.type[i]], muni: muniName(d.muni[i]),
      capKW: d.cap[i], capEst: !!d.capEst[i], geoEst: !!d.geoEst[i], rotor: d.rotor[i], hub: d.hub[i], year: d.year[i], con: d.con[i], dec: d.dec[i],
      offshore: !!d.off[i], ws: this.ws[i], dir: this.dir[i], frac: this.frac[i], wake: !!this.wakeOn[i], wsEff: this.wsEff[i], fracEff: this.fracEff[i],
      farm: this.farmName(i), farmStats: f ? { n: f.n, mw: f.mw, lon: f.lon, lat: f.lat } : null, xy: d.xy[i], live: !!this.live[i],
    };
  }

  select(i) {
    this.selected = i; this.updateRing();
    bus.emit('select', i < 0 ? null : this.describe(i));
  }
  updateRing() {
    if (this.selected < 0 || !this.enabled) { this.ring.show = false; return; }
    const d = this.d, i = this.selected;
    this.ring.position = C.Cartesian3.fromDegrees(d.lon[i], d.lat[i], d.hub[i]); this.ring.show = true;
  }
  pickIndex(pick) {
    if (!pick || !Number.isInteger(pick.id) || pick.id < 0 || pick.id >= this.n) return -1;
    return pick.id;
  }

  // ── near-field 3D models ──
  preRender() {
    const now = performance.now(), dt = Math.min(0.1, (now - this.lastT) / 1000); this.lastT = now;
    if (now - this.lastNear > 450) { this.lastNear = now; this.updateNear(); this.updateLabels(); }
    for (const [i, m] of this.models) {
      if (!m.node) continue;
      const w = this.wakeOn[i] ? this.wsEff[i] : this.ws[i], R = this.d.rotor[i] / 2;
      const spinning = (this.wakeOn[i] ? this.fracEff[i] : this.frac[i]) > 0;
      const omega = spinning ? Math.min(1.7, 7.2 * w / R) : 0.06;
      m.angle = (m.angle + omega * dt) % (Math.PI * 2);
      C.Quaternion.fromAxisAngle(C.Cartesian3.UNIT_X, m.angle, m.q);
      C.Matrix4.fromTranslationQuaternionRotationScale(m.t, m.q, m.s, m.mat);
      m.node.matrix = m.mat;
    }
  }

  updateNear() {
    const cam = this.viewer.camera, carto = cam.positionCartographic;
    const hide = this.nearHide ? carto.height < 3400 : carto.height < 2300;   // hysteresis
    if (hide !== this.nearHide) { this.nearHide = hide; this.models.forEach((m, i) => { const b = this.bbs.get(i); if (b && m.active && this.visible[i]) { b.show = !hide; this.lastShow[i] = hide ? 0 : 1; } }); }
    if (!this.enabled || this.archive || carto.height > MODEL_MAX_H) { if (this.models.size) this.clearModels(); return; }
    const sc = this.viewer.scene.canvas;
    const p = cam.pickEllipsoid(new C.Cartesian2(sc.clientWidth / 2, sc.clientHeight * 0.55), this.viewer.scene.globe.ellipsoid);
    const cc = p ? C.Cartographic.fromCartesian(p) : carto;
    const lon0 = C.Math.toDegrees(cc.longitude), lat0 = C.Math.toDegrees(cc.latitude), kx = Math.cos(lat0 * D2R) * 111320, ky = 111320;
    const R = clamp(carto.height * 1.6, 2500, 26000), R2 = R * R, cand = [];
    const { lon, lat } = this.d;
    for (let i = 0; i < this.n; i++) {
      if (!this.visible[i]) continue;
      const dx = (lon[i] - lon0) * kx, dy = (lat[i] - lat0) * ky, q = dx * dx + dy * dy;
      if (q < R2) cand.push([q, i]);
    }
    cand.sort((a, b) => a[0] - b[0]);
    const want = new Set(cand.slice(0, this.maxModels).map(c => c[1]));
    for (const [i, m] of this.models) if (!want.has(i)) this.dropModel(i, m);
    for (const i of want) if (!this.models.has(i)) this.addModel(i);
  }

  /** Farm labels read well when looking down from ~6-300 km; near the horizon they pile up, so hide those. */
  updateLabels() {
    const c = this.viewer.camera.positionCartographic, h = c.height;
    const lon0 = c.longitude / D2R, lat0 = c.latitude / D2R, kx = Math.cos(c.latitude) * 111320;
    const inRange = h > 6000 && h < 300000 && !this.archive;
    for (let k = 0; k < this.labels.length; k++) {
      const l = this.labels.get(k), n = this.named[k]; if (!n) continue;
      const dx = (n.lon - lon0) * kx, dy = (n.lat - lat0) * 111320, el = Math.atan2(h, Math.hypot(dx, dy));
      l.show = inRange && el > 0.2;
    }
  }

  clearModels() { for (const [i, m] of [...this.models]) this.dropModel(i, m); }
  dropModel(i, m) {
    this.models.delete(i); m.dead = true;
    if (m.model) this.viewer.scene.primitives.remove(m.model);
    const b = this.bbs.get(i); if (b && this.visible[i]) { b.show = true; this.lastShow[i] = 1; }
  }

  addModel(i) {
    const m = { active: false, dead: false, model: null, node: null, angle: Math.random() * 6.28, q: new C.Quaternion(), t: new C.Cartesian3(), s: new C.Cartesian3(), mat: new C.Matrix4() };
    this.models.set(i, m);
    C.Model.fromGltfAsync({
      url: this.modelUrl, id: i, upAxis: C.Axis.Z, forwardAxis: C.Axis.X, modelMatrix: C.Matrix4.clone(C.Matrix4.IDENTITY),
      allowPicking: true, scene: this.viewer.scene, show: this.enabled, shadows: C.ShadowMode.DISABLED,
    }).then(model => {
      if (m.dead) { model.destroy(); return; }
      m.model = model; this.viewer.scene.primitives.add(model);
      const ready = () => {
        if (m.dead) return;
        this.placeModel(m, i);
        m.node = model.getNode('rotor');
        m.active = true; const b = this.bbs.get(i); if (b && this.nearHide) { b.show = false; this.lastShow[i] = 0; }
      };
      if (model.ready) ready(); else model.readyEvent.addEventListener(ready);
    }).catch(e => { console.warn('model failed', e); m.dead = true; });
  }

  placeModel(m, i) {
    if (!m.model) return;
    const d = this.d, R = Math.min(d.rotor[i], 250) / 2, H = Math.max(d.hub[i], R + 6);   // never let blades reach the ground
    const enu = C.Transforms.eastNorthUpToFixedFrame(C.Cartesian3.fromDegrees(d.lon[i], d.lat[i], 0));
    const yaw = (90 - this.dir[i]) * D2R;
    C.Matrix4.multiplyByMatrix3(enu, C.Matrix3.fromRotationZ(yaw), m.model.modelMatrix);
    const rb = clamp(H * 0.036, 0.35, 5), len = R * 0.26, wid = R * 0.085, hgt = R * 0.1;
    const tw = m.model.getNode('tower'), nc = m.model.getNode('nacelle');
    if (tw) tw.matrix = C.Matrix4.fromTranslationQuaternionRotationScale(C.Cartesian3.ZERO, C.Quaternion.IDENTITY, new C.Cartesian3(rb, rb, H), new C.Matrix4());
    if (nc) nc.matrix = C.Matrix4.fromTranslationQuaternionRotationScale(new C.Cartesian3(-len * 0.1, 0, H - hgt * 0.1), C.Quaternion.IDENTITY, new C.Cartesian3(len, wid, hgt), new C.Matrix4());
    m.t.x = len * 0.4 + R * 0.01; m.t.y = 0; m.t.z = H; m.s.x = m.s.y = m.s.z = R;
  }
}

function viewer_scene(t) { return t.viewer.scene; }
