// Cesium viewer, basemaps and camera helpers.
const C = window.Cesium;

const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services';
const BASEMAPS = {
  sat:   { layers: [{ url: `${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`, max: 18, noDataFix: true, credit: 'Esri, Maxar, Earthstar Geographics', adj: { brightness: 1.0, saturation: 0.88, contrast: 1.06 } }] },
  dark:  { layers: [{ url: `${ESRI}/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`, max: 16, credit: 'Esri, HERE, Garmin' },
                    { url: `${ESRI}/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}`, max: 16, credit: 'Esri' }] },
  night: { layers: [{ url: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png', max: 8, credit: 'NASA GIBS / VIIRS Black Marble' },
                    { url: `${ESRI}/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}`, max: 16, credit: 'Esri' }] },
};

export function createViewer(el) {
  C.Ion.defaultAccessToken = '';
  const viewer = new C.Viewer(el, {
    baseLayer: false,
    baseLayerPicker: false, geocoder: false, homeButton: false, sceneModePicker: false, navigationHelpButton: false,
    animation: false, timeline: false, fullscreenButton: false, infoBox: false, selectionIndicator: false, vrButton: false,
    terrainProvider: new C.EllipsoidTerrainProvider(),
    shouldAnimate: true, msaaSamples: 4,
    contextOptions: { webgl: { alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: true } },
  });
  const scene = viewer.scene;
  viewer.resolutionScale = Math.min(window.devicePixelRatio || 1, 1.5);
  scene.globe.baseColor = C.Color.fromCssColorString('#0b2333');
  scene.backgroundColor = C.Color.fromCssColorString('#02040a');
  scene.globe.enableLighting = false;
  scene.globe.showGroundAtmosphere = true;
  scene.globe.atmosphereLightIntensity = 14;
  scene.globe.atmosphereBrightnessShift = -0.1;
  scene.globe.maximumScreenSpaceError = 1.6;
  scene.skyAtmosphere.show = true;
  scene.skyAtmosphere.brightnessShift = -0.15;
  scene.fog.enabled = true; scene.fog.density = 1.2e-4; scene.fog.minimumBrightness = 0.04;
  scene.light = new C.SunLight();
  scene.screenSpaceCameraController.minimumZoomDistance = 30;
  scene.screenSpaceCameraController.maximumZoomDistance = 3.5e7;
  scene.screenSpaceCameraController.inertiaZoom = 0.82;

  // gentle bloom so glowing turbine sprites, arcs and particles bleed a little
  const b = scene.postProcessStages.bloom;
  b.enabled = true;
  b.uniforms.glowOnly = false; b.uniforms.contrast = 118; b.uniforms.brightness = -0.28;
  b.uniforms.delta = 1.1; b.uniforms.sigma = 3.2; b.uniforms.stepSize = 1.6;

  viewer.clock.currentTime = C.JulianDate.now();
  return viewer;
}

// ── basemap ────────────────────────────────────────────────────────────────────
let baseLayers = [];

// Far offshore Esri serves a flat grey 'Map data not yet available' tile from zoom 14 up (it looks like a white sea next to the
// turbines). Swap those placeholders for the same dark sea colour the real open-ocean tiles have.
let seaTile = null;
function seaCanvas() {
  if (seaTile) return seaTile;
  seaTile = document.createElement('canvas'); seaTile.width = seaTile.height = 256;
  const g = seaTile.getContext('2d'); g.fillStyle = 'rgb(9,33,45)'; g.fillRect(0, 0, 256, 256); return seaTile;
}
function fixNoData(provider) {
  const orig = provider.requestImage.bind(provider), probe = document.createElement('canvas'); probe.width = probe.height = 8;
  const pg = probe.getContext('2d', { willReadFrequently: true });
  provider.requestImage = async function (x, y, level, request) {
    const img = await orig(x, y, level, request);
    if (!img || level < 13) return img;
    try {
      pg.drawImage(img, 0, 0, 8, 8); const d = pg.getImageData(0, 0, 8, 8).data; let grey = 0;     // the placeholder carries a little text, so test 'mostly grey'
      for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - 204) <= 12 && Math.abs(d[i + 1] - 204) <= 12 && Math.abs(d[i + 2] - 204) <= 12) grey++;
      return grey >= 52 ? seaCanvas() : img;
    } catch { return img; }
  };
  return provider;
}
export function setBasemap(viewer, key) {
  const def = BASEMAPS[key] || BASEMAPS.sat;
  baseLayers.forEach(l => viewer.imageryLayers.remove(l, true));
  baseLayers = def.layers.map((d, i) => {
    let prov = new C.UrlTemplateImageryProvider({ url: d.url, maximumLevel: d.max, credit: d.credit });
    if (d.noDataFix) prov = fixNoData(prov);
    const layer = viewer.imageryLayers.addImageryProvider(prov, i);
    Object.assign(layer, d.adj || {});
    return layer;
  });
  viewer.scene.globe.showGroundAtmosphere = key !== 'night';
}

// ── camera helpers ─────────────────────────────────────────────────────────────
export function flyToView(viewer, { lon, lat, h, heading = 0, pitch = -50 }, dur = 3) {
  return new Promise(res => {
    // aim the *look-at point* at (lon,lat): back the camera off along the heading
    const range = h / Math.sin(Math.max(0.2, -pitch * Math.PI / 180));
    const target = C.Cartesian3.fromDegrees(lon, lat, 0);
    viewer.camera.flyToBoundingSphere(new C.BoundingSphere(target, 1), {
      duration: dur,
      offset: new C.HeadingPitchRange(C.Math.toRadians(heading), C.Math.toRadians(pitch), range),
      complete: res, cancel: res,
      easingFunction: C.EasingFunction.CUBIC_IN_OUT,
    });
  });
}

export function setView(viewer, { lon, lat, h, heading = 0, pitch = -90 }) {
  viewer.camera.setView({ destination: C.Cartesian3.fromDegrees(lon, lat, h), orientation: { heading: C.Math.toRadians(heading), pitch: C.Math.toRadians(pitch), roll: 0 } });
}

/** Ground point under the screen centre (falls back to the camera's sub-point). */
export function centerGround(viewer) {
  const sc = viewer.scene.canvas;
  const p = viewer.camera.pickEllipsoid(new C.Cartesian2(sc.clientWidth / 2, sc.clientHeight / 2), viewer.scene.globe.ellipsoid);
  const carto = p ? C.Cartographic.fromCartesian(p) : viewer.camera.positionCartographic;
  return { lon: C.Math.toDegrees(carto.longitude), lat: C.Math.toDegrees(carto.latitude), hit: !!p };
}

export function cameraState(viewer) {
  const c = viewer.camera.positionCartographic;
  return { lon: C.Math.toDegrees(c.longitude), lat: C.Math.toDegrees(c.latitude), h: c.height,
    heading: C.Math.toDegrees(viewer.camera.heading), pitch: C.Math.toDegrees(viewer.camera.pitch) };
}

/** Orbit the camera around a ground point until stopped. Returns stop(). */
export function startOrbit(viewer, lon, lat, range, pitchDeg = -32, rate = 0.12) {
  const center = C.Cartesian3.fromDegrees(lon, lat, 40);
  let heading = viewer.camera.heading;
  const frame = C.Transforms.eastNorthUpToFixedFrame(center);
  const tick = (scene, time) => {
    heading += C.Math.toRadians(rate);
    viewer.camera.lookAtTransform(frame, new C.HeadingPitchRange(heading, C.Math.toRadians(pitchDeg), range));
  };
  viewer.camera.lookAtTransform(frame, new C.HeadingPitchRange(heading, C.Math.toRadians(pitchDeg), range));
  viewer.scene.preRender.addEventListener(tick);
  return () => {
    viewer.scene.preRender.removeEventListener(tick);
    viewer.camera.lookAtTransform(C.Matrix4.IDENTITY);
  };
}
