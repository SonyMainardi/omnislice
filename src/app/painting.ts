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
  /** Normais suavizadas na escala das partes do modelo (calculadas na primeira seleção inteligente). */
  smooth?: Float32Array;
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

/** Normais por face suavizadas por difusão até um raio de ~1/150 do modelo (ignora rugas finas). */
function smoothNormals(ctx: PaintContext, diag: number): Float32Array {
  if (ctx.smooth) return ctx.smooth;
  const { normals, areas, neighbors } = ctx;
  const n = areas.length;
  let total = 0;
  for (let f = 0; f < n; f++) total += areas[f];
  const h = Math.sqrt((2 * total) / Math.max(n, 1));
  // Malhas grossas (CAD) não precisam: a média com triângulos-lasca distorce as normais.
  const wanted = Math.round((diag / 150 / h) ** 2);
  const iterations = wanted < 3 ? 0 : Math.min(60, wanted);
  let cur = Float32Array.from(normals);
  let next = new Float32Array(cur.length);
  for (let it = 0; it < iterations; it++) {
    for (let f = 0; f < n; f++) {
      let x = cur[f * 3] * areas[f];
      let y = cur[f * 3 + 1] * areas[f];
      let z = cur[f * 3 + 2] * areas[f];
      for (let k = 0; k < 3; k++) {
        const g = neighbors[f * 3 + k];
        if (g < 0) continue;
        x += cur[g * 3] * areas[g];
        y += cur[g * 3 + 1] * areas[g];
        z += cur[g * 3 + 2] * areas[g];
      }
      const l = Math.hypot(x, y, z) || 1;
      next[f * 3] = x / l;
      next[f * 3 + 1] = y / l;
      next[f * 3 + 2] = z / l;
    }
    [cur, next] = [next, cur];
  }
  ctx.smooth = cur;
  return cur;
}

/**
 * Seleção inteligente: a partir da face clicada, cresce pela superfície medindo distâncias em que
 * atravessar um vinco côncavo (pescoço, juntas, encaixes entre partes) custa proporcional ao ângulo
 * total do vinco, independentemente da resolução da malha. Quando um vinco fecha a parte por inteiro,
 * a frente termina a parte e a próxima face fica muito mais distante: é ali que a parte "termina".
 */
export function smartFaces(ctx: PaintContext, start: number): number[] {
  const { centroids: c, neighbors, areas } = ctx;
  const n = areas.length;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let f = 0; f < n; f++)
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a], c[f * 3 + a]);
      hi[a] = Math.max(hi[a], c[f * 3 + a]);
    }
  const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1;
  const sn = smoothNormals(ctx, diag);
  // Custo de um radiano de vinco côncavo, em mm de caminho.
  const crease = diag * 0.5;

  // Dijkstra com fila de prioridade binária (entradas repetidas são ignoradas ao sair).
  const dist = new Float64Array(n).fill(Infinity);
  // Parte do custo da última aresta que vem do vinco (separa salto por vinco de triângulo grande).
  const via = new Float64Array(n);
  const done = new Uint8Array(n);
  let heapF = new Int32Array(1024);
  let heapD = new Float64Array(1024);
  let size = 0;
  const push = (f: number, d: number) => {
    if (size === heapF.length) {
      const nf = new Int32Array(size * 2);
      nf.set(heapF);
      heapF = nf;
      const nd = new Float64Array(size * 2);
      nd.set(heapD);
      heapD = nd;
    }
    let i = size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heapD[p] <= d) break;
      heapF[i] = heapF[p];
      heapD[i] = heapD[p];
      i = p;
    }
    heapF[i] = f;
    heapD[i] = d;
  };
  const pop = (): number => {
    const top = heapF[0];
    const f = heapF[--size];
    const d = heapD[size];
    let i = 0;
    for (;;) {
      let m = i * 2 + 1;
      if (m >= size) break;
      if (m + 1 < size && heapD[m + 1] < heapD[m]) m++;
      if (heapD[m] >= d) break;
      heapF[i] = heapF[m];
      heapD[i] = heapD[m];
      i = m;
    }
    heapF[i] = f;
    heapD[i] = d;
    return top;
  };
  const order: number[] = [];
  dist[start] = 0;
  push(start, 0);
  while (size) {
    const f = pop();
    if (done[f]) continue;
    done[f] = 1;
    order.push(f);
    for (let k = 0; k < 3; k++) {
      const g = neighbors[f * 3 + k];
      if (g < 0 || done[g]) continue;
      const dx = c[g * 3] - c[f * 3];
      const dy = c[g * 3 + 1] - c[f * 3 + 1];
      const dz = c[g * 3 + 2] - c[f * 3 + 2];
      let step = Math.hypot(dx, dy, dz);
      let penalty = 0;
      const bend = (sn[g * 3] - sn[f * 3]) * dx + (sn[g * 3 + 1] - sn[f * 3 + 1]) * dy + (sn[g * 3 + 2] - sn[f * 3 + 2]) * dz;
      if (bend < 0) {
        const cos = sn[f * 3] * sn[g * 3] + sn[f * 3 + 1] * sn[g * 3 + 1] + sn[f * 3 + 2] * sn[g * 3 + 2];
        // Abaixo de ~3° por aresta é ruído da malha (escultura, escaneamento), não vinco.
        penalty = crease * Math.max(0, Math.acos(Math.min(1, Math.max(-1, cos))) - 0.05);
      }
      const d = dist[f] + step + penalty;
      if (d < dist[g]) {
        dist[g] = d;
        via[g] = penalty;
        push(g, d);
      }
    }
  }

  // O primeiro salto de distância (vinco de pelo menos ~10° fechando a parte) dentro de tamanhos aceitáveis.
  let total = 0;
  for (const f of order) total += areas[f];
  const minGap = crease * 0.17;
  let area = 0;
  let largest = -1;
  let largestGap = 0;
  for (let i = 0; i + 1 < order.length; i++) {
    area += areas[order[i]];
    const frac = area / total;
    if (frac < 0.005) continue;
    if (frac > 0.7) break;
    const next = order[i + 1];
    const gap = Math.min(dist[next] - dist[order[i]], via[next]);
    if (gap >= minGap) return order.slice(0, i + 1);
    if (gap > largestGap) {
      largestGap = gap;
      largest = i;
    }
  }
  return largest >= 0 ? order.slice(0, largest + 1) : order;
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
