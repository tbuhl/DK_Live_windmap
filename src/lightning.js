// Live lightning: Blitzortung.org community network (free for private, non-commercial use) streamed over WebSocket.
// Only strikes inside the region of interest are kept; they flash on arrival and fade over 30 minutes.
import { bus, D2R, clamp } from './util.js';
const C = window.Cesium;

const SERVERS = ['wss://ws1.blitzortung.org:443/', 'wss://ws7.blitzortung.org:443/', 'wss://ws8.blitzortung.org:443/', 'wss://ws3.blitzortung.org:443/'];
const REGION = { s: 49, n: 63, w: -3, e: 24 };               // North Sea / Baltic / Scandinavia / N. Germany
const KEEP_MS = 30 * 60e3, MAX = 2500;

// Blitzortung frames are LZW-compressed JSON strings
function decode(b) {
  let a, e = {}, d = b.split(''), c = d[0], f = c, g = [c], h = 256, o = h;
  for (let i = 1; i < d.length; i++) {
    a = d[i].charCodeAt(0); a = h > a ? d[i] : e[a] ? e[a] : f + c;
    g.push(a); c = a.charAt(0); e[o] = f + c; o++; f = a;
  }
  return g.join('');
}

function boltSprite() {
  const s = 64, c = document.createElement('canvas'); c.width = c.height = s; const g = c.getContext('2d');
  const r = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.12, 'rgba(255,255,255,.95)'); r.addColorStop(0.35, 'rgba(255,255,255,.28)'); r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r; g.fillRect(0, 0, s, s);
  g.strokeStyle = 'rgba(255,255,255,.95)'; g.lineWidth = 2.2; g.lineCap = 'round';        // a little bolt glyph
  g.beginPath(); g.moveTo(36, 8); g.lineTo(26, 34); g.lineTo(34, 34); g.lineTo(27, 56); g.stroke();
  return c.toDataURL();
}

const AGE_COLORS = [[60e3, '#fff6b8'], [5 * 60e3, '#ffd23f'], [15 * 60e3, '#ff9d2e'], [KEEP_MS, '#ff4f5e']].map(([t, c]) => [t, C.Color.fromCssColorString(c)]);

export class Lightning {
  constructor(viewer) {
    this.viewer = viewer; this.enabled = false; this.ws = null; this.srv = 0; this.fail = 0; this.total = 0;
    this.strikes = []; this.state = 'off'; this.lastMsg = 0; this.parsed = 0;
    this.bbs = new C.BillboardCollection({ scene: viewer.scene }); this.bbs.show = false; viewer.scene.primitives.add(this.bbs);
    this.img = boltSprite(); this.free = []; this.lastSlow = 0;
    viewer.scene.preRender.addEventListener(() => this.tick());
  }

  setEnabled(on) {
    this.enabled = on; this.bbs.show = on;
    if (on) this.connect(); else { this.state = 'off'; try { this.ws?.close(); } catch {} this.ws = null; }
    bus.emit('lightning:state');
  }

  connect() {
    if (!this.enabled || this.ws) return;
    this.state = 'connecting'; bus.emit('lightning:state');
    let ws;
    try { ws = new WebSocket(SERVERS[this.srv % SERVERS.length]); } catch { return this.retry(); }
    this.ws = ws;
    ws.onopen = () => { this.state = 'live'; this.fail = 0; ws.send(JSON.stringify({ a: 111 })); bus.emit('lightning:state'); };
    ws.onmessage = ev => {
      this.lastMsg = Date.now();
      try { const s = JSON.parse(decode(String(ev.data))); this.parsed++; this.add(s.lat, s.lon, s.pol); } catch { /* ignore malformed frame */ }
    };
    ws.onclose = ws.onerror = () => { if (this.ws === ws) { this.ws = null; this.retry(); } };
  }
  retry() {
    if (!this.enabled) return;
    this.state = 'reconnecting'; this.srv++; this.fail++; bus.emit('lightning:state');
    setTimeout(() => this.connect(), Math.min(30000, 1500 * 2 ** Math.min(this.fail, 4)));
  }

  add(lat, lon, pol, ageMs = 0) {
    if (!(lat >= REGION.s && lat <= REGION.n && lon >= REGION.w && lon <= REGION.e)) return;
    const b = this.free.pop() || this.bbs.add({ image: this.img, disableDepthTestDistance: Infinity, scaleByDistance: new C.NearFarScalar(2e4, 1.4, 4e6, 0.8) });
    b.position = C.Cartesian3.fromDegrees(lon, lat, 2500); b.show = true;
    this.strikes.push({ t: Date.now() - ageMs, lat, lon, pol: pol || 0, b }); this.total++;
    if (this.strikes.length > MAX) this.drop(this.strikes.shift());
    bus.emit('lightning:strike');
  }
  drop(s) { s.b.show = false; this.free.push(s.b); }

  /** flash animation for fresh strikes every frame, colour fade for the rest once a second */
  tick() {
    if (!this.enabled || !this.strikes.length) return;
    const now = Date.now(), slow = now - this.lastSlow > 1000;
    if (slow) { this.lastSlow = now; while (this.strikes.length && now - this.strikes[0].t > KEEP_MS) this.drop(this.strikes.shift()); }
    for (let i = this.strikes.length - 1; i >= 0; i--) {
      const s = this.strikes[i], age = now - s.t;
      if (age > 2600 && !slow) break;                       // strikes are time-ordered: older ones only need the slow pass
      let col = AGE_COLORS[AGE_COLORS.length - 1][1], a = 0.5;
      for (let k = 0; k < AGE_COLORS.length; k++) if (age < AGE_COLORS[k][0]) { col = AGE_COLORS[k][1]; break; }
      let size;
      if (age < 500) { size = 70 - age * 0.06; a = 1; col = C.Color.WHITE; }
      else if (age < 2600) { const u = (age - 500) / 2100; size = 40 - 22 * u; a = 1 - 0.15 * u; }
      else { size = 30 - 12 * (age / KEEP_MS); a = clamp(1 - 0.65 * age / KEEP_MS, 0.35, 1); }
      s.b.width = s.b.height = size * (s.pol > 0 ? 1.25 : 1); s.b.color = col.withAlpha(a);
    }
  }

  stats() {
    const now = Date.now(); let last = 0, near = 0;
    for (const s of this.strikes) {
      last = Math.max(last, s.t);
      if (s.lat > 53.2 && s.lat < 59.2 && s.lon > 6 && s.lon < 16.5) near++;           // Denmark and its waters
    }
    return { state: this.state, n: this.strikes.length, near, lastAgo: last ? (now - last) / 1000 : null, total: this.total, parsed: this.parsed, silent: this.lastMsg ? (now - this.lastMsg) / 1000 : null };
  }

  /** strikes within `km` of a point during the last `minutes` */
  nearby(lon, lat, km = 25, minutes = 30) {
    const now = Date.now(), kx = 111.32 * Math.cos(lat * D2R); let n = 0;
    for (const s of this.strikes) if (now - s.t < minutes * 60e3 && Math.hypot((s.lon - lon) * kx, (s.lat - lat) * 111.32) <= km) n++;
    return n;
  }

  /** dev helper: drop some synthetic strikes around Denmark */
  simulate(n = 40) {
    for (let i = 0; i < n; i++) this.add(54.8 + Math.random() * 2.6, 7.5 + Math.random() * 6, Math.random() > 0.8 ? 1 : -1, Math.random() * 25 * 60e3);
    this.strikes.sort((a, b) => a.t - b.t);
  }
}
