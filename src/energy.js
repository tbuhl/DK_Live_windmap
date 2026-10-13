// Live Danish power system data from Energi Data Service (Energinet) + the right-hand panel renderer.
import { LINKS, GEN_COLORS } from './config.js';
import { $, fetchJSON, Queue, fmt, hhmm, bus, clamp } from './util.js';

const API = '/eds/';   // served by serve.py (Energinet blocks direct browser calls)
const AREAS = ['DK1', 'DK2', 'DE', 'NO2', 'SE3', 'SE4'];
const SLOT = 15 * 60e3;

export class Energy {
  constructor() {
    this.q = new Queue(1100);          // Energinet answers bursts with HTTP 429 → one request at a time
    this.ps = [];                      // PowerSystemRightNow, ascending
    this.prices = Object.fromEntries(AREAS.map(a => [a, []]));
    this.imb = {};
    this.off = 0;                      // timeline cursor as an offset from 'now' (ms), so NOW stays live
    this.status = { ps: 0, price: 0, imb: 0 };
    this.modelMW = null;
  }

  get latest() { return this.ps[this.ps.length - 1]; }
  get T() { return Date.now() + this.off; }

  /** Energinet answers rate-limited calls with a 429 that carries no CORS header, so the browser reports a plain
   *  network error. Treat any failure as 'back off and retry'. */
  async req(url, timeout = 20000) {
    let lastErr;
    for (let k = 0; k < 4; k++) {
      try { return await this.q.add(() => fetchJSON(url, { timeout })); }
      catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 8000 * (k + 1))); }
    }
    throw lastErr;
  }

  async start() {
    await Promise.allSettled([this.pollPS(true), this.pollPrices(), this.pollImb()]);
    setInterval(() => this.pollPS(false), 60e3);
    setInterval(() => this.pollPrices(), 10 * 60e3);
    setInterval(() => this.pollImb(), 3 * 60e3);
    setInterval(() => this.renderAge(), 1000);
    setInterval(() => { if (this.latest) { this.renderPrices(); this.renderChart(); this.renderLinks(); } }, 30e3);   // slot rollover while NOW is selected
  }

  async pollPS(first) {
    const lim = first ? 180 : 4;
    try {
      const j = await this.req(`${API}PowerSystemRightNow?limit=${lim}&sort=${encodeURIComponent('Minutes1UTC DESC')}`);
      const rows = j.records.map(r => ({ ...r, t: Date.parse(r.Minutes1UTC + 'Z') }));
      const known = new Set(this.ps.map(r => r.t));
      rows.forEach(r => { if (!known.has(r.t)) this.ps.push(r); });
      this.ps.sort((a, b) => a.t - b.t); if (this.ps.length > 400) this.ps.splice(0, this.ps.length - 400);
      this.status.ps = Date.now(); this.render(); bus.emit('energy');
    } catch (e) { console.warn('PowerSystemRightNow', e.message); this.renderAge(); }
  }

  async pollPrices() {
    const iso = ms => new Date(ms).toISOString().slice(0, 16);
    const now = Date.now();
    const url = `${API}DayAheadPrices?start=${iso(now - 4 * 3600e3)}&end=${iso(now + 44 * 3600e3)}&timezone=utc&sort=${encodeURIComponent('TimeUTC ASC')}&limit=3000` +
      `&filter=${encodeURIComponent(JSON.stringify({ PriceArea: AREAS }))}`;
    try {
      const j = await this.req(url, 30000);
      for (const a of AREAS) this.prices[a] = [];
      for (const r of j.records) this.prices[r.PriceArea]?.push({ t: Date.parse(r.TimeUTC + 'Z'), eur: r.DayAheadPriceEUR, dkk: r.DayAheadPriceDKK });
      for (const a of AREAS) this.prices[a].sort((x, y) => x.t - y.t);
      this.status.price = Date.now(); this.render(); bus.emit('energy');
    } catch (e) { console.warn('DayAheadPrices', e.message); }
  }

  async pollImb() {
    try {
      const url = `${API}ImbalancePrice?limit=8&sort=${encodeURIComponent('TimeUTC DESC')}&filter=${encodeURIComponent(JSON.stringify({ PriceArea: ['DK1', 'DK2'] }))}`;
      const j = await this.req(url);
      this.imb = {};
      for (const r of j.records) if (!this.imb[r.PriceArea]) this.imb[r.PriceArea] = { t: Date.parse(r.TimeUTC + 'Z'), eur: r.ImbalancePriceEUR, spot: r.SpotPriceEUR };
      this.status.imb = Date.now(); this.render();
    } catch (e) { console.warn('ImbalancePrice', e.message); }
  }

  // ── lookups ──
  priceAt(area, ms) {
    const arr = this.prices[area]; if (!arr?.length) return null;
    let lo = 0, hi = arr.length - 1, best = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m].t <= ms) { best = m; lo = m + 1; } else hi = m - 1; }
    if (best < 0 || ms - arr[best].t > 65 * 60e3) return null;
    return { ...arr[best], prev: arr[best - 1] || null };
  }
  setTime(ms) { const o = ms - Date.now(); this.off = Math.abs(o) < 2 * 60e3 ? 0 : o; if (this.latest) { this.renderPrices(); this.renderChart(); } }
  /** flow for a link in MW; negative = export */
  flow(link) { const v = this.latest?.[link.key]; return v == null ? null : v; }

  // ── rendering ──
  renderAge() {
    const dot = $('#feed-dot'), age = $('#feed-age'), s = this.status.ps;
    if (!s) { age.textContent = 'connecting…'; return; }
    const sec = Math.round((Date.now() - s) / 1000), dataAge = this.latest ? Math.round((Date.now() - this.latest.t) / 60e3) : 0;
    dot.className = 'dot ' + (sec < 150 && dataAge < 12 ? 'live' : 'stale');
    age.textContent = dataAge < 1 ? 'live · <1 min old' : `live · ${dataAge} min old`;
  }

  render() {
    if (!this.latest) return;
    this.renderPrices(); this.renderMix(); this.renderLinks(); this.renderKpis(); this.renderChart(); this.renderAge();
  }

  renderKpis() {
    const L = this.latest; if (!L) return;
    $('#k-actual').textContent = ((L.OnshoreWindPower + L.OffshoreWindPower) / 1000).toFixed(2) + ' GW';
    $('#k-co2').textContent = fmt(L.CO2Emission) + ' g/kWh';
  }

  renderPrices() {
    const at = this.T, live = Math.abs(at - Date.now()) < 8 * 60e3;
    const tile = (area, label, color) => {
      const p = this.priceAt(area, at), imb = this.imb[area];
      const eur = p ? p.eur : null, ore = p ? p.dkk / 10 : null;
      const prev = p?.prev, d = prev ? p.eur - prev.eur : null;
      const dh = d == null ? '' : `<span class="${d > 0 ? 'up' : 'dn'}">${d > 0 ? '▲' : '▼'} ${fmt(Math.abs(d), 1)}</span>`;
      return `<div class="ptile" style="--c:${color}"><label>${area} · ${label}</label>
        <b>${eur == null ? '–' : fmt(eur, Math.abs(eur) < 100 ? 1 : 0)}<small>€/MWh</small></b>
        <div class="sub"><span>${ore == null ? '–' : fmt(ore, 0)} øre/kWh</span>${dh}</div>
        <div class="sub"><span>${live ? (imb ? 'imbal. ' + fmt(imb.eur, 0) + ' €' : '') : 'forecast'}</span><span>${p ? hhmm(p.t) : ''}</span></div></div>`;
    };
    $('#prices').innerHTML = tile('DK1', 'WEST', 'var(--cyan)') + tile('DK2', 'EAST', 'var(--amber)');
  }

  renderChart() {
    const svg = $('#pchart'), W = 300, H = 92, now = Date.now();
    const t0 = now - 3 * 3600e3, t1 = now + 27 * 3600e3;
    const pts = a => this.prices[a].filter(p => p.t + SLOT >= t0 && p.t <= t1);
    const d1 = pts('DK1'), d2 = pts('DK2'); if (!d1.length) { svg.innerHTML = ''; return; }
    const all = [...d1, ...d2].map(p => p.eur);
    const lo = Math.min(0, ...all), hi = Math.max(50, ...all) * 1.08, X = t => (t - t0) / (t1 - t0) * W, Y = v => H - 6 - (v - lo) / (hi - lo) * (H - 14);
    const line = arr => { let d = ''; arr.forEach((p, i) => { const x = X(Math.max(p.t, t0)), x2 = X(Math.min(p.t + SLOT, t1)); d += `${i ? 'L' : 'M'}${x.toFixed(1)},${Y(p.eur).toFixed(1)}L${x2.toFixed(1)},${Y(p.eur).toFixed(1)}`; }); return d; };
    const area = arr => line(arr) + `L${X(Math.min(arr[arr.length - 1].t + SLOT, t1)).toFixed(1)},${Y(Math.max(lo, 0))}L${X(Math.max(arr[0].t, t0)).toFixed(1)},${Y(Math.max(lo, 0))}Z`;
    const grid = [0, 50, 100, 150, 200, 300].filter(v => v >= lo && v < hi).map(v => `<line x1="0" x2="${W}" y1="${Y(v)}" y2="${Y(v)}" stroke="rgba(96,220,255,.12)" stroke-dasharray="2 3"/><text x="2" y="${Y(v) - 2}" fill="#6b8696" font-size="7">${v}</text>`).join('');
    const mark = (t, c, dash) => `<line x1="${X(t)}" x2="${X(t)}" y1="0" y2="${H}" stroke="${c}" stroke-width="1" ${dash ? 'stroke-dasharray="3 2"' : ''}/>`;
    svg.innerHTML = `<defs><linearGradient id="ga" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#5ee1ff" stop-opacity=".30"/><stop offset="1" stop-color="#5ee1ff" stop-opacity="0"/></linearGradient></defs>
      ${grid}<path d="${area(d1)}" fill="url(#ga)"/><path d="${line(d2)}" fill="none" stroke="#ffb23e" stroke-width="1.3" vector-effect="non-scaling-stroke"/>
      <path d="${line(d1)}" fill="none" stroke="#5ee1ff" stroke-width="1.6" vector-effect="non-scaling-stroke"/>
      ${mark(now, '#5ee1ff', true)}${Math.abs(this.T - now) > 8 * 60e3 ? mark(this.T, '#ffd23f', false) : ''}`;
    const ax = $('#paxis'); const hrs = [];
    for (let h = Math.ceil(t0 / 3600e3 / 6) * 6; h * 3600e3 < t1; h += 6) hrs.push(h * 3600e3);
    ax.innerHTML = hrs.map(t => `<span style="left:${((t - t0) / (t1 - t0) * 100).toFixed(1)}%">${hhmm(t)}</span>`).join('');
  }

  renderMix() {
    const L = this.latest;
    const parts = [
      ['offshore', 'Offshore wind', L.OffshoreWindPower], ['onshore', 'Onshore wind', L.OnshoreWindPower], ['solar', 'Solar', L.SolarPower],
      ['central', 'Central', L.ProductionGe100MW], ['local', 'Local CHP', L.ProductionLt100MW],
    ].map(([k, n, v]) => [k, n, Math.max(0, v || 0)]);
    const total = parts.reduce((s, p) => s + p[2], 0) || 1;
    const sum = L.Exchange_Sum, load = total + sum;
    $('#net').innerHTML = `<b>${fmt(Math.abs(sum))}</b><small>MW net</small><span class="tag ${sum < 0 ? 'exp' : 'imp'}">${sum < 0 ? 'EXPORTING' : 'IMPORTING'}</span>`;
    $('#mix').innerHTML = parts.map(([k, , v]) => `<i style="width:${v / total * 100}%;background:${GEN_COLORS[k]}"></i>`).join('');
    $('#mixlegend').innerHTML = parts.map(([k, n, v]) => `<div><i style="background:${GEN_COLORS[k]}"></i>${n}<span>${fmt(v)}</span></div>`).join('') +
      `<div class="tot">Production ${fmt(total)} MW · demand ≈ ${fmt(load)} MW · wind ${(100 * (parts[0][2] + parts[1][2]) / total).toFixed(0)}% of generation</div>`;
  }

  renderLinks() {
    const L = this.latest, at = Date.now();
    $('#linktable').innerHTML = LINKS.map(lk => {
      const v = L[lk.key] ?? 0, pct = clamp(Math.abs(v) / lk.cap, 0, 1) * 50;
      const exp = v < 0, col = exp ? 'var(--amber)' : 'var(--cyan)';
      const bar = exp ? `left:50%;width:${pct}%` : `right:50%;width:${pct}%`;
      const pa = this.priceAt(lk.areaDK, at), pf = lk.areaFar ? this.priceAt(lk.areaFar, at) : null;
      const sp = pa && pf ? pf.eur - pa.eur : null;
      return `<div class="lk" data-id="${lk.id}"><div class="nm">${lk.name}<small>${lk.areaDK} ↔ ${lk.far}</small></div>
        <div class="bar"><i style="${bar};background:${col};box-shadow:0 0 8px ${col}"></i></div>
        <div class="v">${fmt(Math.abs(v))}<small>${sp == null ? (lk.areaFar ? '' : 'no price') : 'Δ' + (sp >= 0 ? '+' : '') + fmt(sp, 0) + '€'}</small></div></div>`;
    }).join('');
  }
}
