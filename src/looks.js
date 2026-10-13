// Sensor looks as full-screen post-process stages (EO = none).
const C = window.Cesium;

const FLIR = `
uniform sampler2D colorTexture;
in vec2 v_textureCoordinates;
void main() {
  vec3 c = texture(colorTexture, v_textureCoordinates).rgb;
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  l = clamp(pow(l * 1.15, 1.05), 0.0, 1.0);
  vec3 col = vec3(smoothstep(0.30, 0.72, l),
                  smoothstep(0.58, 0.97, l),
                  smoothstep(0.0, 0.30, l) * (1.0 - smoothstep(0.30, 0.66, l)) * 0.85 + smoothstep(0.88, 1.0, l));
  float g = fract(sin(dot(v_textureCoordinates * 900.0, vec2(12.9898, 78.233))) * 43758.5453);
  out_FragColor = vec4(col + (g - 0.5) * 0.03, 1.0);
}`;

const NVG = `
uniform sampler2D colorTexture;
uniform float time;
in vec2 v_textureCoordinates;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec2 uv = v_textureCoordinates;
  vec3 c = texture(colorTexture, uv).rgb;
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  l = pow(clamp(l * 2.1, 0.0, 1.0), 0.62);
  float grain = hash(uv * vec2(1400.0, 800.0) + fract(time) * 37.0);
  l = l * (0.86 + 0.28 * grain);
  vec3 col = vec3(0.10, 1.0, 0.22) * l;
  col += vec3(0.0, 0.05, 0.0) + vec3(0.04, 0.2, 0.05) * pow(l, 3.0);
  out_FragColor = vec4(col, 1.0);
}`;

const CRT = `
uniform sampler2D colorTexture;
uniform float time;
in vec2 v_textureCoordinates;
void main() {
  vec2 uv = v_textureCoordinates, cc = uv - 0.5;
  float r2 = dot(cc, cc);
  uv = 0.5 + cc * (1.0 + 0.10 * r2);
  float ab = 0.0012 + 0.0035 * r2;
  vec3 col = vec3(texture(colorTexture, uv + vec2(ab, 0.0)).r, texture(colorTexture, uv).g, texture(colorTexture, uv - vec2(ab, 0.0)).b);
  float line = 0.80 + 0.20 * sin(uv.y * czm_viewport.w * 3.14159);
  float roll = 0.94 + 0.06 * sin(uv.y * 6.0 - time * 1.7);
  col *= line * roll;
  col = pow(col * 1.1, vec3(0.92)) * vec3(0.96, 1.04, 1.0);
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) col = vec3(0.0);
  out_FragColor = vec4(col, 1.0);
}`;

const NOIR = `
uniform sampler2D colorTexture;
in vec2 v_textureCoordinates;
void main() {
  vec3 c = texture(colorTexture, v_textureCoordinates).rgb;
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  l = smoothstep(0.03, 0.82, l);
  out_FragColor = vec4(vec3(l * 0.96, l * 0.98, l), 1.0);
}`;

import { bus } from './util.js';

export function createLooks(viewer) {
  const stages = viewer.scene.postProcessStages;
  const mk = (name, fs, uniforms) => { const s = new C.PostProcessStage({ name, fragmentShader: fs, uniforms }); s.enabled = false; stages.add(s); return s; };
  const looks = {
    nvg: mk('nvg', NVG, { time: () => performance.now() / 1000 }),
    flir: mk('flir', FLIR),
    crt: mk('crt', CRT, { time: () => performance.now() / 1000 }),
    noir: mk('noir', NOIR),
  };
  let current = 'eo', bloomOK = true;
  const applyBloom = () => { viewer.scene.postProcessStages.bloom.enabled = bloomOK && (current === 'eo' || current === 'crt'); };
  bus.on('perf', L => { bloomOK = L.bloom; applyBloom(); });      // the quality governor can switch bloom off
  return function setLook(key) {
    current = key;
    for (const [k, s] of Object.entries(looks)) s.enabled = k === key;
    document.body.dataset.look = key;
    applyBloom();
  };
}
