// Archive: capacity-factor history of every turbine (annual frames 1977-2001, monthly frames 2002 -> latest) + national charts.
import { $, fetchJSON, fmt, clamp, bus } from './util.js';

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export class History {
  constructor(meta, buf, n) {
    this.meta = meta; this.n = n; this.u8 = new Uint8Array(buf);
    this.nA = meta.nAnnual; this.nM = meta.nMonthly; this.nF = this.nA + this.nM; this.y0 = meta.annualStart;
    this.m0y = +meta.monthStart.slice(0, 4); this.m0m = +meta.monthStart.slice(5, 7) - 1;
    this.years = Object.keys(meta.annual).map(Number).sort((a, b) => a - b);
    const mp = meta.monthly.on.map((v, i) => v + meta.monthly.off[i]);
    this.peak = mp.reduce((b, v, i) => (v > mp[b] ? i : b), 0);
    if (this.u8.length !== n * this.nF) throw new Error(`history.bin has ${this.u8.length} bytes, expected ${n * this.nF}`);
  }
  frame(f) { return this.u8.subarray(f * this.n, (f + 1) * this.n); }
  annual(f) { return f < this.nA; }
  monthIdx0(f) { return f - this.nA + this.m0m; }                                   // months since Jan of m0y
  year(f) { return f < this.nA ? this.y0 + f : this.m0y + Math.floor(this.monthIdx0(f) / 12); }
  month(f) { return f < this.nA ? 6 : this.monthIdx0(f) % 12; }
  frameMonthIdx(f) { return this.year(f) * 12 + this.month(f); }                     // same unit as turbines.json con / dec
  label(f) { return f < this.nA ? String(this.year(f)) : `${MON[this.month(f)]} ${this.year(f)}`; }
  frameFor(year, month = 6) { return year < this.m0y ? year - this.y0 : Math.min(this.nF - 1, this.nA + (year - this.m0y) * 12 + month - this.m0m); }
  production(f) {        // GWh (annual frames: whole year)
    if (f < this.nA) { const a = this.meta.annual[this.year(f)]; return a.on + a.off; }
    const k = f - this.nA; return this.meta.monthly.on[k] + this.meta.monthly.off[k];
  }
  split(f) { if (f < this.nA) { const a = this.meta.annual[this.year(f)]; return [a.on, a.off]; } const k = f - this.nA; return [this.meta.monthly.on[k], this.meta.monthly.off[k]]; }
  capacity(f) {          // MW registered then
    if (f < this.nA) { const a = this.meta.annual[this.year(f)]; return a.capOn + a.capOff; }
    const k = f - this.nA; return this.meta.monthly.capOn[k] + this.meta.monthly.capOff[k];
  }
  // the slider is piecewise: the 25 annual frames get the left 20 % of the track, the 297 monthly frames the rest
  frameToSlider(f) { return f < this.nA ? Math.round(f / this.nA * 195) : Math.round(200 + (f - this.nA) / (this.nM - 1) * 800); }
  sliderToFrame(v) { return v < 198 ? Math.min(this.nA - 1, Math.floor(v / 195 * this.nA)) : this.nA + Math.round(clamp((v - 200) / 800, 0, 1) * (this.nM - 1)); }
  hours(f) { if (f < this.nA) return 8766; const y = this.year(f), m = this.month(f); return new Date(Date.UTC(y, m + 1, 0)).getUTCDate() * 24; }
  cfSeries(i) { const out = new Float32Array(this.nF); for (let f = 0; f < this.nF; f++) out[f] = this.u8[f * this.n + i] / 250; return out; }
}

export async function loadHistory(n, onProgress) {
  const meta = await fetchJSON('data/history.json');
  const res = await fetch('data/history.bin'); if (!res.ok) throw new Error('history.bin missing');
  const total = +res.headers.get('content-length') || 0, reader = res.body.getReader(), chunks = []; let got = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); got += value.length; onProgress?.(total ? got / total : 0); }
  const buf = new Uint8Array(got); let o = 0; for (const c of chunks) { buf.set(c, o); o += c.length; }
  return new History(meta, buf.buffer, n);
}

// ── right-hand ARCHIVE panel ─────────────────────────────────────────────────────────────────────
const W = 300;
export class ArchivePanel {
  constructor(hist, seek) {
    this.h = hist; this.seek = seek; this.frame = 0;
    this.nY = hist.years.length; this.yMax = Math.max(...hist.years.map(y => hist.meta.annual[y].on + hist.meta.annual[y].off)) * 1.08;
    const mon = hist.meta.monthly; this.mMax = Math.max(...mon.on.map((v, i) => v + mon.off[i])) * 1.08;
    this.drawStatic(); this.bind();
  }

  drawStatic() {
    const h = this.h, ann = h.meta.annual, bw = W / this.nY, H = 104, base = H - 6;
    let bars = '', cap = '';
    const capMax = Math.max(...h.years.map(y => ann[y].capOn + ann[y].capOff)) * 1.1;
    h.years.forEach((y, k) => {
      const on = ann[y].on, off = ann[y].off, part = ann[y].months < 12;
      const hOn = on / this.yMax * (base - 8), hOff = off / this.yMax * (base - 8);
      bars += `<rect x="${(k * bw + 0.5).toFixed(1)}" y="${(base - hOn - hOff).toFixed(1)}" width="${(bw - 1).toFixed(1)}" height="${hOff.toFixed(1)}" fill="#4a8dff" opacity="${part ? 0.55 : 0.95}"/>` +
        `<rect x="${(k * bw + 0.5).toFixed(1)}" y="${(base - hOn).toFixed(1)}" width="${(bw - 1).toFixed(1)}" height="${hOn.toFixed(1)}" fill="#5ee1ff" opacity="${part ? 0.55 : 0.95}"/>`;
      cap += `${k ? 'L' : 'M'}${(k * bw + bw / 2).toFixed(1)},${(base - (ann[y].capOn + ann[y].capOff) / capMax * (base - 8)).toFixed(1)}`;
    });
    const gl = [5, 10, 15, 20].filter(v => v < this.yMax / 1000).map(v => { const y = base - v * 1000 / this.yMax * (base - 8); return `<line x1="0" x2="${W}" y1="${y}" y2="${y}" stroke="rgba(96,220,255,.12)" stroke-dasharray="2 3"/><text x="2" y="${y - 2}" fill="#6b8696" font-size="7">${v} TWh</text>`; }).join('');
    this.yBase = `${gl}${bars}<path d="${cap}" fill="none" stroke="#ffb23e" stroke-width="1.2" vector-effect="non-scaling-stroke" opacity=".9"/>`;
    // monthly stacked area
    const mon = h.meta.monthly, nM = h.nM, Hm = 78, bm = Hm - 4; let aOn = '', aAll = '';
    for (let k = 0; k < nM; k++) {
      const x = k / (nM - 1) * W, on = mon.on[k] / this.mMax * (bm - 6), tot = (mon.on[k] + mon.off[k]) / this.mMax * (bm - 6);
      aOn += `${k ? 'L' : 'M'}${x.toFixed(1)},${(bm - on).toFixed(1)}`; aAll += `${k ? 'L' : 'M'}${x.toFixed(1)},${(bm - tot).toFixed(1)}`;
    }
    const close = `L${W},${bm}L0,${bm}Z`;
    this.mBase = `<path d="${aAll}${close}" fill="rgba(74,141,255,.55)" stroke="#4a8dff" stroke-width="1" vector-effect="non-scaling-stroke"/><path d="${aOn}${close}" fill="rgba(94,225,255,.6)" stroke="#5ee1ff" stroke-width="1" vector-effect="non-scaling-stroke"/>`;
    const ticks = [1980, 1990, 2000, 2010, 2020].map(y => `<span style="left:${((y - h.years[0] + 0.5) / this.nY * 100).toFixed(1)}%">${y}</span>`).join('');
    $('#axis-y').innerHTML = ticks;
    $('#axis-m').innerHTML = [2005, 2010, 2015, 2020, 2025].map(y => `<span style="left:${(((y - h.m0y) * 12 - h.m0m) / (nM - 1) * 100).toFixed(1)}%">${y}</span>`).join('');
    this.update(this.frame);
  }

  update(f, live = null) {
    this.frame = f; const h = this.h, yr = h.year(f), annual = h.annual(f);
    // cursors
    const tY = (yr - h.years[0] + (annual ? 0.5 : (h.month(f) + 0.5) / 12)) / this.nY * W;
    $('#achart-y').innerHTML = `${this.yBase}<line x1="${tY}" x2="${tY}" y1="0" y2="104" stroke="#ffd23f" stroke-width="1.4" vector-effect="non-scaling-stroke"/>`;
    const tM = annual ? -10 : (f - h.nA) / (h.nM - 1) * W;
    $('#achart-m').innerHTML = `${this.mBase}<line x1="${tM}" x2="${tM}" y1="0" y2="78" stroke="#ffd23f" stroke-width="1.4" vector-effect="non-scaling-stroke"/>`;
    // KPIs
    const prod = h.production(f), cap = h.capacity(f), [on, off] = h.split(f);
    const cf = cap > 0 ? prod * 1000 / (cap * h.hours(f)) : 0;
    const per = annual ? `${h.label(f)} · full year` : `${h.label(f)} · month`;
    $('#akpi').innerHTML = `
      <div class="ak wide"><label>${per}</label><b>${annual ? `${(prod / 1000).toFixed(2)}<small> TWh</small>` : `${fmt(prod)}<small> GWh</small>`}</b></div>
      <div class="ak"><label>CAPACITY</label><b>${(cap / 1000).toFixed(2)}<small> GW</small></b></div>
      <div class="ak"><label>CAP. FACTOR</label><b>${(cf * 100).toFixed(0)}<small> %</small></b></div>
      <div class="ak"><label>OFFSHORE</label><b>${prod > 0 ? (off / prod * 100).toFixed(0) : 0}<small> %</small></b></div>
      <div class="ak wide mixrow"><div class="mix"><i style="width:${prod > 0 ? on / prod * 100 : 0}%;background:#5ee1ff"></i><i style="width:${prod > 0 ? off / prod * 100 : 0}%;background:#4a8dff"></i></div></div>
      ${live ? `<div class="ak wide dim">${fmt(live.n)} turbines on the map · ${(live.mw / 1000).toFixed(2)} GW</div>` : ''}
      <div class="ak wide dim">${annual ? 'annual resolution before 2002' : `record month: ${fmt(h.meta.monthly.on[h.peak] + h.meta.monthly.off[h.peak])} GWh (${MON[(h.peak + h.m0m) % 12]} ${h.m0y + Math.floor((h.peak + h.m0m) / 12)})`}</div>`;
  }

  bind() {
    const drag = (svg, fn) => {
      const move = e => { const r = svg.getBoundingClientRect(); fn(clamp((e.clientX - r.left) / r.width, 0, 0.9999)); };
      svg.addEventListener('pointerdown', e => { svg.setPointerCapture(e.pointerId); move(e); svg.onpointermove = move; });
      svg.addEventListener('pointerup', () => { svg.onpointermove = null; });
    };
    const h = this.h;
    drag($('#achart-y'), fx => { const t = fx * this.nY, y = h.years[0] + Math.floor(t), m = Math.floor((t % 1) * 12); this.seek(h.frameFor(y, m)); });
    drag($('#achart-m'), fx => this.seek(h.nA + Math.round(fx * (h.nM - 1))));
  }
}

/** sparkline of a turbine's capacity factor through the archive (for the selection card) */
export function sparkline(hist, i, cursor) {
  const cf = hist.cfSeries(i), nF = hist.nF, Wd = 306, Hd = 44; let d = '', max = 0.05;
  for (let f = 0; f < nF; f++) max = Math.max(max, cf[f]); max = Math.min(1, max * 1.1);
  const X = f => f / (nF - 1) * Wd;
  for (let f = 0; f < nF; f++) d += `${f ? 'L' : 'M'}${X(f).toFixed(1)},${(Hd - 2 - cf[f] / max * (Hd - 6)).toFixed(1)}`;
  const gx = X(hist.nA);
  return `<svg viewBox="0 0 ${Wd} ${Hd}" preserveAspectRatio="none"><line x1="${gx}" x2="${gx}" y1="0" y2="${Hd}" stroke="rgba(96,220,255,.3)" stroke-dasharray="2 3"/>
    <path d="${d}L${Wd},${Hd}L0,${Hd}Z" fill="rgba(94,225,255,.18)"/><path d="${d}" fill="none" stroke="#5ee1ff" stroke-width="1.1" vector-effect="non-scaling-stroke"/>
    ${cursor >= 0 ? `<line x1="${X(cursor)}" x2="${X(cursor)}" y1="0" y2="${Hd}" stroke="#ffd23f" stroke-width="1.3" vector-effect="non-scaling-stroke"/>` : ''}</svg>`;
}
