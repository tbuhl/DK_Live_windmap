// Weather: gridded Open-Meteo fields (now + hourly forecast), cloud/heat overlays, RainViewer radar.
import { GRID, GRID_RECT } from './config.js';
import { clamp, lerp, fetchJSON, RAMPS, store, bus, D2R } from './util.js';
const C = window.Cesium;

const NCELL = GRID.nx * GRID.ny;
const FIELDS = ['u', 'v', 'ws', 'gust', 'cloud', 'precip', 'temp', 'pres'];
const mk = () => Object.fromEntries(FIELDS.map(f => [f, new Float32Array(NCELL)]));

export class WeatherField {
  constructor() {
    this.frames = [];          // hourly frames {t, ...fields}
    this.now = null;           // 'current' frame
    this.active = mk();        // blended for the scrub time
    this.t = Date.now();       // active time (ms)
    this.ready = false;
    this.runInfo = '';
  }

  cellOrder() {
    const la = [], lo = [];
    for (let j = 0; j < GRID.ny; j++) for (let i = 0; i < GRID.nx; i++) {
      la.push((GRID.lat0 + j * GRID.dlat).toFixed(2)); lo.push((GRID.lon0 + i * GRID.dlon).toFixed(2));
    }
    return { la, lo };
  }

  url(kind) {
    const { la, lo } = this.cellOrder();
    const vars = 'wind_speed_100m,wind_direction_100m,wind_gusts_10m,cloud_cover,precipitation,temperature_2m,pressure_msl';
    const q = kind === 'current' ? `&current=${vars}` : `&hourly=${vars}&past_hours=3&forecast_hours=25`;
    return 'https://api.open-meteo.com/v1/forecast?latitude=' + la.join(',') + '&longitude=' + lo.join(',') + q + '&wind_speed_unit=ms&timezone=GMT';
  }

  /** Fast path (~0.5 s): the live 'current' frame. Cached for 10 min to be gentle on the free API. */
  async load() {
    const cached = store('dkw.current');
    if (cached && Date.now() - cached.at < 10 * 60e3) { this.ingestCurrent(cached.cells, cached.time); return 'cache'; }
    try {
      const data = await fetchJSON(this.url('current'), { timeout: 60000 });
      const cells = data.map(d => d.current), time = data[0].current.time;
      store('dkw.current', { at: Date.now(), cells, time });
      this.ingestCurrent(cells, time); return 'live';
    } catch (e) {
      if (cached) { this.ingestCurrent(cached.cells, cached.time); return 'stale'; }
      throw e;
    }
  }

  /** Slow path (can take ~20 s): hourly frames for the timeline. Runs in the background; cached for 3 h. */
  async loadForecast() {
    const cached = store('dkw.forecast');
    if (cached && Date.now() - cached.at < 3 * 3600e3) { this.ingestForecast(cached.times, cached.hourly); return 'cache'; }
    try {
      const data = await fetchJSON(this.url('hourly'), { timeout: 90000 });
      const times = data[0].hourly.time, hourly = data.map(d => d.hourly);
      store('dkw.forecast', { at: Date.now(), times, hourly });
      this.ingestForecast(times, hourly); return 'live';
    } catch (e) {
      if (cached) { this.ingestForecast(cached.times, cached.hourly); return 'stale'; }
      throw e;
    }
  }

  frameFrom(get) {
    const f = mk();
    for (let c = 0; c < NCELL; c++) {
      const ws = get('wind_speed_100m', c) ?? 0, wd = (get('wind_direction_100m', c) ?? 0) * D2R;
      f.ws[c] = ws; f.u[c] = -ws * Math.sin(wd); f.v[c] = -ws * Math.cos(wd);
      f.gust[c] = get('wind_gusts_10m', c) ?? ws; f.cloud[c] = get('cloud_cover', c) ?? 0;
      f.precip[c] = get('precipitation', c) ?? 0; f.temp[c] = get('temperature_2m', c) ?? 0; f.pres[c] = get('pressure_msl', c) ?? 1013;
    }
    return f;
  }

  ingestCurrent(cells, time) {
    this.now = this.frameFrom((name, c) => cells[c][name]);
    this.now.t = Date.parse(time + 'Z');
    this.fetchedAt = Date.now(); this.ready = true; this.runInfo = time + 'Z';
    this.setTime(this.t, true);
  }

  ingestForecast(times, hourly) {
    this.frames = times.map((t, k) => { const f = this.frameFrom((name, c) => hourly[c][name]?.[k]); f.t = Date.parse(t + 'Z'); return f; });
    bus.emit('forecast');
    this.setTime(this.t, true);
  }

  /** Blend frames for time `ms`. When `ms` is within 7 min of now use the live 'current' frame. */
  setTime(ms, force = false) {
    if (!this.ready) return;
    if (!force && Math.abs(ms - this.t) < 20e3) return;
    this.t = ms;
    const out = this.active;
    const live = Math.abs(ms - Date.now()) < 7 * 60e3 || !this.frames.length;
    if (live) { for (const f of FIELDS) out[f].set(this.now[f]); }
    else {
      const fr = this.frames; let i = 0;
      while (i < fr.length - 2 && fr[i + 1].t <= ms) i++;
      const a = fr[i], b = fr[Math.min(i + 1, fr.length - 1)];
      const w = clamp((ms - a.t) / Math.max(1, b.t - a.t), 0, 1);
      for (const f of FIELDS) { const o = out[f], x = a[f], y = b[f]; for (let c = 0; c < NCELL; c++) o[c] = x[c] + (y[c] - x[c]) * w; }
      for (let c = 0; c < NCELL; c++) out.ws[c] = Math.hypot(out.u[c], out.v[c]);
    }
    bus.emit('weather');
  }

  /** bilinear sample of one field */
  at(field, lon, lat) {
    const gx = (lon - GRID.lon0) / GRID.dlon, gy = (lat - GRID.lat0) / GRID.dlat;
    if (gx < 0 || gy < 0 || gx > GRID.nx - 1 || gy > GRID.ny - 1) return NaN;
    const i = Math.min(GRID.nx - 2, gx | 0), j = Math.min(GRID.ny - 2, gy | 0), fx = gx - i, fy = gy - j;
    const a = this.active[field], k = j * GRID.nx + i;
    return lerp(lerp(a[k], a[k + 1], fx), lerp(a[k + GRID.nx], a[k + GRID.nx + 1], fx), fy);
  }

  /** wind vector (u,v in m/s) into out[0..1]; returns false outside the domain */
  wind(lon, lat, out) {
    const gx = (lon - GRID.lon0) / GRID.dlon, gy = (lat - GRID.lat0) / GRID.dlat;
    if (gx < 0 || gy < 0 || gx > GRID.nx - 1 || gy > GRID.ny - 1) return false;
    const i = Math.min(GRID.nx - 2, gx | 0), j = Math.min(GRID.ny - 2, gy | 0), fx = gx - i, fy = gy - j;
    const k = j * GRID.nx + i, U = this.active.u, V = this.active.v, n = GRID.nx;
    out[0] = lerp(lerp(U[k], U[k + 1], fx), lerp(U[k + n], U[k + n + 1], fx), fy);
    out[1] = lerp(lerp(V[k], V[k + 1], fx), lerp(V[k + n], V[k + n + 1], fx), fy);
    return true;
  }
}

// ── overlay (cloud cover / heat fields) drawn as a ground rectangle ────────────────
const FIELD_META = {
  gust:   { ramp: RAMPS.wind,   lo: 0,    hi: 30,   unit: 'm/s', label: 'Gusts' },
  temp:   { ramp: RAMPS.temp,   lo: -5,   hi: 25,   unit: '°C',  label: 'Temperature' },
  pres:   { ramp: RAMPS.pres,   lo: 985,  hi: 1040, unit: 'hPa', label: 'Pressure' },
  precip: { ramp: RAMPS.precip, lo: 0,    hi: 4,    unit: 'mm/h', label: 'Precipitation' },
};
export const fieldMeta = FIELD_META;

export class Overlay {
  constructor(viewer, wx, kind) {
    this.viewer = viewer; this.wx = wx; this.kind = kind;
    this.W = 640; this.H = Math.round(640 * (GRID_RECT.north - GRID_RECT.south) / ((GRID_RECT.east - GRID_RECT.west) * 1.0));
    this.small = document.createElement('canvas'); this.small.width = GRID.nx; this.small.height = GRID.ny;
    this.big = document.createElement('canvas'); this.big.width = this.W; this.big.height = this.H;
    this.entity = null; this.enabled = false; this._tick = 0;
  }
  setEnabled(on) {
    this.enabled = on;
    if (on && !this.entity) {
      this.entity = this.viewer.entities.add({
        rectangle: {
          coordinates: C.Rectangle.fromDegrees(GRID_RECT.west, GRID_RECT.south, GRID_RECT.east, GRID_RECT.north),
          material: new C.ImageMaterialProperty({ image: this.big, transparent: true }),
          classificationType: C.ClassificationType.TERRAIN,
        },
      });
    }
    if (this.entity) this.entity.show = on;
    if (on) this.redraw();
  }
  setKind(k) { this.kind = k; if (this.enabled) this.redraw(); }

  redraw() {
    if (!this.enabled || !this.wx.ready) return;
    const sctx = this.small.getContext('2d'), img = sctx.createImageData(GRID.nx, GRID.ny);
    const cloud = this.kind === 'cloud', meta = FIELD_META[this.kind];
    const arr = this.wx.active[cloud ? 'cloud' : this.kind];
    const alphaScale = cloud ? 0.6 : 0.58;
    for (let j = 0; j < GRID.ny; j++) for (let i = 0; i < GRID.nx; i++) {
      const v = arr[j * GRID.nx + i], o = ((GRID.ny - 1 - j) * GRID.nx + i) * 4;   // canvas y runs north → south
      let rgb, a;
      if (cloud) { rgb = [226, 238, 250]; a = Math.pow(clamp((v - 12) / 88, 0, 1), 1.15) * alphaScale; }
      else {
        const t = (v - meta.lo) / (meta.hi - meta.lo); rgb = meta.ramp(t);
        a = this.kind === 'precip' ? clamp(v / 0.4, 0, 1) * 0.8 : alphaScale;
      }
      img.data[o] = rgb[0]; img.data[o + 1] = rgb[1]; img.data[o + 2] = rgb[2]; img.data[o + 3] = a * 255;
    }
    sctx.putImageData(img, 0, 0);
    const ctx = this.big.getContext('2d');
    ctx.clearRect(0, 0, this.W, this.H);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    // cells are sample *centres*: stretch so first/last centre sit on the rectangle edges
    ctx.filter = 'blur(7px)';
    const px = this.W / GRID.nx, py = this.H / GRID.ny;
    ctx.drawImage(this.small, -px / 2, -py / 2, this.W + px, this.H + py);
    ctx.filter = 'none';
    // fade out towards every edge of the domain so the rectangle never shows
    const px4 = ctx.getImageData(0, 0, this.W, this.H), dat = px4.data, W = this.W, H = this.H, fx = W * 0.16, fy = H * 0.24;
    for (let y = 0; y < H; y++) {
      const ey = Math.min(1, Math.min(y, H - 1 - y) / fy);
      for (let x = 0; x < W; x++) {
        const t = Math.min(ey, Math.min(1, Math.min(x, W - 1 - x) / fx)), k = t * t * (3 - 2 * t);
        dat[(y * W + x) * 4 + 3] *= k;
      }
    }
    ctx.putImageData(px4, 0, 0);
    // ImageMaterialProperty only repaints when it sees a new image reference
    this.entity.rectangle.material = new C.ImageMaterialProperty({ image: this.copy(), transparent: true });
  }
  copy() { const c = document.createElement('canvas'); c.width = this.W; c.height = this.H; c.getContext('2d').drawImage(this.big, 0, 0); return c; }
}

// ── RainViewer radar ─────────────────────────────────────────────────────────────
export class Radar {
  constructor(viewer) { this.viewer = viewer; this.layers = []; this.frames = []; this.enabled = false; this.cur = -1; this.host = ''; }
  async setEnabled(on) {
    this.enabled = on;
    if (on && !this.layers.length) await this.load();
    this.layers.forEach((l, i) => { l.show = on && i === this.cur; });
    if (!on) bus.emit('radar', null);
  }
  async reload() {
    this.layers.forEach(l => this.viewer.imageryLayers.remove(l, true));
    this.layers = []; this.frames = []; this.cur = -1;
    if (this.enabled) await this.load();
  }
  async load() {
    try {
      const idx = await fetchJSON('https://api.rainviewer.com/public/weather-maps.json');
      this.host = idx.host; this.frames = [...(idx.radar?.past || []), ...(idx.radar?.nowcast || [])];
      this.layers = this.frames.map(f => {
        const prov = new C.UrlTemplateImageryProvider({
          url: `${this.host}${f.path}/256/{z}/{x}/{y}/2/1_1.png`, maximumLevel: 7, credit: 'RainViewer',
        });
        const l = this.viewer.imageryLayers.addImageryProvider(prov); l.alpha = 0.78; l.show = false; return l;
      });
    } catch (e) { console.warn('radar unavailable', e); this.frames = []; }
  }
  /** show the frame closest to `ms`; returns its time or null when the timeline is beyond the radar */
  setTime(ms) {
    if (!this.enabled || !this.frames.length) return null;
    let best = -1, bd = Infinity;
    this.frames.forEach((f, i) => { const d = Math.abs(f.time * 1000 - ms); if (d < bd) { bd = d; best = i; } });
    const inRange = bd < 12 * 60e3;
    this.layers.forEach((l, i) => { l.show = inRange && i === best; });
    this.cur = best;
    const t = inRange ? this.frames[best].time * 1000 : null;
    bus.emit('radar', t);
    return t;
  }
}
