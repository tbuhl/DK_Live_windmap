"""Download the current wind-turbine workbooks from the Danish Energy Agency (ENS) data overview page.

    python scripts/fetch_ens.py [target_dir]        # default: data/ens/

The page lists three wind files that are republished every two months; the links change, so they are found by name:
    Vinddata (ultimo MM YYYY)           master data + monthly production
    Parkproduktion (ultimo MM YYYY)     production of parks that report per park
    Historiske vinddata (ultimo YYYY)   turbines decommissioned long ago
Prints the build command for scripts/build_ens.py when done. Standard library only.
"""
import re, sys, urllib.request
from pathlib import Path

PAGE = 'https://ens.dk/analyser-og-statistik/data-oversigt-over-energisektoren'
WANT = {'vinddata': r'^Vinddata\b', 'park': r'^Parkproduktion\b', 'hist': r'^Historiske vinddata\b'}


def get(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'dk-wind-godseye/1.0'})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read(), r.headers.get('Content-Disposition', '')


def main():
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / 'data' / 'ens'
    target.mkdir(parents=True, exist_ok=True)
    html = get(PAGE)[0].decode('utf-8', errors='replace')
    links = {}
    for href, text in re.findall(r'<a[^>]+href="(/media/\d+/download)"[^>]*>(.*?)</a>', html, flags=re.S):
        text = re.sub(r'\s+', ' ', re.sub('<[^>]+>', '', text)).strip()
        for key, pat in WANT.items():
            if key not in links and re.search(pat, text):
                links[key] = (href, text)
    missing = set(WANT) - set(links)
    if missing:
        sys.exit(f'could not find on the page: {sorted(missing)} (has the layout changed?)')
    paths = {}
    for key, (href, text) in links.items():
        data, disp = get('https://ens.dk' + href)
        name = re.search(r'filename="?([^";]+)', disp)
        out = target / (name.group(1).strip() if name else f'{key}.xlsx')
        out.write_bytes(data); paths[key] = out
        print(f'{text}\n   -> {out}  ({len(data) / 1e6:.1f} MB)')
    print('\nNext (add --monthly / --main / --overview with older workbooks to extend the history before 2023):\n'
          f'  python scripts/build_ens.py --vinddata "{paths["vinddata"]}" --park "{paths["park"]}" --hist "{paths["hist"]}" --osm data/turbines_source.csv')


if __name__ == '__main__':
    main()
