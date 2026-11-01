import type { Vec3 } from "./math";
import { type EdgeTable, type IndexedMesh, halfEdgeFrom, halfEdgeTo, triCount } from "./mesh";

export interface Island {
  id: number;
  label: number;
  faces: Int32Array;
  area: number;
}

/** Componentes conexos de faces com o mesmo rótulo. */
export function labelIslands(
  labels: ArrayLike<number>,
  neighbors: Int32Array,
  areas: Float32Array,
): { islands: Island[]; islandOf: Int32Array } {
  const n = labels.length;
  const islandOf = new Int32Array(n).fill(-1);
  const islands: Island[] = [];
  const stack = new Int32Array(n);
  const buffer = new Int32Array(n);
  for (let s = 0; s < n; s++) {
    if (islandOf[s] !== -1) continue;
    const id = islands.length;
    const label = labels[s];
    let top = 0;
    let count = 0;
    let area = 0;
    stack[top++] = s;
    islandOf[s] = id;
    while (top > 0) {
      const f = stack[--top];
      buffer[count++] = f;
      area += areas[f];
      for (let k = 0; k < 3; k++) {
        const g = neighbors[f * 3 + k];
        if (g >= 0 && islandOf[g] === -1 && labels[g] === label) {
          islandOf[g] = id;
          stack[top++] = g;
        }
      }
    }
    islands.push({ id, label, faces: buffer.slice(0, count), area });
  }
  return { islands, islandOf };
}

/**
 * Limpa uma pintura: ilhas minúsculas são absorvidas pelo vizinho dominante e
 * reentrâncias de uma face são suavizadas para que as fronteiras fiquem contínuas.
 */
export function cleanLabels(
  labels: Uint16Array,
  neighbors: Int32Array,
  areas: Float32Array,
  opts: { minIslandArea: number; minIslandFaces: number; smoothIterations: number },
): Uint16Array {
  const out = labels.slice();
  absorbSmallIslands(out, neighbors, areas, opts);
  // A suavização troca todas as faces ao mesmo tempo e pode deixar faces isoladas (padrão
  // "xadrez" em fronteiras serrilhadas): uma nova absorção remove essas ilhas de uma face, que
  // virariam laços de costura minúsculos no corte.
  if (smoothBorders(out, neighbors, opts.smoothIterations)) absorbSmallIslands(out, neighbors, areas, opts);
  return out;
}

function absorbSmallIslands(
  out: Uint16Array,
  neighbors: Int32Array,
  areas: Float32Array,
  opts: { minIslandArea: number; minIslandFaces: number },
): void {
  for (let pass = 0; pass < 3; pass++) {
    const { islands, islandOf } = labelIslands(out, neighbors, areas);
    if (islands.length <= 1) break;
    let changed = false;
    // Absorve das menores para as maiores, uma de cada vez por passada.
    const order = islands.slice().sort((a, b) => a.area - b.area);
    const absorbed = new Uint8Array(islands.length);
    for (const isl of order) {
      if (isl.area >= opts.minIslandArea && isl.faces.length >= opts.minIslandFaces) continue;
      const border = new Map<number, number>();
      for (const f of isl.faces)
        for (let k = 0; k < 3; k++) {
          const g = neighbors[f * 3 + k];
          if (g < 0) continue;
          const j = islandOf[g];
          if (j === isl.id || absorbed[j]) continue;
          border.set(j, (border.get(j) ?? 0) + 1);
        }
      let best = -1;
      let bestCount = 0;
      for (const [j, c] of border)
        if (c > bestCount) {
          best = j;
          bestCount = c;
        }
      if (best < 0) continue;
      const target = islands[best].label;
      for (const f of isl.faces) out[f] = target;
      absorbed[isl.id] = 1;
      changed = true;
    }
    if (!changed) break;
  }
}

/** Reentrâncias de uma face: a face com dois vizinhos de outro rótulo passa a ser dele. */
function smoothBorders(out: Uint16Array, neighbors: Int32Array, iterations: number): boolean {
  let any = false;
  for (let it = 0; it < iterations; it++) {
    let changed = 0;
    const prev = out.slice();
    for (let f = 0; f < prev.length; f++) {
      const a = neighbors[f * 3];
      const b = neighbors[f * 3 + 1];
      const c = neighbors[f * 3 + 2];
      const own = prev[f];
      const la = a >= 0 ? prev[a] : own;
      const lb = b >= 0 ? prev[b] : own;
      const lc = c >= 0 ? prev[c] : own;
      let target = -1;
      if (la !== own && la === lb) target = la;
      else if (la !== own && la === lc) target = la;
      else if (lb !== own && lb === lc) target = lb;
      if (target >= 0) {
        out[f] = target;
        changed++;
      }
    }
    if (!changed) break;
    any = true;
  }
  return any;
}

export interface BoundaryLoop {
  /** Meias-arestas (das faces da ilha) em ordem, formando um laço fechado. */
  halfEdges: number[];
  /** Vértices na ordem do laço. */
  vertices: number[];
  /** Faces da ilha que tocam o laço. */
  innerFaces: number[];
  /** Faces vizinhas do outro lado do laço. */
  outerFaces: number[];
  /** Ilhas do outro lado. */
  neighborIslands: Set<number>;
  closed: boolean;
}

/** Laços de fronteira de um conjunto de faces (a "costura" entre a ilha e o restante). */
export function islandLoops(
  m: IndexedMesh,
  edges: EdgeTable,
  inIsland: (f: number) => boolean,
  faces: ArrayLike<number>,
  islandOf?: Int32Array,
): BoundaryLoop[] {
  const outgoing = new Map<number, number[]>();
  for (let i = 0; i < faces.length; i++) {
    const f = faces[i];
    for (let k = 0; k < 3; k++) {
      const h = f * 3 + k;
      const t = edges.twin[h];
      const across = t >= 0 ? (t / 3) | 0 : -1;
      if (across >= 0 && inIsland(across)) continue;
      const from = halfEdgeFrom(m, h);
      const list = outgoing.get(from);
      if (list) list.push(h);
      else outgoing.set(from, [h]);
    }
  }
  const used = new Set<number>();
  const loops: BoundaryLoop[] = [];
  for (const [, list] of outgoing)
    for (const start of list) {
      if (used.has(start)) continue;
      const halfEdges: number[] = [];
      let h = start;
      let closed = false;
      while (!used.has(h)) {
        used.add(h);
        halfEdges.push(h);
        const to = halfEdgeTo(m, h);
        const next = outgoing.get(to);
        const cand = next?.find((x) => !used.has(x));
        if (cand === undefined) {
          closed = next?.includes(start) ?? false;
          break;
        }
        h = cand;
      }
      if (halfEdges.length < 3) continue;
      const neighborIslands = new Set<number>();
      const innerFaces: number[] = [];
      const outerFaces: number[] = [];
      for (const he of halfEdges) {
        innerFaces.push((he / 3) | 0);
        const t = edges.twin[he];
        if (t >= 0) {
          const g = (t / 3) | 0;
          outerFaces.push(g);
          if (islandOf) neighborIslands.add(islandOf[g]);
        }
      }
      loops.push({
        halfEdges,
        vertices: halfEdges.map((he) => halfEdgeFrom(m, he)),
        innerFaces,
        outerFaces,
        neighborIslands,
        closed,
      });
    }
  return loops;
}

/** Faces alcançáveis a partir de `seeds` em até `steps` passos, sem sair do conjunto permitido. */
export function growFaces(
  seeds: number[],
  neighbors: Int32Array,
  allowed: (f: number) => boolean,
  steps: number,
): number[] {
  const seen = new Set<number>(seeds);
  let frontier = seeds.slice();
  for (let s = 0; s < steps && frontier.length; s++) {
    const next: number[] = [];
    for (const f of frontier)
      for (let k = 0; k < 3; k++) {
        const g = neighbors[f * 3 + k];
        if (g >= 0 && !seen.has(g) && allowed(g)) {
          seen.add(g);
          next.push(g);
        }
      }
    frontier = next;
  }
  return [...seen];
}

export function centroidOfFaces(faces: ArrayLike<number>, centroids: Float32Array, areas?: Float32Array): Vec3 {
  let x = 0;
  let y = 0;
  let z = 0;
  let w = 0;
  for (let i = 0; i < faces.length; i++) {
    const f = faces[i];
    const a = areas ? areas[f] : 1;
    x += centroids[f * 3] * a;
    y += centroids[f * 3 + 1] * a;
    z += centroids[f * 3 + 2] * a;
    w += a;
  }
  return w > 0 ? [x / w, y / w, z / w] : [0, 0, 0];
}

/**
 * Faces do lado da ilha em relação a um laço: inunda a partir das faces internas sem atravessar
 * as arestas do laço. Em superfícies de gênero zero todo laço separa a malha em dois lados.
 */
export function sideOfLoop(m: IndexedMesh, neighbors: Int32Array, loop: BoundaryLoop): Uint8Array {
  const n = triCount(m);
  const blocked = new Set<number>();
  for (const h of loop.halfEdges) blocked.add(h);
  const side = new Uint8Array(n);
  const stack: number[] = [];
  for (const f of loop.innerFaces)
    if (!side[f]) {
      side[f] = 1;
      stack.push(f);
    }
  while (stack.length) {
    const f = stack.pop()!;
    for (let k = 0; k < 3; k++) {
      const h = f * 3 + k;
      if (blocked.has(h)) continue;
      const g = neighbors[h];
      if (g < 0 || side[g]) continue;
      // Também não atravessa pela meia-aresta gêmea do laço.
      let crossesLoop = false;
      for (let j = 0; j < 3; j++) {
        if (neighbors[g * 3 + j] === f && blocked.has(g * 3 + j)) crossesLoop = true;
      }
      if (crossesLoop) continue;
      side[g] = 1;
      stack.push(g);
    }
  }
  return side;
}
