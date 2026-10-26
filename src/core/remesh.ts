import type { Wasm } from "./manifoldBridge";
import { type IndexedMesh, computeBounds, faceNormalsAndAreas, triCount } from "./mesh";

/** Ponto mais próximo de p no triângulo abc (Ericson, Real-Time Collision Detection). */
function closestOnTriangle(
  px: number, py: number, pz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  out: Float64Array,
): void {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) { out[0] = ax; out[1] = ay; out[2] = az; return; }
  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) { out[0] = bx; out[1] = by; out[2] = bz; return; }
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    out[0] = ax + abx * v; out[1] = ay + aby * v; out[2] = az + abz * v; return;
  }
  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) { out[0] = cx; out[1] = cy; out[2] = cz; return; }
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const v = d2 / (d2 - d6);
    out[0] = ax + acx * v; out[1] = ay + acy * v; out[2] = az + acz * v; return;
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const v = (d4 - d3) / (d4 - d3 + (d5 - d6));
    out[0] = bx + (cx - bx) * v; out[1] = by + (cy - by) * v; out[2] = bz + (cz - bz) * v; return;
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  out[0] = ax + abx * v + acx * w;
  out[1] = ay + aby * v + acy * w;
  out[2] = az + abz * v + acz * w;
}

/**
 * Reconstrói a malha como um sólido fechado a partir de uma grade de distâncias (voxels).
 * Funciona com malhas quebradas (arestas não-manifold, autointerseções, cascas sobrepostas), desde
 * que os buracos sejam menores que ~2 células. Detalhes menores que a célula são perdidos.
 */
export function voxelRemesh(w: Wasm, mesh: IndexedMesh, resolution: number, progress?: (f: number) => void): IndexedMesh {
  const b = computeBounds(mesh.positions);
  const maxDim = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
  let h = maxDim / resolution;
  const pad = 3;
  const dimsFor = (cell: number) => [0, 1, 2].map((k) => Math.ceil((b.max[k] - b.min[k]) / cell) + 1 + pad * 2);
  let dims = dimsFor(h);
  // Limita a memória da grade (~24M pontos).
  while (dims[0] * dims[1] * dims[2] > 24e6) {
    h *= 1.15;
    dims = dimsFor(h);
  }
  const [nx, ny, nz] = dims;
  const ox = b.min[0] - pad * h;
  const oy = b.min[1] - pad * h;
  const oz = b.min[2] - pad * h;
  const N = nx * ny * nz;
  const band = 1.5 * h;
  const dist = new Float32Array(N).fill(band * 2);
  const sign = new Int8Array(N); // +1 dentro, -1 fora, 0 indefinido
  const { normals } = faceNormalsAndAreas(mesh);
  const p = mesh.positions;
  const idx = mesh.indices;
  const n = triCount(mesh);
  const cp = new Float64Array(3);
  const at = (i: number, j: number, k: number) => i + nx * (j + ny * k);
  const nearSign = new Float32Array(N);
  for (let f = 0; f < n; f++) {
    const a = idx[f * 3] * 3;
    const bb = idx[f * 3 + 1] * 3;
    const c = idx[f * 3 + 2] * 3;
    const minx = Math.min(p[a], p[bb], p[c]) - band;
    const miny = Math.min(p[a + 1], p[bb + 1], p[c + 1]) - band;
    const minz = Math.min(p[a + 2], p[bb + 2], p[c + 2]) - band;
    const maxx = Math.max(p[a], p[bb], p[c]) + band;
    const maxy = Math.max(p[a + 1], p[bb + 1], p[c + 1]) + band;
    const maxz = Math.max(p[a + 2], p[bb + 2], p[c + 2]) + band;
    const i0 = Math.max(0, Math.floor((minx - ox) / h));
    const j0 = Math.max(0, Math.floor((miny - oy) / h));
    const k0 = Math.max(0, Math.floor((minz - oz) / h));
    const i1 = Math.min(nx - 1, Math.ceil((maxx - ox) / h));
    const j1 = Math.min(ny - 1, Math.ceil((maxy - oy) / h));
    const k1 = Math.min(nz - 1, Math.ceil((maxz - oz) / h));
    for (let k = k0; k <= k1; k++)
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          const x = ox + i * h;
          const y = oy + j * h;
          const z = oz + k * h;
          closestOnTriangle(x, y, z, p[a], p[a + 1], p[a + 2], p[bb], p[bb + 1], p[bb + 2], p[c], p[c + 1], p[c + 2], cp);
          const dx = x - cp[0];
          const dy = y - cp[1];
          const dz = z - cp[2];
          const d = Math.hypot(dx, dy, dz);
          const id = at(i, j, k);
          if (d < dist[id]) {
            dist[id] = d;
            nearSign[id] = dx * normals[f * 3] + dy * normals[f * 3 + 1] + dz * normals[f * 3 + 2];
          }
        }
    if (f % 20000 === 0) progress?.(0.5 * (f / n));
  }
  // Inunda o exterior a partir da borda da grade, sem atravessar a faixa próxima da superfície.
  const blocked = (id: number) => dist[id] < h * 0.9;
  const queue = new Int32Array(N);
  let head = 0;
  let tail = 0;
  const pushOut = (id: number) => {
    if (sign[id] !== 0 || blocked(id)) return;
    sign[id] = -1;
    queue[tail++] = id;
  };
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++)
        if (i === 0 || j === 0 || k === 0 || i === nx - 1 || j === ny - 1 || k === nz - 1) pushOut(at(i, j, k));
  while (head < tail) {
    const id = queue[head++];
    const i = id % nx;
    const j = ((id / nx) | 0) % ny;
    const k = (id / (nx * ny)) | 0;
    if (i > 0) pushOut(id - 1);
    if (i < nx - 1) pushOut(id + 1);
    if (j > 0) pushOut(id - nx);
    if (j < ny - 1) pushOut(id + nx);
    if (k > 0) pushOut(id - nx * ny);
    if (k < nz - 1) pushOut(id + nx * ny);
  }
  progress?.(0.6);
  const field = new Float32Array(N);
  for (let id = 0; id < N; id++) {
    if (sign[id] === -1) field[id] = -Math.min(dist[id], band * 2);
    else if (!blocked(id)) field[id] = Math.min(dist[id], band * 2);
    // Perto da superfície o sinal vem da normal da face mais próxima.
    else field[id] = nearSign[id] > 0 ? -dist[id] : dist[id];
  }
  const sdf = (pt: [number, number, number]) => {
    const fx = Math.min(Math.max((pt[0] - ox) / h, 0), nx - 1.0001);
    const fy = Math.min(Math.max((pt[1] - oy) / h, 0), ny - 1.0001);
    const fz = Math.min(Math.max((pt[2] - oz) / h, 0), nz - 1.0001);
    const i = Math.floor(fx);
    const j = Math.floor(fy);
    const k = Math.floor(fz);
    const tx = fx - i;
    const ty = fy - j;
    const tz = fz - k;
    const c00 = field[at(i, j, k)] * (1 - tx) + field[at(i + 1, j, k)] * tx;
    const c10 = field[at(i, j + 1, k)] * (1 - tx) + field[at(i + 1, j + 1, k)] * tx;
    const c01 = field[at(i, j, k + 1)] * (1 - tx) + field[at(i + 1, j, k + 1)] * tx;
    const c11 = field[at(i, j + 1, k + 1)] * (1 - tx) + field[at(i + 1, j + 1, k + 1)] * tx;
    return (c00 * (1 - ty) + c10 * ty) * (1 - tz) + (c01 * (1 - ty) + c11 * ty) * tz;
  };
  const solid = w.Manifold.levelSet(
    sdf,
    { min: [ox, oy, oz], max: [ox + (nx - 1) * h, oy + (ny - 1) * h, oz + (nz - 1) * h] },
    h,
  );
  progress?.(0.95);
  try {
    const out = solid.getMesh();
    return { positions: Float32Array.from(out.vertProperties), indices: Uint32Array.from(out.triVerts) };
  } finally {
    solid.delete();
  }
}
