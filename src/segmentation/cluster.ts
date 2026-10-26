import { labelIslands } from "../core/labels";
import { type IndexedMesh, computeBounds, faceCentroids, faceNormalsAndAreas, triCount } from "../core/mesh";

/** k-means 1D ponderado com inicialização por quantis. Devolve médias e desvios de cada grupo. */
export function kmeans1D(values: Float32Array, weights: Float32Array, k: number): { means: number[]; sigmas: number[] } {
  const sorted = Array.from(values).sort((a, b) => a - b);
  let means = Array.from({ length: k }, (_, i) => sorted[Math.min(sorted.length - 1, Math.floor(((i + 0.5) / k) * sorted.length))]);
  const assign = new Int32Array(values.length);
  for (let it = 0; it < 40; it++) {
    for (let i = 0; i < values.length; i++) {
      let best = 0;
      let bd = Infinity;
      for (let c = 0; c < k; c++) {
        const d = Math.abs(values[i] - means[c]);
        if (d < bd) {
          bd = d;
          best = c;
        }
      }
      assign[i] = best;
    }
    const sum = new Float64Array(k);
    const w = new Float64Array(k);
    for (let i = 0; i < values.length; i++) {
      sum[assign[i]] += values[i] * weights[i];
      w[assign[i]] += weights[i];
    }
    const next = means.map((m, c) => (w[c] > 0 ? sum[c] / w[c] : m));
    const moved = next.some((m, c) => Math.abs(m - means[c]) > 1e-7);
    means = next;
    if (!moved) break;
  }
  const varSum = new Float64Array(k);
  const w = new Float64Array(k);
  for (let i = 0; i < values.length; i++) {
    varSum[assign[i]] += (values[i] - means[assign[i]]) ** 2 * weights[i];
    w[assign[i]] += weights[i];
  }
  const sigmas = means.map((_, c) => Math.max(Math.sqrt(w[c] > 0 ? varSum[c] / w[c] : 0), 0.02));
  return { means, sigmas };
}

/** Geometria das arestas do grafo dual: comprimento e ângulo côncavo (0 se convexa), em graus. */
export interface DualEdges {
  length: Float32Array;
  concaveDeg: Float32Array;
}

export function dualEdges(mesh: IndexedMesh, neighbors: Int32Array): DualEdges {
  const n = triCount(mesh);
  const { normals } = faceNormalsAndAreas(mesh);
  const c = faceCentroids(mesh);
  const p = mesh.positions;
  const length = new Float32Array(n * 3);
  const concaveDeg = new Float32Array(n * 3);
  for (let f = 0; f < n; f++)
    for (let j = 0; j < 3; j++) {
      const g = neighbors[f * 3 + j];
      if (g < 0) continue;
      const va = mesh.indices[f * 3 + j] * 3;
      const vb = mesh.indices[f * 3 + ((j + 1) % 3)] * 3;
      length[f * 3 + j] = Math.hypot(p[vb] - p[va], p[vb + 1] - p[va + 1], p[vb + 2] - p[va + 2]);
      const cos = Math.max(
        -1,
        Math.min(1, normals[f * 3] * normals[g * 3] + normals[f * 3 + 1] * normals[g * 3 + 1] + normals[f * 3 + 2] * normals[g * 3 + 2]),
      );
      // Vinco côncavo: a face vizinha fica "à frente" do plano desta face.
      const concave =
        normals[f * 3] * (c[g * 3] - c[f * 3]) +
          normals[f * 3 + 1] * (c[g * 3 + 1] - c[f * 3 + 1]) +
          normals[f * 3 + 2] * (c[g * 3 + 2] - c[f * 3 + 2]) >
        0;
      concaveDeg[f * 3 + j] = concave ? (Math.acos(cos) * 180) / Math.PI : 0;
    }
  return { length, concaveDeg };
}

/**
 * Atribui grupos às faces minimizando ∫dado·dA + λ∫suavidade·dl (ICM). Pesos em mm² e mm deixam o
 * resultado independente da densidade da malha. Vincos côncavos são baratos de cortar.
 */
export function smoothAssign(
  mesh: IndexedMesh,
  neighbors: Int32Array,
  edges: DualEdges,
  values: Float32Array,
  means: number[],
  sigmas: number[],
  lambda: number,
): Uint16Array {
  const n = triCount(mesh);
  const k = means.length;
  const { areas } = faceNormalsAndAreas(mesh);
  const edgeW = new Float32Array(n * 3);
  for (let h = 0; h < n * 3; h++) {
    if (neighbors[h] < 0) continue;
    const t = (edges.concaveDeg[h] * Math.PI) / 180;
    edgeW[h] = edges.length[h] * -Math.log(Math.max(t / Math.PI, 1e-3));
  }
  const data = (f: number, l: number) => {
    const d = (values[f] - means[l]) / sigmas[l];
    return areas[f] * (0.5 * d * d + Math.log(sigmas[l]));
  };
  const labels = new Uint16Array(n);
  for (let f = 0; f < n; f++) {
    let best = 0;
    let bd = Infinity;
    for (let l = 0; l < k; l++) {
      const d = data(f, l);
      if (d < bd) {
        bd = d;
        best = l;
      }
    }
    labels[f] = best;
  }
  for (let it = 0; it < 10; it++) {
    let changed = 0;
    for (let f = 0; f < n; f++) {
      let best = labels[f];
      let bd = Infinity;
      for (let l = 0; l < k; l++) {
        let e = data(f, l);
        for (let j = 0; j < 3; j++) {
          const g = neighbors[f * 3 + j];
          if (g >= 0 && labels[g] !== l) e += lambda * edgeW[f * 3 + j];
        }
        if (e < bd) {
          bd = e;
          best = l;
        }
      }
      if (best !== labels[f]) {
        labels[f] = best;
        changed++;
      }
    }
    if (!changed) break;
  }
  return labels;
}

interface PairStats {
  length: number;
  concave: number;
}

/**
 * Fusão hierárquica de regiões. A dissimilaridade de duas regiões vizinhas soma o ângulo côncavo
 * médio da fronteira (juntas) e o contraste de espessura (membros finos × tronco). Regiões pequenas
 * são absorvidas primeiro; depois funde-se o par mais parecido até atingir o limiar ou o máximo.
 */
export function hierarchicalMerge(
  mesh: IndexedMesh,
  neighbors: Int32Array,
  edges: DualEdges,
  initial: ArrayLike<number>,
  thickness: Float32Array,
  opts: {
    minArea: number;
    maxRegions: number;
    threshold: number;
    contrastWeight: number;
    /** Só absorve regiões pequenas (não funde por semelhança). */
    onlySmall?: boolean;
    /** Destino das regiões pequenas: maior fronteira (ruído) ou vizinho mais parecido (partes pequenas). */
    smallRule?: "longest" | "similar";
  },
): Uint16Array {
  const n = triCount(mesh);
  const { areas } = faceNormalsAndAreas(mesh);
  const { islands, islandOf } = labelIslands(initial, neighbors, areas);
  const R = islands.length;
  const area = new Float64Array(R);
  const sdfSum = new Float64Array(R);
  for (let f = 0; f < n; f++) {
    area[islandOf[f]] += areas[f];
    sdfSum[islandOf[f]] += areas[f] * thickness[f];
  }
  const adj: Map<number, PairStats>[] = Array.from({ length: R }, () => new Map());
  for (let f = 0; f < n; f++)
    for (let j = 0; j < 3; j++) {
      const g = neighbors[f * 3 + j];
      if (g < 0) continue;
      const a = islandOf[f];
      const b = islandOf[g];
      if (a === b) continue;
      let s = adj[a].get(b);
      if (!s) adj[a].set(b, (s = { length: 0, concave: 0 }));
      // Cada aresta aparece duas vezes (uma de cada lado); a média não muda.
      s.length += edges.length[f * 3 + j];
      s.concave += edges.length[f * 3 + j] * edges.concaveDeg[f * 3 + j];
    }
  const parent = Int32Array.from({ length: R }, (_, i) => i);
  const alive = new Set<number>(Array.from({ length: R }, (_, i) => i));
  const sdf = (r: number) => sdfSum[r] / Math.max(area[r], 1e-12);
  const dissim = (a: number, b: number) => {
    const s = adj[a].get(b)!;
    const avgConcave = s.concave / Math.max(s.length, 1e-12);
    const contrast = Math.abs(Math.log(Math.max(sdf(a), 1e-6) / Math.max(sdf(b), 1e-6)));
    // Regiões que só se tocam por um trecho curto em relação ao próprio tamanho (ex.: duas pernas
    // ligadas por um fragmento) não são a mesma parte, mesmo com espessuras parecidas.
    const contact = s.length / Math.sqrt(Math.max(Math.min(area[a], area[b]), 1e-12));
    const narrow = (40 * Math.max(0, 0.6 - contact)) / 0.6;
    return avgConcave + opts.contrastWeight * contrast + narrow;
  };
  const merge = (from: number, into: number) => {
    parent[from] = into;
    alive.delete(from);
    area[into] += area[from];
    sdfSum[into] += sdfSum[from];
    for (const [x, s] of adj[from]) {
      adj[x].delete(from);
      if (x === into) continue;
      const t = adj[into].get(x);
      if (t) {
        t.length += s.length;
        t.concave += s.concave;
        const u = adj[x].get(into)!;
        u.length += s.length;
        u.concave += s.concave;
      } else {
        adj[into].set(x, { ...s });
        adj[x].set(into, { ...s });
      }
    }
    adj[from].clear();
  };
  for (;;) {
    // 1) A menor região abaixo da área mínima é absorvida pelo vizinho mais parecido.
    let small = -1;
    for (const r of alive) if (area[r] < opts.minArea && adj[r].size && (small < 0 || area[r] < area[small])) small = r;
    if (small >= 0) {
      // Ruído vai para o vizinho de maior fronteira; partes pequenas, para o vizinho mais parecido.
      let best = -1;
      let score = Infinity;
      for (const [x, s] of adj[small]) {
        const v = opts.smallRule === "similar" ? dissim(small, x) : -s.length;
        if (v < score) {
          score = v;
          best = x;
        }
      }
      merge(small, best);
      continue;
    }
    if (opts.onlySmall) break;
    // 2) Par mais parecido, enquanto abaixo do limiar ou acima do máximo de regiões.
    let pa = -1;
    let pb = -1;
    let pd = Infinity;
    for (const a of alive)
      for (const b of adj[a].keys()) {
        if (b < a) continue;
        const d = dissim(a, b);
        if (d < pd) {
          pd = d;
          pa = a;
          pb = b;
        }
      }
    if (pa < 0) break;
    if (pd >= opts.threshold && alive.size <= opts.maxRegions) break;
    if (area[pa] < area[pb]) merge(pa, pb);
    else merge(pb, pa);
  }
  const root = (x: number) => {
    while (parent[x] !== x) x = parent[x];
    return x;
  };
  const roots = [...alive].sort((a, b) => area[b] - area[a]);
  const index = new Map(roots.map((r, i) => [r, i]));
  const out = new Uint16Array(n);
  for (let f = 0; f < n; f++) out[f] = index.get(root(islandOf[f])) ?? 0;
  return out;
}

/** Componentes conexos por rótulo viram segmentos; pequenos são absorvidos pelo vizinho dominante. */
export function segmentsFromLabels(
  labels: ArrayLike<number>,
  neighbors: Int32Array,
  areas: Float32Array,
  minArea: number,
  maxSegments: number,
): Uint16Array {
  const n = labels.length;
  const { islands, islandOf } = labelIslands(labels, neighbors, areas);
  const owner = Int32Array.from({ length: islands.length }, (_, i) => i);
  const area = islands.map((i) => i.area);
  const find = (x: number): number => {
    while (owner[x] !== x) {
      owner[x] = owner[owner[x]];
      x = owner[x];
    }
    return x;
  };
  const border = new Map<number, Map<number, number>>();
  for (let f = 0; f < n; f++)
    for (let j = 0; j < 3; j++) {
      const g = neighbors[f * 3 + j];
      if (g < 0) continue;
      const a = islandOf[f];
      const b = islandOf[g];
      if (a === b) continue;
      let m = border.get(a);
      if (!m) border.set(a, (m = new Map()));
      m.set(b, (m.get(b) ?? 0) + 1);
    }
  const alive = () => {
    const s = new Set<number>();
    for (let i = 0; i < islands.length; i++) s.add(find(i));
    return s;
  };
  const mergeSmallest = (force: boolean) => {
    const roots = [...alive()].sort((a, b) => area[a] - area[b]);
    for (const r of roots) {
      if (!force && area[r] >= minArea) return false;
      const counts = new Map<number, number>();
      for (let i = 0; i < islands.length; i++) {
        if (find(i) !== r) continue;
        for (const [j, c] of border.get(i) ?? []) {
          const rj = find(j);
          if (rj !== r) counts.set(rj, (counts.get(rj) ?? 0) + c);
        }
      }
      let best = -1;
      let bc = 0;
      for (const [j, c] of counts)
        if (c > bc) {
          best = j;
          bc = c;
        }
      if (best < 0) continue;
      owner[r] = best;
      area[best] += area[r];
      return true;
    }
    return false;
  };
  while (mergeSmallest(false));
  while (alive().size > maxSegments && mergeSmallest(true));
  const roots = [...alive()].sort((a, b) => area[b] - area[a]);
  const index = new Map(roots.map((r, i) => [r, i]));
  const out = new Uint16Array(n);
  for (let f = 0; f < n; f++) out[f] = index.get(find(islandOf[f])) ?? 0;
  return out;
}

export function modelDiagonal(mesh: IndexedMesh): number {
  const b = computeBounds(mesh.positions);
  return Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
}
