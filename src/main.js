import { PRESETS, CITIES, TOUR } from './config.js';
import { $, $$, bus, fmt, hhmm, pad, clamp, RAMPS, rampGradient, store } from './util.js';
import { createViewer, setBasemap, flyToView, setView, cameraState, centerGround, startOrbit } from './globe.js';
import { WeatherField, Overlay, Radar, fieldMeta } from './weather.js';
import { WindFlow } from './windflow.js';
import { Turbines, loadTurbineData } from './turbines.js';
import { Energy } from './energy.js';
import { Links } from './links.js';
import { createLooks } from './looks.js';
import { Lightning } from './lightning.js';
import { WakeAnalysis } from './wake.js';
import { Perf } from './perf.js';
import { loadHistory, ArchivePanel, sparkline } from './archive.js';
const C = window.Cesium;

// ── boot log ──────────────────────────────────────────────────────────────────────
const bootlog = $('#bootlog');
function step(text) {
  const row = document.createElement('div'); row.className = 'wait'; row.textContent = text; bootlog.appendChild(row);
  return (ok = true, extra = '') => { row.className = ok ? 'ok' : 'err'; if (extra) row.textContent = `${text} ${extra}`; };
}

// ── URL hash (shareable view) ───────────────────────────────────────────────────────
function readHash() {
  const o = {}; for (const kv of location.hash.slice(1).split('&')) { const [k, v] = kv.split('='); if (k) o[k] = decodeURIComponent(v || ''); } return o;
}
function writeHash(viewer, state) {
  const c = cameraState(viewer);
  const h = `v=${c.lon.toFixed(4)},${c.lat.toFixed(4)},${Math.round(c.h)},${c.heading.toFixed(0)},${c.pitch.toFixed(0)}&look=${state.look}&base=${state.base}`;
  history.replaceState(null, '', '#' + h);
}
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = idx => (idx == null ? '–' : `${MON[idx % 12]} ${Math.floor(idx / 12)}`);

async function main() {
  const hash = readHash();
  const S = { T: 0, playing: false, mode: 'live', frame: 0, look: hash.look || 'eo', base: hash.base || 'sat', tour: false, stopOrbit: null };

  const doneV = step('INITIALISING 3D GLOBE');
  const viewer = createViewer('globe');
  const scene = viewer.scene;
  setBasemap(viewer, S.base);
  const setLook = createLooks(viewer);
  setView(viewer, { lon: 10, lat: 38, h: 2.6e7, pitch: -90 });
  doneV();

  const wx = new WeatherField(), energy = new Energy();
  const doneT = step('LOADING TURBINE REGISTER (ENS)');
  const doneW = step('FETCHING WIND FIELD (OPEN-METEO)');
  // The wind field comes from a free third-party API that can be slow: never hold the boot screen hostage for it.
  const wxP = wx.load().then(s => { doneW(true, `[${s}]`); return s; }, e => { doneW(false, '(retrying in background)'); console.warn('wind field:', e.message); return 'none'; });
  const td = await loadTurbineData().then(d => { doneT(true, `${fmt(d.n)} placed`); return d; }, e => { doneT(false); throw e; });
  await Promise.race([wxP, new Promise(r => setTimeout(r, 5000))]);

  wx.loadForecast().then(() => setT(S.T), e => console.warn('forecast unavailable', e.message));   // background; timeline wakes up when it lands
  const turbines = new Turbines(viewer, td, wx);
  const flow = new WindFlow($('#wind'), viewer, wx);
  const cloud = new Overlay(viewer, wx, 'cloud'), heat = new Overlay(viewer, wx, 'temp');
  const radar = new Radar(viewer);
  const links = new Links(viewer, energy);
  const lightning = new Lightning(viewer);
  const wake = new WakeAnalysis(viewer, turbines);
  const perf = new Perf(viewer, { flow, turbines });
  const doneE = step('TAPPING GRID TELEMETRY (ENERGINET)');
  energy.start().then(() => doneE(true), () => doneE(false));
  let hist = null, archivePanel = null;
  window.__dk = { viewer, turbines, wx, energy, links, flow, radar, cloud, heat, lightning, wake, perf, S, setT: h => setT(h), setFrame: f => setFrame(f), setMode: m => setMode(m), get hist() { return hist; } };

  // collapsible panel sections (state remembered)
  const collapsed = store('dkw.collapsed') || {};
  $$('.panel section').forEach((sec, k) => {
    const key = sec.querySelector('h3')?.textContent.trim().slice(0, 12) || k;
    if (collapsed[key]) sec.classList.add('collapsed');
    sec.querySelector('h3')?.addEventListener('click', () => { sec.classList.toggle('collapsed'); collapsed[key] = sec.classList.contains('collapsed'); store('dkw.collapsed', collapsed); });
  });

  // ── static bits ──
  let liveN = 0, liveGW = 0;
  for (let i = 0; i < td.n; i++) if (td.dec[i] == null) { liveN++; liveGW += td.cap[i] / 1e6; }
  $('#k-count').textContent = fmt(liveN);
  $('#k-cap').textContent = liveGW.toFixed(2) + ' GW';
  bus.on('turbines:model', mw => { $('#k-model').textContent = (mw / 1000).toFixed(2) + ' GW'; });
  if (wx.ready) $('#k-model').textContent = (turbines.modelMW / 1000).toFixed(2) + ' GW';
  bus.on('energy', () => links.update());

  // ── clocks / telemetry ──
  setInterval(() => {
    const d = new Date();
    $('#clk-utc').textContent = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
    $('#clk-dk').textContent = d.toLocaleTimeString('en-GB', { timeZone: 'Europe/Copenhagen', hour: '2-digit', minute: '2-digit' });
  }, 500);
  let lastFrame = performance.now(), lastTel = performance.now(), cursor = null;
  scene.postRender.addEventListener(() => {
    const now = performance.now();
    flow.frame(now - lastFrame); lastFrame = now;
    if (now - lastTel > 500) {
      lastTel = now;
      const c = cameraState(viewer), g = cursor || centerGround(viewer);
      $('#t-pos').textContent = `${Math.abs(g.lat).toFixed(4)}°${g.lat >= 0 ? 'N' : 'S'} ${Math.abs(g.lon).toFixed(4)}°${g.lon >= 0 ? 'E' : 'W'}`;
      $('#t-alt').textContent = c.h > 20000 ? `ALT ${fmt(c.h / 1000)} km` : `ALT ${fmt(c.h)} m`;
    }
  });

  // ── LIVE timeline (−3 h … +24 h) ──
  const tl = $('#time');
  const liveTicks = () => { $('#ticks').innerHTML = [-3, 0, 3, 6, 9, 12, 15, 18, 21, 24].map(h => `<span class="${h === 0 ? 'nowtick' : ''}" style="left:${(h + 3) / 27 * 100}%">${h === 0 ? 'NOW' : (h > 0 ? '+' : '') + h + 'h'}</span>`).join(''); };
  liveTicks();
  let pendingOverlay = 0;
  function setT(h, fromSlider = false) {
    if (Math.abs(h) < 0.12) h = 0;
    S.T = h;
    const ms = Date.now() + h * 3600e3;
    wx.setTime(ms, true); radar.setTime(ms); energy.setTime(ms); links.updateAreas();
    if (S.mode === 'archive') return;
    if (!fromSlider) tl.value = h;
    clearTimeout(pendingOverlay); pendingOverlay = setTimeout(() => { cloud.redraw(); heat.redraw(); }, 90);
    const d = new Date(ms), day = d.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'Europe/Copenhagen' });
    $('#t-label').textContent = h === 0 ? 'NOW' : `${day} ${d.toLocaleTimeString('en-GB', { timeZone: 'Europe/Copenhagen', hour: '2-digit', minute: '2-digit' })}`;
    $('#t-sub').textContent = h === 0 ? 'live' : !wx.frames.length ? 'forecast loading…' : `${h > 0 ? '+' : '−'}${Math.abs(h).toFixed(1)} h ${h > 0 ? 'forecast' : 'ago'}`;
    $('#k-model').previousElementSibling.textContent = h === 0 ? 'WIND NOW (MODEL)' : 'WIND @ TIME (MODEL)';
    if ($('#l-daynight').checked) viewer.clock.currentTime = C.JulianDate.fromDate(new Date(ms));
  }
  tl.addEventListener('input', () => S.mode === 'archive' ? setFrame(hist.sliderToFrame(+tl.value), true) : setT(parseFloat(tl.value), true));
  $('#now').onclick = () => { S.playing = false; $('#play').textContent = '▶'; if (S.mode === 'archive') setFrame(hist ? hist.nF - 1 : 0); else setT(0); };
  $('#play').onclick = () => {
    S.playing = !S.playing; $('#play').textContent = S.playing ? '❚❚' : '▶';
    if (S.playing && S.mode === 'live' && S.T >= 23.5) setT(-2.5);
    if (S.playing && S.mode === 'archive' && hist && S.frame >= hist.nF - 2) setFrame(0);
  };
  let lastPlay = performance.now(), lastApply = 0, acc = 0;
  scene.preRender.addEventListener(() => {
    const now = performance.now(), dt = (now - lastPlay) / 1000;
    if (!S.playing || now - lastApply < 90) { if (!S.playing) { lastPlay = now; acc = 0; } return; }
    lastPlay = now; lastApply = now;
    if (S.mode === 'archive') {
      if (!hist) return;
      acc += dt * (hist.annual(S.frame) ? 3 : 9);
      const steps = Math.floor(acc); if (!steps) return; acc -= steps;
      const f = Math.min(hist.nF - 1, S.frame + steps); setFrame(f);
      if (f >= hist.nF - 1) { S.playing = false; $('#play').textContent = '▶'; }
    } else { let h = S.T + dt * 1.4; if (h > 24) h = -2.5; setT(h); }
  });
  bus.on('radar', t => { $('#radarlabel').textContent = !radar.enabled || S.mode === 'archive' ? '' : t ? `RADAR ${hhmm(t, true)} UTC` : 'NO RADAR AT THIS TIME'; });

  // ── ARCHIVE mode ──
  function archiveTicks() {
    const years = [1980, 1990, 2000, 2005, 2010, 2015, 2020, 2025], pos = y => hist.frameToSlider(hist.frameFor(y, 0)) / 10;
    $('#ticks').innerHTML = years.map(y => `<span class="${y === 2005 ? 'nowtick' : ''}" style="left:${pos(y)}%">${y}</span>`).join('');
  }
  function setFrame(f, fromSlider = false) {
    if (!hist) return;
    f = clamp(Math.round(f), 0, hist.nF - 1); S.frame = f;
    if (!fromSlider) tl.value = hist.frameToSlider(f);
    turbines.applyArchive(f);
    $('#t-label').textContent = hist.label(f);
    $('#t-sub').textContent = hist.annual(f) ? 'annual' : `monthly · ${fmt(hist.production(f))} GWh`;
    cardDirty = true;
  }
  async function setMode(m) {
    if (m === S.mode) return;
    if (m === 'archive') {
      $('#t-sub').textContent = 'loading archive…';
      try {
        if (!hist) { hist = await loadHistory(td.n, p => { $('#t-sub').textContent = `loading archive… ${Math.round(p * 100)}%`; }); archivePanel = new ArchivePanel(hist, f => setFrame(f)); }
      } catch (e) { console.error(e); $('#t-sub').textContent = 'archive unavailable'; return; }
      S.mode = 'archive'; S.playing = false; $('#play').textContent = '▶';
      document.body.classList.add('archive'); $('#right').classList.add('archive'); $('#archive').hidden = false;
      flow.setEnabled(false); links.setEnabled(false); radar.setEnabled(false); cloud.setEnabled(false); heat.setEnabled(false); lightning.bbs.show = false;
      tl.min = 0; tl.max = 1000; tl.step = 1; archiveTicks();
      $('#now').textContent = 'LATEST';
      turbines.setArchive(hist); bus.emit('archive:mode', true);
      setFrame(S.frame || hist.nF - 1);
    } else {
      S.mode = 'live'; S.playing = false; $('#play').textContent = '▶';
      document.body.classList.remove('archive'); $('#right').classList.remove('archive'); $('#archive').hidden = true;
      flow.setEnabled($('#l-flow').checked); links.setEnabled($('#l-links').checked); cloud.setEnabled($('#l-cloud').checked);
      if ($('#l-heat').value) heat.setEnabled(true); lightning.bbs.show = lightning.enabled;
      radar.setEnabled($('#l-radar').checked);
      tl.min = -3; tl.max = 24; tl.step = 0.25; liveTicks(); $('#now').textContent = 'NOW';
      turbines.setArchive(null); bus.emit('archive:mode', false);
      setT(S.T);
    }
    $$('#mode button').forEach(b => b.classList.toggle('on', b.dataset.v === S.mode));
  }
  $$('#mode button').forEach(b => b.onclick = () => setMode(b.dataset.v));
  bus.on('archive:frame', live => archivePanel?.update(S.frame, live));

  // ── layer toggles ──
  const on = (id, fn) => { const el = $(id); el.addEventListener('change', () => fn(el.checked)); return el; };
  on('#l-turbines', v => turbines.setEnabled(v));
  on('#l-links', v => { if (S.mode === 'live') links.setEnabled(v); });
  on('#l-flow', v => { if (S.mode === 'live') flow.setEnabled(v); });
  on('#l-names', v => turbines.setLabels(v));
  on('#l-radar', async v => { if (S.mode !== 'live') return; await radar.setEnabled(v); radar.setTime(Date.now() + S.T * 3600e3); });
  on('#l-cloud', v => { if (S.mode === 'live') cloud.setEnabled(v); });
  on('#l-wake', v => wake.setEnabled(v));
  on('#l-light', v => { lightning.setEnabled(v); if (S.mode === 'archive') lightning.bbs.show = false; });
  on('#l-daynight', v => { scene.globe.enableLighting = v; if (v) viewer.clock.currentTime = C.JulianDate.fromDate(new Date(Date.now() + S.T * 3600e3)); });
  const legend = $('#legend');
  $('#l-heat').addEventListener('change', e => {
    const k = e.target.value;
    if (!k) { heat.setEnabled(false); legend.hidden = true; return; }
    const m = fieldMeta[k]; heat.setKind(k); heat.setEnabled(S.mode === 'live');
    legend.hidden = false; legend.querySelector('i').style.background = rampGradient(m.ramp);
    legend.querySelector('.lo').textContent = `${m.lo} ${m.unit}`; legend.querySelector('.hi').textContent = `${m.hi} ${m.unit}`;
  });
  // lightning readout
  const lstat = $('#lstat');
  const paintLightning = () => {
    const s = lightning.stats();
    if (s.state === 'off') { lstat.textContent = ''; lstat.className = 'stat'; return; }
    if (s.state !== 'live') { lstat.textContent = s.state + '…'; lstat.className = 'stat'; return; }
    lstat.className = 'stat' + (s.near ? ' hot' : '');
    lstat.textContent = s.near ? `⚡ ${s.near} near DK · ${s.lastAgo < 90 ? Math.round(s.lastAgo) + ' s' : Math.round(s.lastAgo / 60) + ' min'} ago` : s.n ? `${s.n} in region · none near DK` : 'live · quiet';
  };
  bus.on('lightning:state', paintLightning); bus.on('lightning:strike', paintLightning); setInterval(paintLightning, 5000);
  // keep weather in sync with the live feeds
  setInterval(async () => { try { await wx.load(); setT(S.T); } catch {} }, 30 * 60e3);
  setInterval(async () => { if (radar.enabled) { await radar.reload(); radar.setTime(Date.now() + S.T * 3600e3); } }, 10 * 60e3);
  setInterval(async () => { try { await wx.loadForecast(); setT(S.T); } catch {} }, 3 * 3600e3 + 60e3);

  // ── turbine controls ──
  const tlg = $('#tlegend');
  const legends = { live: [RAMPS.output, 'idle', 'rated'], cap: [t => RAMPS.size(t), '20 kW', '15 MW'], age: [t => RAMPS.age(t), '1978', '2026'] };
  function paintLegend(m) { const [fn, lo, hi] = legends[m]; tlg.querySelector('i').style.background = rampGradient(fn); tlg.querySelector('.lo').textContent = lo; tlg.querySelector('.hi').textContent = hi; }
  paintLegend('live');
  $$('#color-mode button').forEach(b => b.onclick = () => { $$('#color-mode button').forEach(x => x.classList.toggle('on', x === b)); turbines.setMode(b.dataset.v); paintLegend(b.dataset.v); });
  $$('#siting button').forEach(b => b.onclick = () => { b.classList.toggle('on'); turbines.setFilter({ showOn: $('#siting [data-v=on]').classList.contains('on'), showOff: $('#siting [data-v=off]').classList.contains('on') }); });
  const yr = $('#year');
  bus.on('turbines:filter', ({ shown, mw }) => { $('#year-hint').textContent = `${fmt(shown)} turbines · ${(mw / 1000).toFixed(2)} GW shown`; });
  yr.addEventListener('input', () => { $('#year-v').textContent = yr.value; turbines.setFilter({ yearMax: +yr.value }); });
  let yp = null;
  $('#year-play').onclick = () => {
    if (yp) { clearInterval(yp); yp = null; $('#year-play').textContent = '▶'; return; }
    $('#year-play').textContent = '❚❚'; yr.value = 1978;
    yp = setInterval(() => { yr.value = +yr.value + 1; yr.dispatchEvent(new Event('input')); if (+yr.value >= 2026) { clearInterval(yp); yp = null; $('#year-play').textContent = '▶'; } }, 260);
  };

  // ── look + basemap ──
  const activate = (sel, v) => $$(sel + ' button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  $$('#looks button').forEach(b => b.onclick = () => { S.look = b.dataset.v; setLook(S.look); activate('#looks', S.look); });
  $$('#basemap button').forEach(b => b.onclick = () => { S.base = b.dataset.v; setBasemap(viewer, S.base); activate('#basemap', S.base); });
  setLook(S.look); activate('#looks', S.look); activate('#basemap', S.base);

  // ── navigation ──
  const stopAll = () => { S.stopOrbit?.(); S.stopOrbit = null; $('#orbit').classList.remove('on'); S.tour = false; $('#tour').classList.remove('on'); $('#tour').textContent = '▶ TOUR'; };
  const fly = (p, dur) => { stopAll(); return flyToView(viewer, p, dur); };
  const goHome = () => { turbines.select(-1); fly(PRESETS[0], 3); };
  $('#home').onclick = goHome;
  const presets = $('#presets');
  PRESETS.forEach(p => { const b = document.createElement('button'); b.className = 'chip'; b.textContent = p.n; b.onclick = () => fly(p, 3); presets.appendChild(b); });
  const places = $('#places');
  const nameIdx = new Map();
  for (const c of turbines.named) nameIdx.set(c.name.toLowerCase(), { lon: c.lon, lat: c.lat, h: 5000 + Math.sqrt(c.n) * 900, pitch: -38, label: c.name });
  for (const p of PRESETS) nameIdx.set(p.n.toLowerCase(), p);
  for (const [n, lon, lat] of CITIES) nameIdx.set(n.toLowerCase(), { lon, lat, h: 30000, pitch: -45 });
  places.innerHTML = [...nameIdx.keys()].sort().map(n => `<option value="${n.replace(/\b\w/g, c => c.toUpperCase())}">`).join('');
  $('#search').addEventListener('change', e => {
    const q = e.target.value.trim().toLowerCase(); if (!q) return;
    let hit = nameIdx.get(q) || [...nameIdx.entries()].find(([k]) => k.includes(q))?.[1];
    if (hit) { fly(hit, 3); e.target.blur(); } else e.target.style.borderColor = 'var(--mag)';
  });
  $('#search').addEventListener('input', e => { e.target.style.borderColor = ''; });

  $('#orbit').onclick = () => {
    if (S.stopOrbit) { stopAll(); return; }
    stopAll();
    const sel = turbines.selected, cam = cameraState(viewer);
    let lon, lat, range;
    if (sel >= 0) { lon = td.lon[sel]; lat = td.lat[sel]; range = Math.max(350, td.rotor[sel] * 3.2); }
    else { const g = centerGround(viewer); lon = g.lon; lat = g.lat; range = clamp(cam.h * 1.25, 1500, 4e6); }
    S.stopOrbit = startOrbit(viewer, lon, lat, range, sel >= 0 ? -16 : -38, sel >= 0 ? 0.22 : 0.1); $('#orbit').classList.add('on');
  };
  $('#tour').onclick = async () => {
    if (S.tour) { stopAll(); return; }
    stopAll(); S.tour = true; $('#tour').classList.add('on'); $('#tour').textContent = '■ STOP';
    for (const name of TOUR) {
      if (!S.tour) return;
      const p = PRESETS.find(x => x.n === name);
      await flyToView(viewer, p, name === 'DENMARK' ? 5 : 6);
      if (!S.tour) return;
      S.stopOrbit = startOrbit(viewer, p.lon, p.lat, p.h / Math.sin(Math.abs(p.pitch) * Math.PI / 180), p.pitch, 0.16);
      await new Promise(r => setTimeout(r, name === 'DENMARK' ? 2500 : 6000));
      S.stopOrbit?.(); S.stopOrbit = null;
    }
    stopAll();
  };
  scene.canvas.addEventListener('pointerdown', () => { if (S.stopOrbit && !S.tour) stopAll(); });

  // interconnector rows → fly to the link
  $('#linktable').addEventListener('click', e => {
    const row = e.target.closest('.lk'); if (!row) return;
    const lk = links.focus(row.dataset.id); if (!lk) return;
    const lon = (lk.a[0] + lk.b[0]) / 2, lat = (lk.a[1] + lk.b[1]) / 2;
    const km = Math.hypot((lk.a[0] - lk.b[0]) * 62, (lk.a[1] - lk.b[1]) * 111);
    fly({ lon, lat, h: Math.max(60000, km * 1500), pitch: -55 }, 3);
  });

  // ── selection card + hover tooltip ──
  const card = $('#card'), tip = $('#tip');
  let cardDirty = false;
  const compass = d => ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round(d / 22.5) % 16];
  function renderCard() {
    cardDirty = false;
    const i = turbines.selected; if (i < 0) { card.hidden = true; return; }
    const t = turbines.describe(i), arch = S.mode === 'archive' && hist;
    const R = t.rotor / 2, ws = t.wake ? t.wsEff : t.ws, frac = t.wake ? t.fracEff : t.frac;
    const rpm = frac > 0 ? Math.min(1.7, 7.2 * ws / R) * 60 / (2 * Math.PI) : 0.6;
    const mw = t.capKW / 1000 * frac * 0.93;
    const title = t.type !== '–' ? t.type : t.make !== 'Unknown' ? t.make : 'Wind turbine';
    const tags = (t.live ? '' : `<span class="tag amber">DECOMMISSIONED ${monthLabel(t.dec)}</span>`) + (t.capEst ? '<span class="tag">CAP. EST.</span>' : '') + (t.geoEst ? '<span class="tag">DIMS EST.</span>' : '');
    let body;
    if (arch) {
      const cf = hist.frame(S.frame)[i] / 250, exists = (t.con == null || t.con <= hist.frameMonthIdx(S.frame)) && (t.dec == null || t.dec > hist.frameMonthIdx(S.frame));
      body = `<div class="out"><i style="width:${(clamp(cf / 0.62, 0, 1) * 100).toFixed(0)}%"></i></div>
        <div class="outl"><span>${exists ? `capacity factor in ${hist.label(S.frame)}: ${(cf * 100).toFixed(0)}%` : `not in operation in ${hist.label(S.frame)}`}</span><span></span></div>
        <div class="spark"><div class="sl"><span>1977</span><span>capacity factor history</span><span>${hist.label(hist.nF - 1)}</span></div>${sparkline(hist, i, S.frame)}</div>`;
    } else {
      const n25 = lightning.enabled ? lightning.nearby(t.lon, t.lat, 25, 30) : null;
      body = `<div class="out"><i style="width:${(frac * 100).toFixed(0)}%"></i></div>
        <div class="outl"><span>est. output ${mw.toFixed(2)} MW${t.wake ? ' · wake-adjusted' : ''}</span><span>${(frac * 100).toFixed(0)}% of rated</span></div>
        ${t.wake ? `<div class="outl" style="margin-top:3px"><span>free-stream ${t.ws.toFixed(1)} → ${t.wsEff.toFixed(1)} m/s in the wake</span><span>${t.ws > 0 ? (-(1 - t.wsEff / t.ws) * 100).toFixed(0) : 0}%</span></div>` : ''}
        ${n25 != null ? `<div class="outl" style="margin-top:3px"><span>⚡ strikes within 25 km (30 min)</span><span style="color:${n25 ? 'var(--amber)' : 'var(--dim)'}">${n25}</span></div>` : ''}`;
    }
    card.hidden = false;
    card.innerHTML = `<button class="x" title="close">×</button>
      <h4>${title}${tags}</h4>
      <div class="sub">${t.farm ? t.farm + ' · ' : ''}${t.offshore ? 'OFFSHORE' : 'ONSHORE'}${t.make !== 'Unknown' && t.type !== '–' ? ' · ' + t.make : ''}${t.muni && !t.offshore ? ' · ' + t.muni : ''}</div>
      <div class="grid">
        <div><label>RATED${t.capEst ? ' (EST.)' : ''}</label><b>${t.capKW >= 1000 ? fmt(t.capKW / 1000, 2) + ' MW' : fmt(t.capKW, t.capKW < 100 ? 1 : 0) + ' kW'}</b></div>
        <div><label>HUB / ROTOR</label><b>${fmt(t.hub)} / ${fmt(t.rotor)} m</b></div>
        <div><label>CONNECTED</label><b>${monthLabel(t.con)}</b></div>
        <div><label>${arch ? 'GSRN' : 'WIND @ HUB'}</label><b>${arch ? String(t.gsrn).slice(-8) : ws.toFixed(1) + ' m/s'}</b></div>
        <div><label>${arch ? 'COORDS' : 'FROM'}</label><b>${arch ? (t.xy === 'osm' ? 'OSM' : 'ENS') : compass(t.dir) + ' ' + Math.round(t.dir) + '°'}</b></div>
        <div><label>${arch ? 'FARM' : 'ROTOR'}</label><b>${arch ? (t.farmStats ? t.farmStats.n + ' WTG' : '–') : rpm.toFixed(1) + ' rpm'}</b></div>
      </div>
      ${body}
      ${t.farmStats && !arch ? `<div class="outl" style="margin-top:3px"><span>farm: ${t.farmStats.n} turbines · ${t.farmStats.mw.toFixed(1)} MW</span><span></span></div>` : ''}
      <div class="acts"><button class="btn" data-a="fly">FLY TO</button><button class="btn" data-a="orbit">ORBIT</button>${t.farmStats ? '<button class="btn" data-a="farm">FARM</button>' : ''}</div>`;
    card.querySelector('.x').onclick = () => turbines.select(-1);
    card.querySelector('[data-a=fly]').onclick = () => fly({ lon: t.lon, lat: t.lat, h: Math.max(260, t.hub * 3.2), pitch: -22, heading: (t.dir + 180) % 360 }, 2.5);
    card.querySelector('[data-a=orbit]').onclick = () => { stopAll(); $('#orbit').click(); };
    card.querySelector('[data-a=farm]')?.addEventListener('click', () => fly({ lon: t.farmStats.lon, lat: t.farmStats.lat, h: 5000 + Math.sqrt(t.farmStats.n) * 1100, pitch: -42 }, 3));
  }
  bus.on('select', renderCard);
  setInterval(() => { if (cardDirty && turbines.selected >= 0) renderCard(); }, 350);
  bus.on('turbines:wind', () => { cardDirty = true; });
  bus.on('wake:stats', () => { cardDirty = true; });

  const handler = new C.ScreenSpaceEventHandler(scene.canvas);
  handler.setInputAction(e => { turbines.select(turbines.pickIndex(scene.pick(e.position))); }, C.ScreenSpaceEventType.LEFT_CLICK);
  let lastMove = 0;
  handler.setInputAction(e => {
    const now = performance.now(); if (now - lastMove < 45) return; lastMove = now;
    const p = viewer.camera.pickEllipsoid(e.endPosition, scene.globe.ellipsoid);
    if (p) { const c = C.Cartographic.fromCartesian(p); cursor = { lon: C.Math.toDegrees(c.longitude), lat: C.Math.toDegrees(c.latitude) }; } else cursor = null;
    const i = turbines.pickIndex(scene.pick(e.endPosition));
    scene.canvas.style.cursor = i >= 0 ? 'pointer' : '';
    if (i < 0) { tip.hidden = true; return; }
    const t = turbines.describe(i), cap = t.capKW >= 1000 ? (t.capKW / 1000).toFixed(1) + ' MW' : fmt(t.capKW, t.capKW < 100 ? 1 : 0) + ' kW';
    tip.innerHTML = S.mode === 'archive' && hist
      ? `<b>${t.farm || (t.offshore ? 'Offshore turbine' : 'Wind turbine')}</b> · ${cap} · CF ${Math.round(hist.frame(S.frame)[i] / 2.5)}% in ${hist.label(S.frame)}`
      : `<b>${t.farm || (t.offshore ? 'Offshore turbine' : 'Wind turbine')}</b> · ${cap}${t.capEst ? '*' : ''} · ${t.ws.toFixed(1)} m/s → ${((t.wake ? t.fracEff : t.frac) * 100).toFixed(0)}%`;
    tip.hidden = false; tip.style.left = Math.min(innerWidth - 320, e.endPosition.x + 16) + 'px'; tip.style.top = (e.endPosition.y + 14) + 'px';
  }, C.ScreenSpaceEventType.MOUSE_MOVE);
  scene.canvas.addEventListener('mouseleave', () => { tip.hidden = true; cursor = null; });
  addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' && e.target.type !== 'range') return;
    const k = e.key.toLowerCase();
    if (e.key === 'Escape') { turbines.select(-1); stopAll(); }
    if (e.key === ' ') { e.preventDefault(); $('#play').click(); }
    if (k === 'n') $('#now').click();
    if (k === 'h') goHome();
  });

  // ── share-link persistence ──
  let hashT = 0;
  viewer.camera.moveEnd.addEventListener(() => { clearTimeout(hashT); hashT = setTimeout(() => { if (!S.tour && !S.stopOrbit) writeHash(viewer, S); }, 400); });

  // ── intro ──
  links.update();
  setT(0);
  $('#boot').classList.add('gone');
  if (hash.v) { const [lon, lat, h, hd, pt] = hash.v.split(',').map(Number); setView(viewer, { lon, lat, h, heading: hd, pitch: pt }); }
  else { await new Promise(r => setTimeout(r, 400)); flyToView(viewer, PRESETS[0], 5.5); }
  if (!wx.ready) $('#k-model').textContent = 'waiting…';
  wxP.then(state => {
    if (state !== 'none') { setT(S.T); return; }
    // Open-Meteo can be rate-limited or overloaded; keep trying until the live wind field arrives.
    const retry = async () => { try { await wx.load(); setT(S.T); } catch { setTimeout(retry, 45e3); } };
    setTimeout(retry, 15e3);
  });
  if (new URLSearchParams(location.search).get('mode') === 'archive') setMode('archive');
}

main().catch(e => {
  console.error(e);
  const row = document.createElement('div'); row.className = 'err'; row.textContent = 'STARTUP FAILED: ' + e.message; bootlog.appendChild(row);
});
