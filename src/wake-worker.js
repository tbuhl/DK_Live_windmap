import { computeWake } from './wakecore.js';

self.onmessage = (e) => {
  const { id, T, raster, rowWidth } = e.data;
  const t0 = performance.now();
  const r = computeWake(T, { raster, rowWidth });
  const msg = { id, ms: performance.now() - t0, ueff: r.ueff, frac: r.frac, fracGross: r.fracGross, rows: r.rows, raster: r.raster || null };
  const transfer = [r.ueff.buffer, r.frac.buffer, r.fracGross.buffer]; if (r.raster) transfer.push(r.raster.buffer);
  self.postMessage(msg, transfer);
};
