import { DoubleSide, Ray } from "three";
import type { MeshBVH } from "three-mesh-bvh";
import { buildBVH, findSelfIntersections, roundingTolerance } from "./bvh";
import { type Vec3, cross, length, sub } from "./math";
import type { IndexedMesh } from "./mesh";

/**
 * Defeitos de uma tampa: quantos triângulos atravessam a superfície do sólido ou a própria tampa e,
 * em fração da área da tampa, quanto ficou fora do material (`out`) e quanto está dobrado sobre a
 * própria tampa (`self`). Um contorno que corre colado no pé de uma parede gera triângulos
 * minúsculos que raspam nela (área fora desprezível); uma tampa que fura a superfície ou se dobra
 * tem área relevante fora do lugar. Só as faces perto da tampa entram no teste de cruzamento.
 */
export function capDefects(
  rm: IndexedMesh,
  solid: MeshBVH,
  positions: number[],
  tris: number[],
  extraVerts: Vec3[],
): { faces: number; out: number; self: number } {
  if (!tris.length) return { faces: 0, out: 0, self: 0 };
  const all = new Float32Array(positions.length + extraVerts.length * 3);
  all.set(positions);
  extraVerts.forEach((v, i) => all.set(v, positions.length + i * 3));
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const v of tris)
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a], all[v * 3 + a]);
      hi[a] = Math.max(hi[a], all[v * 3 + a]);
    }
  const eps = roundingTolerance(rm);
  const near: number[] = [];
  const idx = rm.indices;
  for (let t = 0; t < idx.length / 3; t++) {
    let inside = true;
    for (let a = 0; a < 3 && inside; a++) {
      const x0 = all[idx[t * 3] * 3 + a];
      const x1 = all[idx[t * 3 + 1] * 3 + a];
      const x2 = all[idx[t * 3 + 2] * 3 + a];
      inside = Math.max(x0, x1, x2) >= lo[a] - eps && Math.min(x0, x1, x2) <= hi[a] + eps;
    }
    if (inside) near.push(t);
  }
  const indices = new Uint32Array((near.length + tris.length / 3) * 3);
  near.forEach((t, i) => indices.set(idx.subarray(t * 3, t * 3 + 3), i * 3));
  indices.set(tris, near.length * 3);
  const mesh: IndexedMesh = { positions: all, indices };
  const capFaces = Array.from({ length: tris.length / 3 }, (_, i) => near.length + i);
  const local = buildBVH(mesh);
  const pairs = findSelfIntersections(mesh, 1000, eps, undefined, { faces: capFaces, bvh: local });
  local.geometry.dispose();
  const crossing = new Set<number>();
  const folded = new Set<number>();
  for (const [i, j] of pairs) {
    if (i >= near.length && j >= near.length) {
      folded.add(i);
      folded.add(j);
    } else crossing.add(i >= near.length ? i : j);
  }
  const corner = (f: number, k: number): Vec3 => {
    const v = indices[f * 3 + k] * 3;
    return [all[v], all[v + 1], all[v + 2]];
  };
  const triArea = (f: number) => {
    const p = [corner(f, 0), corner(f, 1), corner(f, 2)];
    return length(cross(sub(p[1], p[0]), sub(p[2], p[0]))) / 2;
  };
  let total = 0;
  for (const f of capFaces) total += triArea(f);
  if (!(total > 0)) return { faces: crossing.size + folded.size, out: 0, self: 0 };
  let self = 0;
  for (const f of folded) self += triArea(f);
  // Área fora do material nos triângulos que cruzam a superfície: cada um é dividido numa grade de
  // 16 subtriângulos e o centro de cada um é testado (paridade de raios em três direções).
  const ray = new Ray();
  const dirs: Vec3[] = [
    [0.5773, 0.5774, 0.5775],
    [-0.6123, 0.2117, 0.7616],
    [0.1371, -0.8492, 0.5099],
  ];
  const insideSolid = (p: Vec3) => {
    let votes = 0;
    for (const d of dirs) {
      ray.origin.set(p[0], p[1], p[2]);
      ray.direction.set(d[0], d[1], d[2]).normalize();
      if (solid.raycast(ray, DoubleSide).filter((h) => h.distance > 1e-7).length % 2 === 1) votes++;
    }
    return votes >= 2;
  };
  const G = 4;
  let out = 0;
  for (const f of crossing) {
    if (folded.has(f)) continue;
    const [a, b, c] = [corner(f, 0), corner(f, 1), corner(f, 2)];
    const sub2 = triArea(f) / (G * G);
    const at = (u: number, v: number): Vec3 => {
      const w = 1 - u - v;
      return [a[0] * w + b[0] * u + c[0] * v, a[1] * w + b[1] * u + c[1] * v, a[2] * w + b[2] * u + c[2] * v];
    };
    for (let i = 0; i < G; i++)
      for (let j = 0; j < G - i; j++) {
        // Subtriângulo "de pé" (i, j) e, quando existe, o "de cabeça para baixo" ao lado.
        if (!insideSolid(at((i + 1 / 3) / G, (j + 1 / 3) / G))) out += sub2;
        if (i + j < G - 1 && !insideSolid(at((i + 2 / 3) / G, (j + 2 / 3) / G))) out += sub2;
      }
  }
  // Os demais triângulos não cruzam a superfície: ficam inteiros dentro ou fora do material (uma
  // tampa que sai pela borda e fecha um vão por fora). Basta o centro de cada um; em tampas muito
  // grandes, uma amostra sistemática pela área.
  const rest: number[] = [];
  let restArea = 0;
  for (const f of capFaces)
    if (!crossing.has(f) && !folded.has(f)) {
      rest.push(f);
      restArea += triArea(f);
    }
  const center = (f: number): Vec3 => {
    const [a, b, c] = [corner(f, 0), corner(f, 1), corner(f, 2)];
    return [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
  };
  const SAMPLES = 3000;
  if (rest.length <= SAMPLES) {
    for (const f of rest) if (!insideSolid(center(f))) out += triArea(f);
  } else if (restArea > 0) {
    const step = restArea / SAMPLES;
    let acc = 0;
    let next = step / 2;
    for (const f of rest) {
      acc += triArea(f);
      let hits = 0;
      while (next <= acc) {
        hits++;
        next += step;
      }
      if (hits && !insideSolid(center(f))) out += hits * step;
    }
  }
  return { faces: crossing.size + folded.size, out: out / total, self: self / total };
}

/**
 * Fração da área de uma tampa que ficou fora do material (no ar). Uma tampa válida divide o sólido
 * por dentro; quando o contorno pintado contorna uma abertura (a boca de um chapéu, o vão entre
 * braço e corpo), a tampa fecha o vão pelo lado de fora e as duas peças se sobrepõem.
 */
export function capOutsideFraction(solid: MeshBVH, positions: number[], tris: number[], extraVerts: Vec3[]): number {
  const nBase = positions.length / 3;
  const at = (v: number, a: number) => (v < nBase ? positions[v * 3 + a] : extraVerts[v - nBase][a]);
  // Amostra: os maiores triângulos da tampa (até 48), pelo centróide.
  const order = Array.from({ length: tris.length / 3 }, (_, i) => i);
  const areaOf = (i: number) => {
    const p = [0, 1, 2].map((k) => [at(tris[i * 3 + k], 0), at(tris[i * 3 + k], 1), at(tris[i * 3 + k], 2)] as Vec3);
    return length(cross(sub(p[1], p[0]), sub(p[2], p[0]))) / 2;
  };
  const areas = order.map(areaOf);
  order.sort((a, b) => areas[b] - areas[a]);
  const sample = order.slice(0, 48);
  const ray = new Ray();
  const dirs: Vec3[] = [
    [0.5773, 0.5774, 0.5775],
    [-0.6123, 0.2117, 0.7616],
    [0.1371, -0.8492, 0.5099],
  ];
  let total = 0;
  let outside = 0;
  for (const i of sample) {
    const c = [0, 1, 2].map((a) => (at(tris[i * 3], a) + at(tris[i * 3 + 1], a) + at(tris[i * 3 + 2], a)) / 3);
    let votes = 0;
    for (const d of dirs) {
      ray.origin.set(c[0], c[1], c[2]);
      ray.direction.set(d[0], d[1], d[2]).normalize();
      const hits = solid.raycast(ray, DoubleSide).filter((h) => h.distance > 1e-6);
      if (hits.length % 2 === 1) votes++;
    }
    total += areas[i];
    if (votes < 2) outside += areas[i];
  }
  return total > 0 ? outside / total : 0;
}
