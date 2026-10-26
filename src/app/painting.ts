import { cleanLabels } from "../core/labels";
import type { Vec3 } from "../core/math";
import { type IndexedMesh, faceCentroids, faceNeighbors, faceNormalsAndAreas } from "../core/mesh";
import type { FaceAttributes } from "../worker/protocol";

export interface PaintContext {
  mesh: IndexedMesh;
  neighbors: Int32Array;
  centroids: Float32Array;
  normals: Float32Array;
  areas: Float32Array;
}

const cache = new WeakMap<IndexedMesh, PaintContext>();

/** Adjacência, centróides e normais da peça (calculados uma vez por malha). */
export function paintContext(mesh: IndexedMesh): PaintContext {
  let ctx = cache.get(mesh);
  if (!ctx) {
    const { normals, areas } = faceNormalsAndAreas(mesh);
    ctx = { mesh, neighbors: faceNeighbors(mesh), centroids: faceCentroids(mesh), normals, areas };
    cache.set(mesh, ctx);
  }
  return ctx;
}

/**
 * Faces dentro do raio do pincel, crescendo pela superfície a partir da face atingida (não atravessa
 * paredes finas). Com `viewDir`, ignora faces de costas para a câmera.
 */
export function brushFaces(ctx: PaintContext, start: number, center: Vec3, radius: number, viewDir?: Vec3): number[] {
  const r2 = radius * radius;
  const seen = new Set<number>([start]);
  const out: number[] = [start];
  const stack = [start];
  const { centroids: c, normals: n, neighbors } = ctx;
  while (stack.length) {
    const f = stack.pop()!;
    for (let k = 0; k < 3; k++) {
      const g = neighbors[f * 3 + k];
      if (g < 0 || seen.has(g)) continue;
      seen.add(g);
      const dx = c[g * 3] - center[0];
      const dy = c[g * 3 + 1] - center[1];
      const dz = c[g * 3 + 2] - center[2];
      if (dx * dx + dy * dy + dz * dz > r2) continue;
      if (viewDir && n[g * 3] * viewDir[0] + n[g * 3 + 1] * viewDir[1] + n[g * 3 + 2] * viewDir[2] > 0.15) continue;
      out.push(g);
      stack.push(g);
    }
  }
  return out;
}

/** Balde: região da mesma cor que não atravessa arestas mais vivas que `maxAngle` graus. */
export function fillFaces(ctx: PaintContext, start: number, labels: Uint16Array, maxAngle: number): number[] {
  const cosMax = Math.cos((maxAngle * Math.PI) / 180);
  const target = labels[start];
  const seen = new Uint8Array(labels.length);
  seen[start] = 1;
  const out = [start];
  const stack = [start];
  const { normals: n, neighbors } = ctx;
  while (stack.length) {
    const f = stack.pop()!;
    for (let k = 0; k < 3; k++) {
      const g = neighbors[f * 3 + k];
      if (g < 0 || seen[g] || labels[g] !== target) continue;
      const cos = n[f * 3] * n[g * 3] + n[f * 3 + 1] * n[g * 3 + 1] + n[f * 3 + 2] * n[g * 3 + 2];
      if (cos < cosMax) continue;
      seen[g] = 1;
      out.push(g);
      stack.push(g);
    }
  }
  return out;
}

/** Casca inteira (todas as faces conectadas). */
export function shellFaces(ctx: PaintContext, start: number): number[] {
  const seen = new Uint8Array(ctx.neighbors.length / 3);
  seen[start] = 1;
  const out = [start];
  const stack = [start];
  while (stack.length) {
    const f = stack.pop()!;
    for (let k = 0; k < 3; k++) {
      const g = ctx.neighbors[f * 3 + k];
      if (g < 0 || seen[g]) continue;
      seen[g] = 1;
      out.push(g);
      stack.push(g);
    }
  }
  return out;
}

/** Faces com a mesma cor (com tolerância), material ou objeto de origem. */
export function attributeFaces(
  src: Int32Array,
  attrs: FaceAttributes,
  kind: "cor" | "material" | "objeto",
  start: number,
  tolerance: number,
): number[] {
  const out: number[] = [];
  const s = src[start];
  if (s < 0) return [start];
  if (kind === "cor" && attrs.colors) {
    const c0 = attrs.colors[s];
    const r0 = (c0 >> 16) & 255;
    const g0 = (c0 >> 8) & 255;
    const b0 = c0 & 255;
    const t2 = tolerance * tolerance;
    for (let f = 0; f < src.length; f++) {
      if (src[f] < 0) continue;
      const c = attrs.colors[src[f]];
      const dr = ((c >> 16) & 255) - r0;
      const dg = ((c >> 8) & 255) - g0;
      const db = (c & 255) - b0;
      if (dr * dr + dg * dg + db * db <= t2) out.push(f);
    }
    return out;
  }
  const values = kind === "material" ? attrs.materials : attrs.objects;
  if (!values) return [start];
  const v0 = values[s];
  for (let f = 0; f < src.length; f++) if (src[f] >= 0 && values[src[f]] === v0) out.push(f);
  return out;
}

/** Remove ilhas minúsculas e serrilhados das fronteiras pintadas. */
export function smoothRegionLabels(ctx: PaintContext, labels: Uint16Array): Uint16Array {
  let total = 0;
  for (let f = 0; f < ctx.areas.length; f++) total += ctx.areas[f];
  return cleanLabels(labels, ctx.neighbors, ctx.areas, { minIslandArea: total * 0.001, minIslandFaces: 6, smoothIterations: 4 });
}
