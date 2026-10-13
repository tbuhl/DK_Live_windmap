# DK WIND — Danish wind & grid

Every wind turbine in Denmark on a live 3D globe: wind flow, radar, **lightning**, **wake analysis** at farm level, interconnector flows, spot prices, and an **archive** that replays 50 years of production.

```bash
python serve.py          # opens http://127.0.0.1:8765   (or double-click start.bat on Windows)
```

No `pip install` is needed to run it. `serve.py` uses only the Python standard library and CesiumJS loads from a CDN, so you need an internet connection.

## Modes

**LIVE** (default): current wind field, radar, lightning, grid telemetry, and a −3 h … +24 h forecast timeline that drives wind, turbine output, wakes, clouds and day-ahead prices.

**ARCHIVE** (switch at the bottom left): every turbine that ever stood, coloured by its capacity factor. Annual frames cover 1977–2001, monthly frames 2002 → the latest month. Play it, drag the timeline, or click or drag the two national charts. Select a turbine to see its own capacity-factor history. Decommissioned turbines appear and disappear on their real dates.

## Data

| What | Source |
|---|---|
| Turbine register, dimensions, coordinates | **Energistyrelsen** (ENS) *Vinddata* (to 2026-09) and *Historiske vinddata* |
| Production history | ENS *Vinddata* (2023→), *Parkproduktion*, and older ENS workbooks for 2002–2022 monthly and 1977–2001 yearly |
| Live production, exchange, spot and imbalance prices | Energi Data Service (Energinet) |
| Wind, clouds, forecast | Open-Meteo |
| Rain radar | RainViewer |
| Lightning | [Blitzortung.org](https://www.blitzortung.org) community network, free for private non-commercial use |
| Basemaps | Esri, NASA GIBS |

**Rebuilding the data.** `python scripts/fetch_ens.py` downloads the current ENS files by name, because the links change on every republish. Then run `scripts/build_ens.py` with the paths it prints. It needs `pandas`, `numpy` and `openpyxl`. The UTM → lat/lon conversion is built in, so `pyproj` is not needed, and I checked it against `pyproj` to under a micrometre. Without the older workbooks the archive only has monthly data from 2023.

How the build works, because some of it is non-obvious:
- **Master list** = ENS *Vinddata* first, then the older ENS workbooks, then *Historiske vinddata*. Turbines the register can't place (all micro turbines, ≤ 11 kW, 0.3% of capacity) are placed from OpenStreetMap (DKwindturbinemap) by GSRN where possible.
- **Park-level production.** 252 parks (4.3 GW, including Thor, Horns Rev 3 and Kriegers Flak) report only per park. Their production is spread over the turbines in operation that month, in proportion to capacity.
- **Header quirk.** In *Vinddata* the "Kommune" and "Type af placering" headers are swapped relative to the data. The build detects the columns by content. In the old monthly workbook the 2012 sheet has twelve identical month headers, so months are assigned by position.
- **Validation.** National annual totals match the official ENS overview tables to 1.000 for 1980–2020, 0.999 for 2022 and 0.986 for 2023. The only estimate in that stretch is the park-level split.

## Wake analysis

Zoom to within about 70 km of a wind farm (one or two zoom levels above a single farm) and the **wake analysis** turns on (layer switch on the left). It uses the hub-height wind speed *and direction* of the timeline you're looking at, so scrubbing to tomorrow's forecast re-runs the wakes.

- **Model:** the Niayifar & Porté-Agel (2016) Gaussian wake (Bastankhah & Porté-Agel deficit, turbulence-dependent expansion, TI 6% offshore / 11% onshore), squared-sum superposition, and effective wind speed propagated downstream. It runs in a web worker. The densest neighbourhoods in the data have 80–150 turbines and solve in 1–21 ms including the overlay.
- **Output:** a ground overlay of the wake deficit, per-turbine wake-adjusted output (billboard colours, rotor speed, the selection card), gross → net MW, wake loss, and efficiency by row.
- **Validation:** `python scripts/wake_validate.py` (needs `pip install py_wake`) runs PyWake's `NiayifarGaussianDeficit` + `SquaredSum` + `PropagateDownwind` on the real Horns Rev 1 layout against `src/wakecore.js`, for 25 wind speed and direction cases. Worst farm-power difference: **0.32%**; worst single-turbine speed difference: 0.06 m/s.
- **Limits:** thrust and power curves are generic (scaled by rated power), not the manufacturers'. There's no wake deflection or added turbulence, and the site is flat with uniform stability. Treat it as a fast, validated engineering estimate, not a bankable energy yield.

## Performance

- Billboards are only touched when their colour or visibility actually changes. An archive frame costs about 1–2 ms of CPU and a wind update about 2 ms. Wind particles are re-projected by a typed-array loop (about 2 ms per frame).
- Heavy work goes off the main thread: the wake model runs in a worker.
- **Adaptive quality** watches the real frame rate and steps down bloom → MSAA/resolution → fewer particles and 3D models, then back up when there's headroom. Click the FPS readout to switch between AUTO, HIGH and LOW, or use `?q=high` / `?q=low` in the URL.
- I could only measure CPU cost in a software-rendered browser. The governor's behaviour was checked there, but real GPU frame rates depend on your machine.

## Hosting it online (free)

Streamlit Community Cloud only runs Streamlit apps, so it isn't an option. DK WIND is static files plus one tiny proxy for the Energinet prices, so any of these work. Put the folder in a GitHub repo first (`git init`, commit, push), then:

| Host | How | Notes |
|---|---|---|
| **Render** (easiest) | New → *Blueprint* → pick the repo (uses `render.yaml`), or New → *Web Service* with start command `python serve.py` | Runs `serve.py` unchanged. The free tier sleeps when idle, so the first visit after a pause takes about a minute. |
| **Cloudflare Pages** | Connect the repo, framework preset *None*, build command empty, output directory `/` | Always on and fast. `functions/eds/[dataset].js` replaces the proxy automatically. I haven't deployed this one. |
| **Hugging Face Spaces** | New Space → SDK *Docker* → push the repo (uses `Dockerfile`) | Runs `serve.py` unchanged, but Docker Spaces need a paid PRO plan (only Static Spaces are free, and those can't run the price proxy). |

Everything else runs in the visitor's browser. Open-Meteo is called from each visitor's own IP, so they use their own free quota. The proxy cache is shared, which keeps Energinet traffic low however many people visit.

Keep it **non-commercial and credited**: Open-Meteo's free tier, Blitzortung and the Esri imagery are all licensed for that, and the footer already carries the attributions.

## Things worth knowing

- **Why `serve.py`?** Energinet's API returns an empty response to any request carrying an `Origin` header, which every browser cross-origin call does. `serve.py` proxies three datasets (allow-listed, cached, spaced out). Hosting elsewhere needs an equivalent proxy at `/eds/`.
- **Exchange sign:** in `PowerSystemRightNow`, negative means Denmark exports. I checked this against day-ahead price spreads.
- **Open-Meteo's free tier** is rate-limited and sometimes slow or overloaded. Weather is cached in `localStorage` (10 min for the current frame, 3 h for the forecast), startup never waits for it, and the app retries.
- **The modelled live output** has no wake, curtailment or availability data in the *whole-fleet* number in the header. Compare it with the Energinet figure next to it. The wake analysis only adjusts the farm in view.
- **Interconnector arcs** are schematic (station → station), not cable routes.
- **Esri's satellite layer** serves a grey "no data" tile far offshore at high zoom. `src/globe.js` swaps those for the sea colour.
- **Not included:** cyclone tracks, flights and ships.

## Layout

```
serve.py            static server + Energinet proxy
index.html, style.css
src/main.js         boot, UI wiring, timelines, cards
src/turbines.js     sprites, 3D models, farms, live / archive / wake colouring
src/archive.js      history matrix, national charts, sparklines
src/wake.js         farm-level wake analysis (UI + overlay)    src/wakecore.js  the model (shared with Node)
src/wake-worker.js  worker wrapper
src/lightning.js    Blitzortung feed
src/perf.js         adaptive quality
src/weather.js, windflow.js, energy.js, links.js, globe.js, looks.js, model.js
scripts/            fetch_ens.py, build_ens.py, wake_validate.py (+ .mjs)
data/               turbines.json, history.bin, history.json, turbines_source.csv (OSM)
```

*Visual language inspired by God's Eye View by Bilawal Sidhu (MIT); no code is shared.*
