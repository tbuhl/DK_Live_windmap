// Interconnectors on the globe: glowing arcs, energy packets travelling in the direction of flow, price chips at both ends.
import { LINKS, AREA_CHIPS } from './config.js';
import { clamp, fmt, $ } from './util.js';
const C = window.Cesium;

const NPTS = 56, MAXPKT = 28, SCRATCH = new C.Cartesian3();
const EXPORT = C.Color.fromCssColorString('#ffb23e'), IMPORT = C.Color.fromCssColorString('#5ee1ff'), IDLE = C.Color.fromCssColorString('#6b8696');

function arc(a, b, lift) {
  const g = new C.EllipsoidGeodesic(C.Cartographic.fromDegrees(...a), C.Cartographic.fromDegrees(...b));
  const peak = Math.max(2500, g.surfaceDistance * lift), out = [];
  for (let i = 0; i < NPTS; i++) {
    const t = i / (NPTS - 1), c = g.interpolateUsingFraction(t);
    out.push(C.Cartesian3.fromRadians(c.longitude, c.latitude, 120 + 4 * peak * t * (1 - t)));
  }
  return out;
}

export class Links {
  constructor(viewer, energy) {
    this.viewer = viewer; this.energy = energy; this.enabled = true; this.t0 = performance.now();
    this.pts = new C.PointPrimitiveCollection(); viewer.scene.primitives.add(this.pts);
    this.nodes = $('#nodes');
    this.items = LINKS.map(lk => {
      const path = arc(lk.a, lk.b, lk.lift);
      const ent = viewer.entities.add({ polyline: { positions: path, width: 4, arcType: C.ArcType.NONE,
        material: new C.PolylineGlowMaterialProperty({ glowPower: 0.2, color: IDLE.withAlpha(0.6) }) } });
      const packets = Array.from({ length: MAXPKT }, () => this.pts.add({ pixelSize: 5, color: IDLE, outlineWidth: 0, show: false,
        scaleByDistance: new C.NearFarScalar(5e3, 2.2, 2.5e6, 0.8), disableDepthTestDistance: 3e5 }));
      const chip = document.createElement('div'); chip.className = 'node'; this.nodes.appendChild(chip);
      return { lk, path, ent, packets, chip, mw: 0, phase: Math.random(), anchor: path[NPTS - 1], count: 0, dir: 0 };
    });
    // price chips for DK1 / DK2
    this.areaChips = Object.entries(AREA_CHIPS).map(([area, ll]) => {
      const chip = document.createElement('div'); chip.className = 'node dk'; this.nodes.appendChild(chip);
      return { area, chip, pos: C.Cartesian3.fromDegrees(ll[0], ll[1], 3000) };
    });
    viewer.scene.postRender.addEventListener(() => this.frame());
  }

  setEnabled(on) {
    this.enabled = on;
    this.items.forEach(it => { it.ent.show = on; });
    this.pts.show = on;
    if (!on) { this.items.forEach(it => { it.chip.style.display = 'none'; }); this.areaChips.forEach(a => { a.chip.style.display = 'none'; }); }
  }

  /** Called whenever Energinet data refreshes. */
  update() {
    const en = this.energy, now = Date.now();
    this.items.forEach(it => {
      const v = en.flow(it.lk) ?? 0; it.mw = v;
      const exp = v < 0, on = Math.abs(v) > 8, col = !on ? IDLE : exp ? EXPORT : IMPORT;
      it.dir = !on ? 0 : exp ? 1 : -1;                          // +1 → travels DK → abroad
      it.count = !on ? 0 : clamp(Math.round(Math.abs(v) / 40), 2, MAXPKT);
      it.ent.polyline.width = 2 + clamp(Math.abs(v) / lkScale(it.lk), 0, 1) * 5;
      it.ent.polyline.material = new C.PolylineGlowMaterialProperty({ glowPower: on ? 0.16 : 0.08, color: col.withAlpha(on ? 0.7 : 0.3) });
      it.packets.forEach(p => { p.color = col; });
      const pf = it.lk.areaFar ? en.priceAt(it.lk.areaFar, now) : null;
      const arrow = !on ? '' : exp ? `<span class="ex">▶ ${fmt(Math.abs(v))} MW</span>` : `<span class="im">◀ ${fmt(Math.abs(v))} MW</span>`;
      it.chip.innerHTML = `<em>${it.lk.far.toUpperCase()}</em>${pf ? fmt(pf.eur, 0) + '€' : ''}<span class="a">${arrow}</span>`;
    });
    this.updateAreas();
  }

  updateAreas() {
    this.areaChips.forEach(a => {
      const p = this.energy.priceAt(a.area, this.energy.T);
      a.chip.innerHTML = `<em>${a.area}</em>⚡ ${p ? fmt(p.eur, 0) + ' €/MWh' : '–'}`;
    });
  }

  frame() {
    if (!this.enabled) return;
    const now = performance.now(), dt = Math.min(0.1, (now - (this._last || now)) / 1000); this._last = now;
    const cam = this.viewer.camera, cp = cam.positionWC, h = cam.positionCartographic.height;
    const scene = this.viewer.scene, tmp = new C.Cartesian2();
    const place = (el, pos, hide) => {
      const dot = C.Cartesian3.dot(pos, cp), r2 = C.Cartesian3.dot(pos, pos);
      const s = (!hide && dot > r2 * 0.9995) ? scene.cartesianToCanvasCoordinates(pos, tmp) : undefined;
      if (!s) { el.style.display = 'none'; return; }
      el.style.display = 'block'; el.style.transform = `translate(${s.x.toFixed(0)}px,${(s.y - 6).toFixed(0)}px) translate(-50%,-100%)`;
    };
    const hide = h > 3.2e6;
    this.items.forEach(it => {
      it.phase = (it.phase + dt * 0.075 * (it.dir || 0) * (0.6 + 0.8 * clamp(Math.abs(it.mw) / lkScale(it.lk), 0, 1))) % 1;
      if (it.phase < 0) it.phase += 1;
      it.packets.forEach((p, k) => {
        if (k >= it.count) { p.show = false; return; }
        let u = (it.phase + k / it.count) % 1;
        const f = u * (NPTS - 1), i = Math.min(NPTS - 2, f | 0);
        C.Cartesian3.lerp(it.path[i], it.path[i + 1], f - i, SCRATCH); p.position = SCRATCH; p.show = true;
        p.pixelSize = 4 + 3 * Math.sin(u * Math.PI);
      });
      place(it.chip, it.anchor, hide || it.lk.id === 'BELT');
    });
    this.areaChips.forEach(a => place(a.chip, a.pos, hide || h < 12000));
  }

  /** Fly target for an interconnector row */
  focus(id) { const it = this.items.find(i => i.lk.id === id); return it ? it.lk : null; }
}

function lkScale(lk) { return lk.cap; }
