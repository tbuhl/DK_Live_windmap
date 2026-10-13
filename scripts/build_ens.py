"""Build the turbine register + production history from the Danish Energy Agency (ENS) workbooks.

Inputs (all optional except --vinddata):
  --vinddata   "Vinddata YYYY-MM.xlsx"        master data + monthly production (last ~45 months)
  --park       "Parkproduktion YYYY-MM.xlsx"   park-level monthly production (parks that do not report per turbine)
  --hist       "Historiske vinddata.xlsx"      turbines decommissioned long ago, yearly production since 1977
  --monthly    "Maanedsdata_2002_2024.xlsx"    older per-turbine monthly production (2002 -> 2024)
  --main       "Vindmoelledata til YYYY-MM.xlsx"  older master workbook (yearly production back to 1977 for active turbines)
  --overview   "2_oversigtstabeller_*.xlsx"    official national annual totals (used to validate and for the national chart)
  --osm        data/turbines_source.csv        OSM turbines (fills coordinates for micro turbines + adds unregistered ones)

Outputs: data/turbines.json (register), data/history.bin (uint8 capacity factor per frame x turbine),
         data/history.json (frames, national series, parks).

    python scripts/build_ens.py --vinddata ... --park ... --hist ... --monthly ... --main ... --overview ...

Needs: pandas, numpy, openpyxl.   (UTM -> lat/lon is implemented here, so no pyproj.)
"""
import argparse, json, math, re, sys
from pathlib import Path
import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
D2R = math.pi / 180


# ── UTM zone 32N (ETRS89 / GRS80) → lon/lat, Krüger series ──────────────────────────────
def utm32_inverse(E, N):
    a, f = 6378137.0, 1 / 298.257222101
    n = f / (2 - f); k0 = 0.9996; E0 = 500000.0; lon0 = 9.0 * D2R
    A = a / (1 + n) * (1 + n**2 / 4 + n**4 / 64)
    b = [n / 2 - 2 * n**2 / 3 + 37 * n**3 / 96 - n**4 / 360, n**2 / 48 + n**3 / 15 - 437 * n**4 / 1440,
         17 * n**3 / 480 - 37 * n**4 / 840, 4397 * n**4 / 161280]
    d = [2 * n - 2 * n**2 / 3 - 2 * n**3 + 116 * n**4 / 45, 7 * n**2 / 3 - 8 * n**3 / 5 - 227 * n**4 / 45,
         56 * n**3 / 15 - 136 * n**4 / 35, 4279 * n**4 / 630]
    xi = N / (k0 * A); eta = (E - E0) / (k0 * A)
    xi_p, eta_p = xi.copy(), eta.copy()
    for j in range(1, 5):
        xi_p -= b[j - 1] * np.sin(2 * j * xi) * np.cosh(2 * j * eta)
        eta_p -= b[j - 1] * np.cos(2 * j * xi) * np.sinh(2 * j * eta)
    chi = np.arcsin(np.sin(xi_p) / np.cosh(eta_p))
    lat = chi.copy()
    for j in range(1, 5): lat += d[j - 1] * np.sin(2 * j * chi)
    lon = lon0 + np.arctan2(np.sinh(eta_p), np.cos(xi_p))
    return lon / D2R, lat / D2R


def num(s):
    return pd.to_numeric(s.astype(str).str.replace(',', '.', regex=False).str.strip().replace({'': np.nan, 'nan': np.nan, 'None': np.nan, 'NaT': np.nan}), errors='coerce')


def gs(s):
    """normalise GSRN to a plain digit string"""
    return s.astype(str).str.strip().str.replace(r'\.0$', '', regex=True)


def month_cols(cols):
    return [c for c in cols if re.fullmatch(r'\d{4}-\d{2}', str(c))]


# ── readers ─────────────────────────────────────────────────────────────────────────────────
def read_vinddata(path):
    raw = pd.read_excel(path, header=None, skiprows=3, dtype=str)
    cols = list(pd.read_excel(path, header=None, nrows=3, dtype=str).iloc[2])
    raw.columns = cols
    mc = month_cols(cols)
    df = pd.DataFrame({'gsrn': gs(raw.iloc[:, 0]), 'park': raw.iloc[:, 1].fillna('').astype(str).str.strip(),
                       'con': pd.to_datetime(raw.iloc[:, 2], errors='coerce'), 'dec': pd.to_datetime(raw.iloc[:, 3], errors='coerce'),
                       'cap': num(raw.iloc[:, 4]), 'rotor': num(raw.iloc[:, 5]), 'hub': num(raw.iloc[:, 6]),
                       'make': raw.iloc[:, 7].fillna('').astype(str), 'type': raw.iloc[:, 8].fillna('').astype(str),
                       'x': num(raw.iloc[:, 13]), 'y': num(raw.iloc[:, 14])})
    # the 'Kommune' / 'Type af placering' headers are swapped relative to the data in this workbook: detect by content
    for k in (9, 10):
        vals = raw.iloc[:, k].dropna().astype(str)
        if vals.isin(['LAND', 'HAV']).mean() > 0.9: df['place'] = raw.iloc[:, k].fillna('')
        else: df['muni'] = raw.iloc[:, k].fillna('')
    M = raw[mc].apply(num, axis=0); M.index = df.gsrn.values
    dups = int(df.gsrn.duplicated().sum())
    if dups: print('   Vinddata: merged', dups, 'duplicate GSRN rows')
    M = M.groupby(level=0).sum(min_count=1)
    return df.drop_duplicates('gsrn'), M


def read_park(path):
    raw = pd.read_excel(path, header=None, skiprows=2, dtype=str)
    cols = list(pd.read_excel(path, header=None, nrows=2, dtype=str).iloc[1]); raw.columns = cols
    mc = month_cols(cols)
    P = raw[mc].apply(num, axis=0); P.index = raw.iloc[:, 0].astype(str).str.strip().values
    return P.groupby(level=0).sum()


def read_hist(path):
    raw = pd.read_excel(path, header=None, skiprows=3, dtype=str)
    cols = list(pd.read_excel(path, header=None, nrows=3, dtype=str).iloc[2]); raw.columns = cols
    yc = [c for c in cols if re.fullmatch(r'\d{4}', str(c))]
    df = pd.DataFrame({'gsrn': gs(raw.iloc[:, 0]), 'con': pd.to_datetime(raw.iloc[:, 1], errors='coerce'), 'dec': pd.to_datetime(raw.iloc[:, 2], errors='coerce'),
                       'cap': num(raw.iloc[:, 3]), 'rotor': num(raw.iloc[:, 4]), 'hub': num(raw.iloc[:, 5]),
                       'make': raw.iloc[:, 6].fillna('').astype(str), 'type': raw.iloc[:, 7].fillna('').astype(str),
                       'x': num(raw.iloc[:, 12]), 'y': num(raw.iloc[:, 13])})
    place = raw.iloc[:, 9].fillna('')
    df['place'] = place
    Y = raw[yc].apply(num, axis=0); Y.index = df.gsrn.values; Y.columns = [int(c) for c in yc]
    return df, Y


def read_old_monthly(path):
    """older per-turbine monthly workbook; months are assigned by column position (the 2012 sheet has 12 identical headers)"""
    import openpyxl
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    out = {}
    for ws in wb.worksheets:
        m = re.search(r'(20\d{2})$', ws.title)
        if not m: continue
        yr = int(m.group(1)); rows = []
        for i, row in enumerate(ws.iter_rows(values_only=True)):
            if i < 9: continue
            g = row[0]
            if g is None or not re.fullmatch(r'\d{10,}', str(g).strip().split('.')[0]): continue
            rows.append([str(g).strip().split('.')[0]] + [row[k] if isinstance(row[k], (int, float)) else (float(str(row[k]).replace(',', '.')) if row[k] not in (None, '') else np.nan) for k in range(3, 15)])
        if not rows: continue
        df = pd.DataFrame(rows, columns=['gsrn'] + [f'{yr}-{k:02d}' for k in range(1, 13)]).set_index('gsrn')
        out[yr] = df.groupby(level=0).sum(min_count=1)
        print('   old monthly', yr, len(df), 'rows', round(float(df.sum().sum()) / 1e9, 2), 'TWh', flush=True)
    return pd.concat(out.values(), axis=1).sort_index(axis=1)


def read_old_main(path):
    head = pd.read_excel(path, header=None, nrows=11, dtype=object)
    labels = head.iloc[6].tolist()
    raw = pd.read_excel(path, header=None, skiprows=11, dtype=object).dropna(how='all')
    df = pd.DataFrame({'gsrn': gs(raw.iloc[:, 0]), 'con': pd.to_datetime(raw.iloc[:, 1], errors='coerce'), 'dec': pd.to_datetime(raw.iloc[:, 2], errors='coerce'),
                       'cap': num(raw.iloc[:, 3]), 'rotor': num(raw.iloc[:, 4]), 'hub': num(raw.iloc[:, 5]),
                       'make': raw.iloc[:, 6].fillna('').astype(str), 'type': raw.iloc[:, 7].fillna('').astype(str),
                       'place': raw.iloc[:, 9].fillna('').astype(str), 'x': num(raw.iloc[:, 12]), 'y': num(raw.iloc[:, 13])})
    ycols = {}
    for j, lab in enumerate(labels):
        if j >= 15 and lab is not None and re.fullmatch(r'\d{4}', str(lab).strip().split('.')[0]):
            ycols[int(str(lab).strip().split('.')[0])] = j
    Y = pd.DataFrame({y: num(raw.iloc[:, j]) for y, j in ycols.items()}); Y.index = df.gsrn.values
    return df[df.gsrn.str.fullmatch(r'\d{10,}')], Y[Y.index.str.fullmatch(r'\d{10,}')]


def read_overview(path):
    raw = pd.read_excel(path, sheet_name='LAND_HAV - ON_OFF shore', header=None, dtype=object)
    rows = []
    for _, r in raw.iterrows():
        y = str(r[0]).strip()
        m = re.match(r'^(\d{4})', y)
        if m and pd.notna(r[2]):
            f = lambda v: float(v) if pd.notna(v) and str(v).strip() != '' else 0.0
            rows.append(dict(year=int(m.group(1)), n_on=f(r[1]), cap_on=f(r[2]) / 1000, n_off=f(r[4]), cap_off=f(r[5]) / 1000, gwh_on=f(r[7]) / 1e6, gwh_off=f(r[8]) / 1e6))
    return pd.DataFrame(rows).drop_duplicates('year').set_index('year')


# ── main ───────────────────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser()
    for k in ('vinddata', 'park', 'hist', 'monthly', 'main', 'overview', 'osm'): ap.add_argument('--' + k)
    a = ap.parse_args()
    if not a.vinddata: ap.error('--vinddata is required')

    print('reading Vinddata ...', flush=True); vd, VM = read_vinddata(a.vinddata)
    PM = read_park(a.park) if a.park else pd.DataFrame()
    hd, HY = read_hist(a.hist) if a.hist else (pd.DataFrame(columns=vd.columns), pd.DataFrame())
    OM = read_old_monthly(a.monthly) if a.monthly else pd.DataFrame()
    if a.main:
        print('reading old main workbook ...', flush=True); od, OY = read_old_main(a.main)
    else: od, OY = pd.DataFrame(columns=vd.columns), pd.DataFrame()
    ov = read_overview(a.overview) if a.overview else None

    # ── master list: new register > old main > historic ──
    cols = ['gsrn', 'con', 'dec', 'cap', 'rotor', 'hub', 'make', 'type', 'place', 'x', 'y']
    vd['src'] = 'vind'; od['src'] = 'main'; hd['src'] = 'hist'
    allr = pd.concat([vd[cols + ['src', 'park', 'muni']], od[cols + ['src']], hd[cols + ['src']]], ignore_index=True)
    allr['pri'] = allr.src.map({'vind': 0, 'main': 1, 'hist': 2})
    allr = allr.sort_values('pri', kind='stable')
    master = allr.groupby('gsrn', sort=False).first()                 # first non-null value per column, priority order
    master['park'] = master['park'].fillna('')
    master = master.reset_index()
    for c in ('cap', 'rotor', 'hub', 'x', 'y'): master[c] = pd.to_numeric(master[c], errors='coerce').astype(float)   # object dtype appears when an optional workbook is missing
    for c in ('con', 'dec'): master[c] = pd.to_datetime(master[c], errors='coerce')
    print('master turbines:', len(master), ' (vind', len(vd), 'main', len(od), 'hist', len(hd), ')')

    # ── coordinates ──
    ok = master.x.between(300000, 950000) & master.y.between(5900000, 6450000)
    lon = np.full(len(master), np.nan); lat = np.full(len(master), np.nan)
    lo, la = utm32_inverse(master.x[ok].values.astype(float), master.y[ok].values.astype(float)); lon[ok.values] = lo; lat[ok.values] = la
    master['lon'], master['lat'] = lon, lat
    master['xy_src'] = np.where(ok, 'ens', '')
    if a.osm:
        o = pd.read_csv(a.osm, dtype={'gsrn': str}); o['gsrn'] = o.gsrn.fillna('').str.strip()
        o1 = o.assign(g=o.gsrn.str.split(';')).explode('g'); o1['g'] = o1.g.str.strip()
        o1 = o1[o1.g != ''].drop_duplicates('g').set_index('g')
        miss = master.lon.isna() & master.gsrn.isin(o1.index)
        master.loc[miss, 'lon'] = master.loc[miss, 'gsrn'].map(o1.lon); master.loc[miss, 'lat'] = master.loc[miss, 'gsrn'].map(o1.lat)
        master.loc[miss, 'xy_src'] = 'osm'
        print('coordinates recovered from OSM by GSRN:', int(miss.sum()))
    master['placed'] = master.lon.notna() & master.lat.between(54.3, 58.0) & master.lon.between(6.5, 15.5)
    print('placed:', int(master.placed.sum()), 'unplaced:', int((~master.placed).sum()), ' unplaced capacity MW', round(master.loc[~master.placed, 'cap'].fillna(0).sum() / 1000, 1))

    # ── sanity / imputation of geometry ──
    kwm2 = float(np.nanmedian((master.cap / (math.pi * (master.rotor / 2) ** 2))[(master.rotor > 20) & (master.cap > 100)]))
    master['cap'] = master.cap.where(master.cap > 0)
    master['capEst'] = master.cap.isna() | (master.cap < 1)
    rot_bad = ~(master.rotor > 1.5)
    rot_from_cap = np.sqrt(master.cap.fillna(10) / kwm2 / math.pi) * 2
    master['rotorEst'] = rot_bad
    master['rotor'] = master.rotor.where(~rot_bad, rot_from_cap.clip(lower=3, upper=250))
    hub_bad = ~(master.hub > 1.5)
    master['hubEst'] = hub_bad | (master.hub < master.rotor * 0.42)
    hub_guess = (master.rotor * np.where(master.place == 'HAV', 0.82, 0.9)).clip(lower=12)
    master['hub'] = np.where(hub_bad | (master.hub < master.rotor * 0.42), hub_guess, master.hub)
    master['hub'] = np.maximum(master.hub, master.rotor / 2 + 8).clip(upper=190)         # blade tips never touch the ground
    master['cap'] = master.cap.fillna(pd.Series(np.maximum(5.0, kwm2 * math.pi * (master.rotor / 2) ** 2), index=master.index)).round(1)
    master['off'] = (master.place == 'HAV').astype(int)

    # ── frames ──
    YEARS = list(range(1977, 2002)); m0 = pd.Timestamp('2002-01-01'); m1 = pd.Timestamp(max(month_cols(VM.columns)) + '-01')
    MONTHS = pd.period_range('2002-01', m1.strftime('%Y-%m'), freq='M')
    nA, nM = len(YEARS), len(MONTHS); nF = nA + nM
    idx = {g: i for i, g in enumerate(master.gsrn)}; N = len(master)
    kwh_m = np.zeros((nM, N), dtype=np.float64); kwh_a = np.zeros((nA, N), dtype=np.float64)

    def put_month(frame, gsrn_index, vals):
        ii = np.array([idx.get(g, -1) for g in gsrn_index]); ok_ = ii >= 0
        np.add.at(kwh_m[frame], ii[ok_], np.nan_to_num(np.asarray(vals, dtype=float))[ok_])

    mlab = [str(p) for p in MONTHS]
    if len(OM):
        for c in OM.columns:
            if c in mlab and c < '2023-01': put_month(mlab.index(c), OM.index, OM[c].values)
    for c in month_cols(VM.columns):
        if c in mlab: put_month(mlab.index(c), VM.index, VM[c].values)
    # park-level production → turbines, only for parks whose turbines report nothing themselves
    dist_parks = 0
    if len(PM):
        pcol = master.park.values; cap = master.cap.values; con = master.con.values; dec = master.dec.values
        tsum = VM.sum(axis=1); tsum = pd.Series(tsum.values, index=VM.index)
        for pid in PM.index:
            mem = np.where(pcol == pid)[0]
            if not len(mem): continue
            if float(tsum.reindex(master.gsrn.values[mem]).fillna(0).sum()) > 0: continue
            dist_parks += 1
            for c in PM.columns:
                if c not in mlab: continue
                prod = float(PM.loc[pid, c]) if pd.notna(PM.loc[pid, c]) else 0.0
                if prod <= 0: continue
                fi = mlab.index(c); end = pd.Period(c, freq='M').end_time; start = pd.Period(c, freq='M').start_time
                el = [k for k in mem if (pd.isna(con[k]) or con[k] <= end) and (pd.isna(dec[k]) or dec[k] >= start)] or list(mem)
                w = cap[el] / cap[el].sum()
                kwh_m[fi, el] += prod * w
        print('parks distributed from park-level production:', dist_parks)
    # yearly frames 1977..2001: old main (active turbines) + historic (decommissioned)
    for src in (OY, HY):
        if not len(src): continue
        for k, y in enumerate(YEARS):
            if y in src.columns:
                col = src[y].values
                ii = np.array([idx.get(g, -1) for g in src.index]); ok_ = ii >= 0
                np.add.at(kwh_a[k], ii[ok_], np.nan_to_num(col)[ok_] * (kwh_a[k][ii[ok_]] == 0))   # first source wins per turbine
    # ── capacity factors (uint8, 250 = 100 %) ──
    cap = master.cap.values; con = master.con.values; dec = master.dec.values
    def op_hours(start, end):   # operating hours of each turbine within [start, end)
        s = np.where(pd.isna(con), np.datetime64(start), np.maximum(con, np.datetime64(start)))
        e = np.where(pd.isna(dec), np.datetime64(end), np.minimum(dec, np.datetime64(end)))
        return np.clip((e - s).astype('timedelta64[h]').astype(float), 0, None)
    H = np.zeros((nF, N), dtype=np.uint8)
    for k, y in enumerate(YEARS):
        hrs = np.maximum(op_hours(f'{y}-01-01', f'{y + 1}-01-01'), 1)
        cf = kwh_a[k] / (cap * hrs); H[k] = np.clip(np.nan_to_num(cf) * 250, 0, 255)
    for k, p in enumerate(MONTHS):
        hrs = np.maximum(op_hours(p.start_time.strftime('%Y-%m-%d'), (p.end_time + pd.Timedelta(seconds=1)).strftime('%Y-%m-%d')), 1)
        cf = kwh_m[k] / (cap * hrs); H[nA + k] = np.clip(np.nan_to_num(cf) * 250, 0, 255)

    # ── national series (all turbines, placed or not) ──
    off = master.off.values.astype(bool)
    mon_on = kwh_m[:, ~off].sum(axis=1) / 1e6; mon_off = kwh_m[:, off].sum(axis=1) / 1e6      # GWh
    yr_on = {y: kwh_a[k, ~off].sum() / 1e6 for k, y in enumerate(YEARS)}; yr_off = {y: kwh_a[k, off].sum() / 1e6 for k, y in enumerate(YEARS)}
    mser = pd.DataFrame({'on': mon_on, 'off': mon_off}, index=MONTHS)
    def cap_at(ts):
        e = (pd.isna(con) | (con <= np.datetime64(ts))) & (pd.isna(dec) | (dec > np.datetime64(ts)))
        return cap[e & ~off].sum() / 1000, cap[e & off].sum() / 1000, int((e & ~off).sum()), int((e & off).sum())
    capm = [cap_at((p.start_time + pd.Timedelta(days=15)).strftime('%Y-%m-%d')) for p in MONTHS]
    annual = {}
    for y in range(1977, m1.year + 1):
        if y < 2002: gon, goff = yr_on[y], yr_off[y]
        else:
            sel = mser[mser.index.year == y]; gon, goff = float(sel.on.sum()), float(sel.off.sum())
        c = cap_at(f'{y}-07-01') if y < m1.year else cap_at(m1.strftime('%Y-%m-%d'))
        annual[y] = dict(on=gon, off=goff, capOn=c[0], capOff=c[1], nOn=c[2], nOff=c[3], months=12 if y < m1.year else m1.month)
    if ov is not None:
        print('\nvalidation vs official annual totals (GWh):  year  ours  official  ratio')
        for y in sorted(ov.index):
            if y in annual:
                ours = annual[y]['on'] + annual[y]['off']; off_ = ov.loc[y, 'gwh_on'] + ov.loc[y, 'gwh_off']
                if y % 3 == 0 or y >= 2019 or abs(ours / max(off_, 1) - 1) > 0.05: print(f'   {y}  {ours:9.0f}  {off_:9.0f}  {ours / max(off_, 1):.3f}')
                annual[y]['official'] = off_
    # ── write register ──
    keep = master.placed
    mk = sorted(master.loc[keep, 'make'].replace('', 'Unknown').unique(), key=lambda s: (s == 'Unknown', s)); tp = sorted(master.loc[keep, 'type'].replace('', '–').unique())
    mc = master.loc[keep]
    parks = {}
    for pid, grp in mc[mc.park != ''].groupby('park'):
        parks[pid] = dict(n=int(len(grp)), mw=round(float(grp.cap.sum()) / 1000, 2), lon=round(float(grp.lon.mean()), 4), lat=round(float(grp.lat.mean()), 4), off=int(grp.off.mean() > 0.5))
    pids = list(parks)
    ymd = lambda s: [None if pd.isna(v) else int(v.year * 12 + v.month - 1) for v in s]     # month index (year*12+month0)
    out = dict(
        n=int(keep.sum()), source='Energistyrelsen (ENS) stamdataregister for vindkraftanlæg', kwPerM2=round(kwm2, 4),
        makes=mk, types=tp, parks=[dict(id=p, **parks[p]) for p in pids],
        gsrn=mc.gsrn.tolist(), lon=[round(v, 5) for v in mc.lon], lat=[round(v, 5) for v in mc.lat],
        cap=[float(v) for v in mc.cap], capEst=mc.capEst.astype(int).tolist(), rotor=[round(float(v), 1) for v in mc.rotor], hub=[round(float(v), 1) for v in mc.hub],
        geoEst=(mc.rotorEst | mc.hubEst).astype(int).tolist(), off=mc.off.tolist(),
        make=[mk.index(m if m else 'Unknown') for m in mc.make], type=[tp.index(t if t else '–') for t in mc.type],
        con=ymd(mc.con), dec=ymd(mc.dec), park=[pids.index(p) if p in parks else -1 for p in mc.park], xy=mc.xy_src.tolist(),
        muni=[str(v) if pd.notna(v) else '' for v in mc.get('muni', pd.Series('', index=mc.index))])
    (ROOT / 'data' / 'turbines.json').write_text(json.dumps(out, separators=(',', ':')), encoding='utf-8')
    # history matrix: frame-major, placed turbines only
    Hs = np.ascontiguousarray(H[:, keep.values]); (ROOT / 'data' / 'history.bin').write_bytes(Hs.tobytes())
    hist = dict(nTurbines=int(keep.sum()), annualStart=1977, nAnnual=nA, monthStart='2002-01', nMonthly=nM, scale=250,
                annual={str(y): v for y, v in annual.items()},
                monthly=dict(on=[round(float(v), 1) for v in mon_on], off=[round(float(v), 1) for v in mon_off],
                             capOn=[round(c[0], 1) for c in capm], capOff=[round(c[1], 1) for c in capm]))
    (ROOT / 'data' / 'history.json').write_text(json.dumps(hist, separators=(',', ':')), encoding='utf-8')
    live = mc[mc.dec.isna()]
    print(f"\nregister: {out['n']} placed turbines ({len(live)} active, {int(mc.off.sum())} offshore) | active capacity {live.cap.sum() / 1e6:.2f} GW | history.bin {Hs.nbytes / 1e6:.1f} MB ({Hs.shape})")


if __name__ == '__main__':
    main()
