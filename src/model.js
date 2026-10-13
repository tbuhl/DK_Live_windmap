// Procedural wind-turbine glTF (Z-up, +X = rotor axis). Three nodes: tower / nacelle / rotor.
// Dimensions are unit-sized and positioned per turbine via node matrices (see turbines.js).

function norm(v) { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

class Mesh {
  constructor() { this.p = []; this.n = []; this.i = []; }
  tri(a, b, c) {
    const n = norm(cross(sub(b, a), sub(c, a))), base = this.p.length / 3;
    this.p.push(...a, ...b, ...c); this.n.push(...n, ...n, ...n); this.i.push(base, base + 1, base + 2);
  }
  quad(a, b, c, d) { this.tri(a, b, c); this.tri(a, c, d); }
}

function tower() {
  const m = new Mesh(), N = 20, r0 = 1, r1 = 0.52;
  for (let k = 0; k < N; k++) {
    const a0 = (k / N) * Math.PI * 2, a1 = ((k + 1) / N) * Math.PI * 2, base = m.p.length / 3;
    const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
    m.p.push(c0 * r0, s0 * r0, 0, c1 * r0, s1 * r0, 0, c1 * r1, s1 * r1, 1, c0 * r1, s0 * r1, 1);
    const n0 = norm([c0, s0, 0.12]), n1 = norm([c1, s1, 0.12]);
    m.n.push(...n0, ...n1, ...n1, ...n0);
    m.i.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return m;
}

function nacelle() {   // unit box centred on origin
  const m = new Mesh(), h = 0.5;
  const v = [[-h, -h, -h], [h, -h, -h], [h, h, -h], [-h, h, -h], [-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h]];
  const f = (a, b, c, d) => m.quad(v[a], v[b], v[c], v[d]);
  f(0, 3, 2, 1); f(4, 5, 6, 7); f(0, 1, 5, 4); f(2, 3, 7, 6); f(1, 2, 6, 5); f(3, 0, 4, 7);
  return m;
}

function rotor() {   // unit radius: 3 tapered blades along local Z, rotated about X, plus a spinner
  const m = new Mesh();
  const root = [[0.022, 0], [0, 0.012], [-0.07, 0], [0, -0.012]];
  const tip = root.map(([x, y]) => [x * 0.16 - 0.012, y * 0.4]);
  for (let b = 0; b < 3; b++) {
    const a = (b / 3) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
    const T = (x, y, z) => [x, y * ca - z * sa, y * sa + z * ca];
    const r = root.map(([x, y]) => T(x, y, 0.045)), t = tip.map(([x, y]) => T(x, y, 1));
    for (let k = 0; k < 4; k++) { const j = (k + 1) % 4; m.quad(r[k], r[j], t[j], t[k]); }
    m.quad(t[3], t[2], t[1], t[0]);
  }
  const N = 14, apex = [0.14, 0, 0];
  for (let k = 0; k < N; k++) {
    const a0 = (k / N) * Math.PI * 2, a1 = ((k + 1) / N) * Math.PI * 2;
    m.tri([0, Math.cos(a0) * 0.05, Math.sin(a0) * 0.05], apex, [0, Math.cos(a1) * 0.05, Math.sin(a1) * 0.05]);
  }
  return m;
}

function b64(u8) {
  let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

export function buildTurbineGltf() {
  const meshes = [tower(), nacelle(), rotor()];
  const mats = [[0.93, 0.95, 0.97], [0.8, 0.83, 0.87], [0.97, 0.97, 0.98]];
  const chunks = [], views = [], accessors = [];
  let off = 0;
  const push = (arr, target, comp, type, count, extra = {}) => {
    const bytes = new Uint8Array(arr.buffer);
    views.push({ buffer: 0, byteOffset: off, byteLength: bytes.length, target });
    accessors.push({ bufferView: views.length - 1, componentType: comp, count, type, ...extra });
    chunks.push(bytes); off += bytes.length;
    if (off % 4) { const padN = 4 - (off % 4); chunks.push(new Uint8Array(padN)); off += padN; }
    return accessors.length - 1;
  };
  const gltfMeshes = meshes.map((m, k) => {
    const pos = new Float32Array(m.p), nor = new Float32Array(m.n), idx = new Uint16Array(m.i);
    const mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
    for (let i = 0; i < pos.length; i += 3) for (let a = 0; a < 3; a++) { mn[a] = Math.min(mn[a], pos[i + a]); mx[a] = Math.max(mx[a], pos[i + a]); }
    const ap = push(pos, 34962, 5126, 'VEC3', pos.length / 3, { min: mn, max: mx });
    const an = push(nor, 34962, 5126, 'VEC3', nor.length / 3);
    const ai = push(idx, 34963, 5123, 'SCALAR', idx.length);
    return { primitives: [{ attributes: { POSITION: ap, NORMAL: an }, indices: ai, material: k }] };
  });
  const buf = new Uint8Array(off); let o = 0; chunks.forEach(c => { buf.set(c, o); o += c.length; });
  return {
    asset: { version: '2.0', generator: 'dk-wind-godseye' },
    scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ name: 'root', children: [1, 2, 3] }, { name: 'tower', mesh: 0 }, { name: 'nacelle', mesh: 1 }, { name: 'rotor', mesh: 2 }],
    meshes: gltfMeshes,
    materials: mats.map(c => ({ doubleSided: true, pbrMetallicRoughness: { baseColorFactor: [...c, 1], metallicFactor: 0.05, roughnessFactor: 0.55 } })),
    accessors, bufferViews: views,
    buffers: [{ byteLength: buf.length, uri: 'data:application/octet-stream;base64,' + b64(buf) }],
  };
}

export function turbineModelUrl() {
  const json = JSON.stringify(buildTurbineGltf());
  return URL.createObjectURL(new Blob([json], { type: 'model/gltf+json' }));
}
