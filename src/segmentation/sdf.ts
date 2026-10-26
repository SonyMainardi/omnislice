import { DoubleSide, Ray, Vector3 } from "three";
import { buildBVH } from "../core/bvh";
import { type IndexedMesh, computeBounds, faceCentroids, faceNormalsAndAreas, triCount } from "../core/mesh";

/** Direções em um cone em torno de +Z (espiral de ângulo áureo), com pesos maiores perto do eixo. */
function coneDirections(count: number, halfAngleDeg: number): { dirs: Float32Array; weights: Float32Array } {
  const dirs = new Float32Array(count * 3);
  const weights = new Float32Array(count);
  const maxCos = Math.cos((halfAngleDeg * Math.PI) / 180);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const z = count === 1 ? 1 : 1 - (i / (count - 1)) * (1 - maxCos);
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    const phi = i * golden;
    dirs[i * 3] = Math.cos(phi) * r;
    dirs[i * 3 + 1] = Math.sin(phi) * r;
    dirs[i * 3 + 2] = z;
    weights[i] = 1 / (Math.acos(Math.min(1, z)) + 0.15);
  }
  return { dirs, weights };
}

export interface SDFOptions {
  /** Máximo de faces amostradas; as demais recebem o valor por difusão. */
  samples: number;
  rays: number;
  coneAngle: number;
}

/**
 * "Shape Diameter Function": diâmetro local do sólido em cada face, medido por raios lançados
 * para dentro em um cone. Membros finos têm SDF baixo; tronco e cabeça, alto.
 */
export function computeSDF(
  mesh: IndexedMesh,
  neighbors: Int32Array,
  opts: SDFOptions,
  progress?: (f: number) => void,
): Float32Array {
  const n = triCount(mesh);
  const bvh = buildBVH(mesh);
  const { normals } = faceNormalsAndAreas(mesh);
  const centroids = faceCentroids(mesh);
  const b = computeBounds(mesh.positions);
  const diag = Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
  const eps = diag * 1e-5;
  const { dirs, weights } = coneDirections(opts.rays, opts.coneAngle / 2);
  const sdf = new Float32Array(n).fill(Number.NaN);
  const stride = Math.max(1, Math.floor(n / opts.samples));
  const ray = new Ray();
  const t1 = new Vector3();
  const t2 = new Vector3();
  const axis = new Vector3();
  const dir = new Vector3();
  const dist: number[] = [];
  const wts: number[] = [];
  let processed = 0;
  const total = Math.ceil(n / stride);
  for (let f = stride >> 1; f < n; f += stride) {
    axis.set(-normals[f * 3], -normals[f * 3 + 1], -normals[f * 3 + 2]);
    if (axis.lengthSq() < 0.5) continue;
    if (Math.abs(axis.x) < 0.9) t1.set(1, 0, 0);
    else t1.set(0, 1, 0);
    t1.crossVectors(axis, t1).normalize();
    t2.crossVectors(axis, t1);
    dist.length = 0;
    wts.length = 0;
    for (let r = 0; r < opts.rays; r++) {
      const x = dirs[r * 3];
      const y = dirs[r * 3 + 1];
      const z = dirs[r * 3 + 2];
      dir.set(
        t1.x * x + t2.x * y + axis.x * z,
        t1.y * x + t2.y * y + axis.y * z,
        t1.z * x + t2.z * y + axis.z * z,
      );
      ray.origin.set(centroids[f * 3] + axis.x * eps, centroids[f * 3 + 1] + axis.y * eps, centroids[f * 3 + 2] + axis.z * eps);
      ray.direction.copy(dir);
      const hit = bvh.raycastFirst(ray, DoubleSide);
      if (!hit || !hit.face) continue;
      // Só vale a parede oposta vista por dentro (normal apontando no mesmo sentido do raio).
      if (hit.face.normal.dot(dir) <= 0) continue;
      dist.push(hit.distance);
      wts.push(weights[r]);
    }
    if (dist.length) {
      const sorted = dist.slice().sort((a, c) => a - c);
      const median = sorted[sorted.length >> 1];
      let mean = 0;
      for (const d of dist) mean += d;
      mean /= dist.length;
      let variance = 0;
      for (const d of dist) variance += (d - mean) ** 2;
      const sd = Math.sqrt(variance / dist.length);
      let sw = 0;
      let sv = 0;
      for (let i = 0; i < dist.length; i++) {
        if (Math.abs(dist[i] - median) > 1.5 * sd + 1e-9) continue;
        sw += wts[i];
        sv += wts[i] * dist[i];
      }
      sdf[f] = sw > 0 ? sv / sw : median;
    }
    if (++processed % 512 === 0) progress?.(processed / total);
  }
  // Difusão para faces não amostradas (vizinhos já conhecidos).
  for (let pass = 0; pass < 10000; pass++) {
    let pending = 0;
    let changed = false;
    const prev = sdf.slice();
    for (let f = 0; f < n; f++) {
      if (!Number.isNaN(prev[f])) continue;
      let s = 0;
      let c = 0;
      for (let k = 0; k < 3; k++) {
        const g = neighbors[f * 3 + k];
        if (g >= 0 && !Number.isNaN(prev[g])) {
          s += prev[g];
          c++;
        }
      }
      if (c) {
        sdf[f] = s / c;
        changed = true;
      } else pending++;
    }
    if (!pending || !changed) break;
  }
  let fallback = 0;
  let cnt = 0;
  for (let f = 0; f < n; f++)
    if (!Number.isNaN(sdf[f])) {
      fallback += sdf[f];
      cnt++;
    }
  fallback = cnt ? fallback / cnt : 1;
  for (let f = 0; f < n; f++) if (Number.isNaN(sdf[f])) sdf[f] = fallback;
  // Suavização bilateral: mistura vizinhos parecidos, preserva saltos entre partes.
  let range = 0;
  for (let f = 0; f < n; f++) range = Math.max(range, sdf[f]);
  const sigma = Math.max(range * 0.08, 1e-6);
  // Mais iterações em malhas densas para suavizar a mesma distância em milímetros.
  const iterations = Math.min(40, Math.max(4, Math.round(4 * Math.sqrt(n / 10000))));
  for (let it = 0; it < iterations; it++) {
    const prev = sdf.slice();
    for (let f = 0; f < n; f++) {
      let sw = 1;
      let sv = prev[f];
      for (let k = 0; k < 3; k++) {
        const g = neighbors[f * 3 + k];
        if (g < 0) continue;
        const d = prev[g] - prev[f];
        const w = Math.exp(-(d * d) / (2 * sigma * sigma));
        sw += w;
        sv += w * prev[g];
      }
      sdf[f] = sv / sw;
    }
  }
  bvh.geometry.dispose();
  return sdf;
}

/** Transfere rótulos de uma malha simplificada para a original (face mais próxima de cada centróide). */
export function transferLabels(from: IndexedMesh, labels: Uint16Array, to: IndexedMesh): Uint16Array {
  const bvh = buildBVH(from);
  const c = faceCentroids(to);
  const out = new Uint16Array(triCount(to));
  const p = new Vector3();
  const hit = { point: new Vector3(), distance: 0, faceIndex: 0 };
  for (let f = 0; f < out.length; f++) {
    p.set(c[f * 3], c[f * 3 + 1], c[f * 3 + 2]);
    const r = bvh.closestPointToPoint(p, hit);
    out[f] = r ? labels[r.faceIndex] : 0;
  }
  bvh.geometry.dispose();
  return out;
}

/** Espessura de parede por amostragem: raio para dentro, ao longo da normal. */
export function sampleThickness(
  mesh: IndexedMesh,
  samples = 1500,
  skip?: (face: number) => boolean,
): { p5: number; p10: number; min: number; median: number } {
  const n = triCount(mesh);
  if (!n) return { p5: 0, p10: 0, min: 0, median: 0 };
  const bvh = buildBVH(mesh);
  const { normals, areas } = faceNormalsAndAreas(mesh);
  const centroids = faceCentroids(mesh);
  const stride = Math.max(1, Math.floor(n / samples));
  const ray = new Ray();
  const values: number[] = [];
  for (let f = 0; f < n; f += stride) {
    if (areas[f] <= 0 || skip?.(f)) continue;
    ray.direction.set(-normals[f * 3], -normals[f * 3 + 1], -normals[f * 3 + 2]);
    ray.origin.set(centroids[f * 3], centroids[f * 3 + 1], centroids[f * 3 + 2]).addScaledVector(ray.direction, 1e-4);
    const hit = bvh.raycastFirst(ray, DoubleSide);
    // Só conta a parede oposta (quase paralela). Toques rasantes em cantos e furos não são parede fina.
    if (hit?.face && hit.face.normal.dot(ray.direction) > 0.5 && !skip?.(hit.faceIndex ?? -1)) values.push(hit.distance);
  }
  bvh.geometry.dispose();
  if (values.length < 20) return { p5: 0, p10: 0, min: 0, median: 0 };
  values.sort((a, b) => a - b);
  return {
    p5: values[Math.floor(values.length * 0.05)],
    p10: values[Math.floor(values.length * 0.1)],
    min: values[0],
    median: values[values.length >> 1],
  };
}
