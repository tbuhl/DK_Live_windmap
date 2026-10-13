// Adaptive quality: watches the real frame rate and trades visual extras for smoothness (and back again).
//   level 0  full: MSAA 4x, bloom, 1.5x resolution, 3800 wind particles, 200 3D turbines
//   level 1  bloom off
//   level 2  MSAA off + FXAA, 1.0x resolution, 60% particles, 120 models
//   level 3  0.75x resolution, 30% particles, 60 models
// Modes: AUTO (adapts), HIGH (pinned to 0), LOW (pinned to 3). `?q=high|low` in the URL pins it too.
import { bus, $ } from './util.js';

const LEVELS = [
  { msaa: 4, scale: 1.5, flow: 1.0, models: 200, bloom: true },
  { msaa: 4, scale: 1.5, flow: 1.0, models: 200, bloom: false },
  { msaa: 1, scale: 1.0, flow: 0.6, models: 120, bloom: false },
  { msaa: 1, scale: 0.75, flow: 0.3, models: 60, bloom: false },
];

export class Perf {
  constructor(viewer, { flow, turbines }) {
    this.viewer = viewer; this.flow = flow; this.turbines = turbines;
    const q = new URLSearchParams(location.search).get('q');
    this.mode = q === 'high' ? 'high' : q === 'low' ? 'low' : 'auto';
    this.level = this.mode === 'low' ? 3 : 0; this.fps = 60; this.low = 0; this.high = 0; this.frames = 0; this.t0 = performance.now(); this.hidden = false;
    this.apply(this.level, true);
    const loop = now => { this.frames++; if (now - this.t0 >= 1000) this.sample(now); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
    document.addEventListener('visibilitychange', () => { this.low = this.high = 0; this.t0 = performance.now(); this.frames = 0; });
    $('#t-fps').addEventListener('click', () => this.cycle());
  }

  sample(now) {
    this.fps = this.frames * 1000 / (now - this.t0); this.frames = 0; this.t0 = now;
    if (document.hidden) return;
    if (this.mode === 'auto') {
      if (this.fps < 26) { this.low++; this.high = 0; } else if (this.fps > 55) { this.high++; this.low = 0; } else { this.low = 0; this.high = Math.max(0, this.high - 1); }
      if (this.low >= 3 && this.level < 3) { this.apply(this.level + 1); this.low = 0; }
      else if (this.high >= 10 && this.level > 0) { this.apply(this.level - 1); this.high = 0; }
    }
    this.show();
  }

  apply(level, silent = false) {
    this.level = level; const L = LEVELS[level], v = this.viewer, dpr = window.devicePixelRatio || 1;
    v.resolutionScale = Math.min(dpr, L.scale);
    v.scene.msaaSamples = L.msaa; v.scene.postProcessStages.fxaa.enabled = L.msaa === 1;
    this.flow.quality = L.flow; this.turbines.maxModels = L.models;
    bus.emit('perf', L);
    if (!silent) console.info('[perf] quality level', level, 'fps', this.fps.toFixed(0));
    this.show();
  }

  cycle() {
    this.mode = this.mode === 'auto' ? 'high' : this.mode === 'high' ? 'low' : 'auto';
    this.low = this.high = 0;
    if (this.mode === 'high') this.apply(0); else if (this.mode === 'low') this.apply(3); else this.apply(this.level);
  }

  show() { const el = $('#t-fps'); if (el) el.textContent = `${Math.round(this.fps)} FPS · ${this.mode === 'auto' ? 'AUTO' : this.mode.toUpperCase()}${this.level ? ' Q' + (4 - this.level) : ''}`; }
}
