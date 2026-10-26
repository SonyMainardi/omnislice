import type { Mat4, Vec3 } from "./math";

/** Malha triangular indexada. Coordenadas em milímetros; triângulos em ordem CCW vistos de fora. */
export interface IndexedMesh {
  positions: Float32Array;
  indices: Uint32Array;
}

export interface Bounds {
  min: Vec3;
  max: Vec3;
}

export const triCount = (m: IndexedMesh): number => m.indices.length / 3;
export const vertCount = (m: IndexedMesh): number => m.positions.length / 3;

export function computeBounds(positions: ArrayLike<number>): Bounds {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  if (min[0] === Infinity) return { min: [0, 0, 0], max: [0, 0, 0] };
  return { min, max };
}

export const boundsSize = (b: Bounds): Vec3 => [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
export const boundsDiagonal = (b: Bounds): number => Math.hypot(...boundsSize(b));

/**
 * Solda uma "sopa" de triângulos (9 floats por triângulo) em uma malha indexada.
 * Vértices dentro de `tolerance` (mm) viram um só; por padrão a tolerância é relativa ao tamanho do modelo.
 */
export function weldSoup(soup: Float32Array, tolerance?: number): IndexedMesh {
  const nTri = Math.floor(soup.length / 9);
  const bounds = computeBounds(soup);
  const diag = Math.max(boundsDiagonal(bounds), 1e-9);
  const tol = tolerance ?? Math.max(diag * 1e-7, 1e-6);
  const inv = 1 / tol;
  const nVertIn = nTri * 3;
  let cap = 1;
  while (cap < nVertIn * 2) cap <<= 1;
  const mask = cap - 1;
  const table = new Int32Array(cap).fill(-1);
  const keys = new Int32Array(nVertIn * 3);
  const outPos = new Float32Array(nVertIn * 3);
  const indices = new Uint32Array(nVertIn);
  let nOut = 0;
  for (let i = 0; i < nVertIn; i++) {
    const x = soup[i * 3];
    const y = soup[i * 3 + 1];
    const z = soup[i * 3 + 2];
    const kx = Math.round(x * inv) | 0;
    const ky = Math.round(y * inv) | 0;
    const kz = Math.round(z * inv) | 0;
    let h = (Math.imul(kx, 73856093) ^ Math.imul(ky, 19349663) ^ Math.imul(kz, 83492791)) & mask;
    let found = -1;
    while (table[h] !== -1) {
      const id = table[h];
      if (keys[id * 3] === kx && keys[id * 3 + 1] === ky && keys[id * 3 + 2] === kz) {
        found = id;
        break;
      }
      h = (h + 1) & mask;
    }
    if (found === -1) {
      found = nOut++;
      table[h] = found;
      keys[found * 3] = kx;
      keys[found * 3 + 1] = ky;
      keys[found * 3 + 2] = kz;
      outPos[found * 3] = x;
      outPos[found * 3 + 1] = y;
      outPos[found * 3 + 2] = z;
    }
    indices[i] = found;
  }
  return { positions: outPos.slice(0, nOut * 3), indices };
}

/** Converte para sopa de triângulos (3 vértices por face), útil para renderização por face. */
export function toSoup(m: IndexedMesh): Float32Array {
  const out = new Float32Array(m.indices.length * 3);
  for (let i = 0; i < m.indices.length; i++) {
    const v = m.indices[i] * 3;
    out[i * 3] = m.positions[v];
    out[i * 3 + 1] = m.positions[v + 1];
    out[i * 3 + 2] = m.positions[v + 2];
  }
  return out;
}

export function faceNormalsAndAreas(m: IndexedMesh): { normals: Float32Array; areas: Float32Array } {
  const n = triCount(m);
  const normals = new Float32Array(n * 3);
  const areas = new Float32Array(n);
  const p = m.positions;
  for (let f = 0; f < n; f++) {
    const a = m.indices[f * 3] * 3;
    const b = m.indices[f * 3 + 1] * 3;
    const c = m.indices[f * 3 + 2] * 3;
    const ux = p[b] - p[a];
    const uy = p[b + 1] - p[a + 1];
    const uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a];
    const vy = p[c + 1] - p[a + 1];
    const vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    areas[f] = l / 2;
    if (l > 0) {
      normals[f * 3] = nx / l;
      normals[f * 3 + 1] = ny / l;
      normals[f * 3 + 2] = nz / l;
    }
  }
  return { normals, areas };
}

export function faceCentroids(m: IndexedMesh): Float32Array {
  const n = triCount(m);
  const out = new Float32Array(n * 3);
  const p = m.positions;
  for (let f = 0; f < n; f++) {
    const a = m.indices[f * 3] * 3;
    const b = m.indices[f * 3 + 1] * 3;
    const c = m.indices[f * 3 + 2] * 3;
    for (let k = 0; k < 3; k++) out[f * 3 + k] = (p[a + k] + p[b + k] + p[c + k]) / 3;
  }
  return out;
}

export function signedVolume(m: IndexedMesh): number {
  const p = m.positions;
  let v = 0;
  for (let f = 0; f < m.indices.length; f += 3) {
    const a = m.indices[f] * 3;
    const b = m.indices[f + 1] * 3;
    const c = m.indices[f + 2] * 3;
    v +=
      p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) -
      p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
      p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return v / 6;
}

export function surfaceArea(m: IndexedMesh): number {
  const { areas } = faceNormalsAndAreas(m);
  let s = 0;
  for (let i = 0; i < areas.length; i++) s += areas[i];
  return s;
}

/**
 * Tabela de arestas. Meia-aresta h = 3f + i vai de indices[3f+i] para indices[3f+(i+1)%3].
 * Cada aresta não orientada recebe um id; `twin[h]` é a outra meia-aresta quando a aresta é manifold.
 */
export interface EdgeTable {
  numEdges: number;
  edgeOfHalf: Uint32Array;
  /** Número de meias-arestas por aresta (1 = borda, 2 = manifold, >2 = não-manifold). */
  edgeCount: Uint32Array;
  /** Primeira meia-aresta de cada aresta. */
  edgeFirst: Uint32Array;
  /** Meia-aresta oposta, ou -1 (borda) / -2 (aresta não-manifold). */
  twin: Int32Array;
}

export function buildEdgeTable(m: IndexedMesh): EdgeTable {
  const idx = m.indices;
  const nHalf = idx.length;
  let cap = 1;
  while (cap < nHalf * 2) cap <<= 1;
  const mask = cap - 1;
  const table = new Int32Array(cap).fill(-1);
  const edgeA = new Uint32Array(nHalf);
  const edgeB = new Uint32Array(nHalf);
  const edgeOfHalf = new Uint32Array(nHalf);
  const edgeCount = new Uint32Array(nHalf);
  const edgeFirst = new Uint32Array(nHalf);
  const edgeSecond = new Int32Array(nHalf).fill(-1);
  let numEdges = 0;
  for (let h = 0; h < nHalf; h++) {
    const f = (h / 3) | 0;
    const i = h - f * 3;
    const va = idx[h];
    const vb = idx[f * 3 + ((i + 1) % 3)];
    const lo = va < vb ? va : vb;
    const hi = va < vb ? vb : va;
    let s = (Math.imul(lo, 0x9e3779b1) ^ Math.imul(hi, 0x85ebca77)) & mask;
    let e = -1;
    while (table[s] !== -1) {
      const id = table[s];
      if (edgeA[id] === lo && edgeB[id] === hi) {
        e = id;
        break;
      }
      s = (s + 1) & mask;
    }
    if (e === -1) {
      e = numEdges++;
      table[s] = e;
      edgeA[e] = lo;
      edgeB[e] = hi;
      edgeFirst[e] = h;
    } else if (edgeCount[e] === 1) {
      edgeSecond[e] = h;
    }
    edgeCount[e]++;
    edgeOfHalf[h] = e;
  }
  const twin = new Int32Array(nHalf);
  for (let h = 0; h < nHalf; h++) {
    const e = edgeOfHalf[h];
    const c = edgeCount[e];
    if (c === 1) twin[h] = -1;
    else if (c === 2) twin[h] = edgeFirst[e] === h ? edgeSecond[e] : edgeFirst[e];
    else twin[h] = -2;
  }
  return {
    numEdges,
    edgeOfHalf,
    edgeCount: edgeCount.slice(0, numEdges),
    edgeFirst: edgeFirst.slice(0, numEdges),
    twin,
  };
}

/** Vizinho de cada face pelas 3 arestas (-1 se borda ou não-manifold). */
export function faceNeighbors(m: IndexedMesh, edges = buildEdgeTable(m)): Int32Array {
  const out = new Int32Array(m.indices.length);
  for (let h = 0; h < out.length; h++) {
    const t = edges.twin[h];
    out[h] = t >= 0 ? (t / 3) | 0 : -1;
  }
  return out;
}

export const halfEdgeFrom = (m: IndexedMesh, h: number): number => m.indices[h];
export const halfEdgeTo = (m: IndexedMesh, h: number): number => {
  const f = (h / 3) | 0;
  return m.indices[f * 3 + ((h - f * 3 + 1) % 3)];
};

/** Rótulo de componente conexo por face (conectividade por aresta). */
export function faceComponents(m: IndexedMesh, neighbors = faceNeighbors(m)): { count: number; comp: Int32Array } {
  const n = triCount(m);
  const comp = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  let count = 0;
  for (let s = 0; s < n; s++) {
    if (comp[s] !== -1) continue;
    let top = 0;
    stack[top++] = s;
    comp[s] = count;
    while (top > 0) {
      const f = stack[--top];
      for (let k = 0; k < 3; k++) {
        const g = neighbors[f * 3 + k];
        if (g >= 0 && comp[g] === -1) {
          comp[g] = count;
          stack[top++] = g;
        }
      }
    }
    count++;
  }
  return { count, comp };
}

/** Extrai as faces marcadas em uma nova malha compacta. `faceMap[i]` = face original. */
export function subsetMesh(m: IndexedMesh, keep: (f: number) => boolean): { mesh: IndexedMesh; faceMap: Uint32Array } {
  const n = triCount(m);
  const remap = new Int32Array(vertCount(m)).fill(-1);
  const faces: number[] = [];
  for (let f = 0; f < n; f++) if (keep(f)) faces.push(f);
  const indices = new Uint32Array(faces.length * 3);
  let nv = 0;
  const pos: number[] = [];
  faces.forEach((f, i) => {
    for (let k = 0; k < 3; k++) {
      const v = m.indices[f * 3 + k];
      if (remap[v] === -1) {
        remap[v] = nv++;
        pos.push(m.positions[v * 3], m.positions[v * 3 + 1], m.positions[v * 3 + 2]);
      }
      indices[i * 3 + k] = remap[v];
    }
  });
  return { mesh: { positions: new Float32Array(pos), indices }, faceMap: Uint32Array.from(faces) };
}

export function transformMesh(m: IndexedMesh, mat: Mat4): IndexedMesh {
  const p = m.positions;
  const out = new Float32Array(p.length);
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i];
    const y = p[i + 1];
    const z = p[i + 2];
    out[i] = mat[0] * x + mat[4] * y + mat[8] * z + mat[12];
    out[i + 1] = mat[1] * x + mat[5] * y + mat[9] * z + mat[13];
    out[i + 2] = mat[2] * x + mat[6] * y + mat[10] * z + mat[14];
  }
  // Matrizes com determinante negativo (espelhamento) invertem a orientação dos triângulos.
  const det =
    mat[0] * (mat[5] * mat[10] - mat[9] * mat[6]) -
    mat[4] * (mat[1] * mat[10] - mat[9] * mat[2]) +
    mat[8] * (mat[1] * mat[6] - mat[5] * mat[2]);
  if (det >= 0) return { positions: out, indices: m.indices };
  const idx = new Uint32Array(m.indices.length);
  for (let f = 0; f < idx.length; f += 3) {
    idx[f] = m.indices[f];
    idx[f + 1] = m.indices[f + 2];
    idx[f + 2] = m.indices[f + 1];
  }
  return { positions: out, indices: idx };
}

export function mergeMeshes(meshes: IndexedMesh[]): IndexedMesh {
  let nv = 0;
  let ni = 0;
  for (const m of meshes) {
    nv += m.positions.length;
    ni += m.indices.length;
  }
  const positions = new Float32Array(nv);
  const indices = new Uint32Array(ni);
  let vo = 0;
  let io = 0;
  for (const m of meshes) {
    positions.set(m.positions, vo);
    const base = vo / 3;
    for (let i = 0; i < m.indices.length; i++) indices[io + i] = m.indices[i] + base;
    vo += m.positions.length;
    io += m.indices.length;
  }
  return { positions, indices };
}

