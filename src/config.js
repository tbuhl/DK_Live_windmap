// Static configuration: weather grid, interconnector geometry, camera presets.

// Open-Meteo sampling grid (one request = 210 cells). Covers Denmark incl. Bornholm and the Danish North Sea.
export const GRID = { lon0: 7.5, lat0: 54.5, dlon: 0.4, dlat: 0.4, nx: 21, ny: 10 };
export const GRID_RECT = {
  west: GRID.lon0, east: GRID.lon0 + GRID.dlon * (GRID.nx - 1),
  south: GRID.lat0, north: GRID.lat0 + GRID.dlat * (GRID.ny - 1),
};

// Energinet's PowerSystemRightNow convention (verified against day-ahead spreads):
//   Exchange_* < 0  → Denmark EXPORTS      Exchange_* > 0  → Denmark IMPORTS
// `a` = Danish landing / converter station, `b` = foreign end. [lon, lat]
export const LINKS = [
  { id: 'NO',  key: 'Exchange_DK1_NO',     name: 'Skagerrak',   far: 'Norway',  areaDK: 'DK1', areaFar: 'NO2', cap: 1700, a: [9.58, 56.47],  b: [8.00, 58.16],  lift: 0.10 },
  { id: 'SE1', key: 'Exchange_DK1_SE',     name: 'Konti-Skan',  far: 'Sweden',  areaDK: 'DK1', areaFar: 'SE3', cap: 740,  a: [10.02, 57.10], b: [12.08, 57.58], lift: 0.12 },
  { id: 'DE1', key: 'Exchange_DK1_DE',     name: 'DK1–DE',      far: 'Germany', areaDK: 'DK1', areaFar: 'DE',  cap: 2500, a: [9.10, 55.00],  b: [9.67, 54.20],  lift: 0.12 },
  { id: 'NL',  key: 'Exchange_DK1_NL',     name: 'COBRAcable',  far: 'Netherl.', areaDK: 'DK1', areaFar: null, cap: 700,  a: [8.70, 55.53],  b: [6.84, 53.44],  lift: 0.10 },
  { id: 'GB',  key: 'Exchange_DK1_GB',     name: 'Viking Link', far: 'Gr. Britain', areaDK: 'DK1', areaFar: null, cap: 1400, a: [9.10, 55.43], b: [-0.07, 52.96], lift: 0.09 },
  { id: 'BELT', key: 'Exchange_DK1_DK2',   name: 'Great Belt',  far: 'DK2',     areaDK: 'DK1', areaFar: 'DK2', cap: 600,  a: [10.37, 55.37], b: [11.20, 55.42], lift: 0.20 },
  { id: 'DE2', key: 'Exchange_DK2_DE',     name: 'Kontek / KF', far: 'Germany', areaDK: 'DK2', areaFar: 'DE',  cap: 1100, a: [12.07, 55.45], b: [12.20, 54.15], lift: 0.12 },
  { id: 'SE2', key: 'Exchange_DK2_SE',     name: 'Øresund',     far: 'Sweden',  areaDK: 'DK2', areaFar: 'SE4', cap: 1300, a: [12.33, 55.66], b: [12.93, 55.76], lift: 0.20 },
  { id: 'BO',  key: 'Exchange_Bornholm_SE', name: 'Bornholm',   far: 'Sweden',  areaDK: 'DK2', areaFar: 'SE4', cap: 60,   a: [14.70, 55.10], b: [14.17, 55.45], lift: 0.20 },
];

// Where each price area's chip sits on the map (foreign areas sit at the far end of their link).
export const AREA_CHIPS = {
  DK1: [9.35, 56.15], DK2: [11.75, 55.30],
};

export const PRESETS = [
  { n: 'DENMARK',      lon: 10.4, lat: 55.9, h: 760000, pitch: -52 },
  { n: 'HORNS REV',    lon: 7.70, lat: 55.60, h: 16000,  pitch: -36, heading: 20 },
  { n: 'THOR',         lon: 7.69, lat: 56.34, h: 11000,  pitch: -34, heading: 330 },
  { n: 'ANHOLT',       lon: 11.22, lat: 56.60, h: 9000, pitch: -34, heading: 200 },
  { n: 'KRIEGERS FLAK', lon: 12.91, lat: 55.025, h: 12000, pitch: -34, heading: 300 },
  { n: 'MIDDELGRUNDEN', lon: 12.67, lat: 55.69, h: 4500, pitch: -30, heading: 100 },
  { n: 'HØVSØRE',      lon: 8.15, lat: 56.44, h: 6500, pitch: -30, heading: 270 },
  { n: 'RØDSAND',      lon: 11.63, lat: 54.55, h: 12000, pitch: -36, heading: 0 },
  { n: 'COPENHAGEN',   lon: 12.57, lat: 55.68, h: 60000, pitch: -45 },
];

export const CITIES = [
  ['Copenhagen', 12.568, 55.676], ['Aarhus', 10.204, 56.157], ['Aalborg', 9.921, 57.048], ['Odense', 10.388, 55.396],
  ['Esbjerg', 8.452, 55.476], ['Thyborøn', 8.21, 56.70], ['Skagen', 10.59, 57.72], ['Rønne', 14.70, 55.10],
  ['Hirtshals', 9.96, 57.59], ['Fredericia', 9.75, 55.57], ['Kolding', 9.47, 55.49], ['Roskilde', 12.08, 55.64],
];

export const TOUR = ['DENMARK', 'HORNS REV', 'THOR', 'ANHOLT', 'KRIEGERS FLAK', 'MIDDELGRUNDEN', 'RØDSAND', 'DENMARK'];

// Well-known Danish wind farms used to name turbine groups (the OSM cluster names are operator-based).
// [name, lon, lat, radius km]
export const FARMS = [
  ['Horns Rev 1', 7.84, 55.486, 4], ['Horns Rev 2', 7.585, 55.60, 4], ['Horns Rev 3', 7.656, 55.695, 4.5], ['Thor', 7.688, 56.342, 6.5],
  ['Vesterhav Syd', 7.954, 56.079, 3.5], ['Vesterhav Nord', 8.026, 56.593, 3.5], ['Anholt', 11.217, 56.601, 6], ['Kriegers Flak', 12.905, 55.025, 7],
  ['Rødsand 2', 11.544, 54.557, 4.5], ['Nysted (Rødsand 1)', 11.714, 54.547, 4.5], ['Middelgrunden', 12.67, 55.69, 3], ['Avedøre Holme', 12.46, 55.60, 2],
  ['Samsø Offshore', 10.58, 55.72, 3], ['Tunø Knob', 10.35, 55.97, 2], ['Vindeby', 11.12, 54.96, 3], ['Sprogø', 10.96, 55.343, 2.5],
  ['Frederikshavn', 10.57, 57.44, 3], ['Høvsøre', 8.15, 56.44, 4],
];

export const GEN_COLORS = {
  offshore: '#4a8dff', onshore: '#5ee1ff', solar: '#ffd23f', central: '#ff7a45', local: '#b48cff',
};
