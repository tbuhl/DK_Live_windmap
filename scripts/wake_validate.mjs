// Node side of scripts/wake_validate.py: runs src/wakecore.js on cases written by the Python script.
import fs from 'node:fs';
import { computeWake, thrustCoefficient, powerFraction, ratedSpeed } from '../src/wakecore.js';
const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (spec.curves) {   // tabulated curves so PyWake uses exactly the same turbine
  const ws = [], ct = [], pw = [];
  for (let u = 0; u <= 30.001; u += 0.05) { ws.push(+u.toFixed(2)); ct.push(thrustCoefficient(u, spec.cap)); pw.push(powerFraction(u, ratedSpeed(spec.cap)) * spec.cap); }
  fs.writeFileSync(process.argv[3], JSON.stringify({ ws, ct, power_kw: pw })); process.exit(0);
}
const out = spec.cases.map(c => {
  const n = spec.x.length;
  const T = { x: spec.x, y: spec.y, D: Array(n).fill(spec.D), cap: Array(n).fill(spec.cap), u: Array(n).fill(c.ws), dir: Array(n).fill(c.wd), ti: Array(n).fill(c.ti) };
  const r = computeWake(T);
  return { ws: c.ws, wd: c.wd, ueff: Array.from(r.ueff), power_kw: Array.from(r.frac, f => f * spec.cap) };
});
fs.writeFileSync(process.argv[3], JSON.stringify(out));
