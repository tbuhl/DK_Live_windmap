"""Validate the in-browser wake model (src/wakecore.js) against PyWake on a real wind farm layout.

    pip install py_wake numpy
    python scripts/wake_validate.py            # uses Horns Rev 1 from data/turbines.json

Both sides use: Niayifar & Porté-Agel (2016) Gaussian wake (k = 0.38*TI + 0.004), squared-sum superposition,
effective-wind-speed propagation, the same tabulated thrust / power curves, uniform ambient inflow.
"""
import json, math, subprocess, sys, tempfile
from pathlib import Path
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
d = json.loads((ROOT / 'data' / 'turbines.json').read_text(encoding='utf-8'))
lon0, lat0, R_KM = 7.84, 55.486, 4.5                   # Horns Rev 1
sel = [i for i in range(d['n']) if d['dec'][i] is None and
       math.hypot((d['lat'][i] - lat0) * 111.32, (d['lon'][i] - lon0) * 111.32 * math.cos(math.radians(lat0))) < R_KM]
x = [(d['lon'][i] - lon0) * 111320 * math.cos(math.radians(lat0)) for i in sel]
y = [(d['lat'][i] - lat0) * 110574 for i in sel]
D = float(np.median([d['rotor'][i] for i in sel])); cap = float(np.median([d['cap'][i] for i in sel]))
print(f'{len(sel)} turbines, D={D:.0f} m, rated={cap:.0f} kW')
cases = [dict(ws=ws, wd=wd, ti=0.06) for ws in (5, 7, 9, 12, 16) for wd in (270, 222, 312, 180, 250)]
tmp = Path(tempfile.mkdtemp())
(tmp / 'c.json').write_text(json.dumps(dict(curves=True, cap=cap)))
subprocess.run(['node', str(ROOT / 'scripts' / 'wake_validate.mjs'), str(tmp / 'c.json'), str(tmp / 'curves.json')], check=True)
(tmp / 'in.json').write_text(json.dumps(dict(x=x, y=y, D=D, cap=cap, cases=cases)))
subprocess.run(['node', str(ROOT / 'scripts' / 'wake_validate.mjs'), str(tmp / 'in.json'), str(tmp / 'out.json')], check=True)
js = json.loads((tmp / 'out.json').read_text()); cv = json.loads((tmp / 'curves.json').read_text())

from py_wake.wind_turbines import WindTurbine
from py_wake.wind_turbines.power_ct_functions import PowerCtTabular
from py_wake.site import UniformSite
from py_wake.wind_farm_models import PropagateDownwind
from py_wake.deficit_models.gaussian import NiayifarGaussianDeficit
from py_wake.superposition_models import SquaredSum
wt = WindTurbine('generic', D, 80, powerCtFunction=PowerCtTabular(cv['ws'], cv['power_kw'], 'kW', cv['ct']))
site = UniformSite(ti=0.06)
wfm = PropagateDownwind(site, wt, wake_deficitModel=NiayifarGaussianDeficit(use_effective_ws=True, use_effective_ti=False), superpositionModel=SquaredSum())
print(f"{'ws':>4} {'wd':>4} | {'farm P  js (MW)':>15} {'pywake':>9} {'diff %':>7} | {'max |dU| m/s':>12} {'wake loss js':>13} {'pywake':>8}")
worst_p = worst_u = 0
for c, r in zip(cases, js):
    sim = wfm(x, y, wd=[c['wd']], ws=[c['ws']], TI=c['ti'])
    u_py = sim.WS_eff.values.reshape(-1); p_py = sim.Power.values.reshape(-1) / 1000       # kW
    p_js = np.array(r['power_kw']); u_js = np.array(r['ueff'])
    gross = float(np.interp(c['ws'], cv['ws'], cv['power_kw'])) * len(x)
    dp = (p_js.sum() / max(p_py.sum(), 1e-9) - 1) * 100 if p_py.sum() > 1 else 0.0
    du = float(np.abs(u_js - u_py).max()); worst_p = max(worst_p, abs(dp)); worst_u = max(worst_u, du)
    print(f"{c['ws']:>4} {c['wd']:>4} | {p_js.sum() / 1000:>15.2f} {p_py.sum() / 1000:>9.2f} {dp:>7.3f} | {du:>12.4f} {100 * (1 - p_js.sum() / gross):>12.1f}% {100 * (1 - p_py.sum() / gross):>7.1f}%")
print(f'\nworst farm-power difference: {worst_p:.3f} %   worst single-turbine speed difference: {worst_u:.4f} m/s')
