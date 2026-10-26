import { boundaryLoops, findDegenerateFaces, findDuplicateFaces } from "./analysis";
import { buildBVH, findSelfIntersections } from "./bvh";
import { shellNesting } from "./solids";
import { type Vec2, type Vec3, frameFromNormal, length, newellNormal, polygonArea2D, toLocal } from "./math";
import {
  type IndexedMesh,
  buildEdgeTable,
  faceComponents,
  faceNeighbors,
  faceNormalsAndAreas,
  halfEdgeFrom,
  triCount,
} from "./mesh";

export interface RepairOptions {
  removeDegenerate: boolean;
  removeDuplicates: boolean;
  fixOrientation: boolean;
  fillHoles: boolean;
  /** Buracos com mais arestas que isso não são fechados automaticamente. */
  maxHoleEdges: number;
  removeSmallComponents: boolean;
  /** Fragmentos com área menor que esta fração da área total são removidos. */
  smallComponentRatio: number;
  /** Desfaz dobras locais (triângulos que se cruzam) retirando-as e fechando o buraco. */
  fixSelfIntersections: boolean;
}

export const defaultRepairOptions: RepairOptions = {
  removeDegenerate: true,
  removeDuplicates: true,
  fixOrientation: true,
  fillHoles: true,
  maxHoleEdges: 2000,
  removeSmallComponents: true,
  smallComponentRatio: 0.0005,
  fixSelfIntersections: true,
};

/** Triangulador 2D: recebe um polígono simples e devolve índices de triângulos (ou null se falhar). */
export type Triangulator = (polygon: Vec2[]) => number[] | null;

export interface RepairResult {
  mesh: IndexedMesh;
  /** Para cada face nova, a face de origem (-1 para faces criadas no fechamento de buracos). */
  faceMap: Int32Array;
  log: string[];
}

function removeFaces(m: IndexedMesh, faceMap: Int32Array, drop: Uint8Array): { mesh: IndexedMesh; faceMap: Int32Array } {
  const n = triCount(m);
  let kept = 0;
  for (let f = 0; f < n; f++) if (!drop[f]) kept++;
  const indices = new Uint32Array(kept * 3);
  const map = new Int32Array(kept);
  let o = 0;
  for (let f = 0; f < n; f++) {
    if (drop[f]) continue;
    indices[o * 3] = m.indices[f * 3];
    indices[o * 3 + 1] = m.indices[f * 3 + 1];
    indices[o * 3 + 2] = m.indices[f * 3 + 2];
    map[o] = faceMap[f];
    o++;
  }
  return { mesh: { positions: m.positions, indices }, faceMap: map };
}

/** Deixa as faces de cada componente com orientação coerente e volume positivo. Retorna faces invertidas. */
export function orientConsistently(m: IndexedMesh): { mesh: IndexedMesh; flipped: number } {
  const n = triCount(m);
  const idx = m.indices.slice();
  const work: IndexedMesh = { positions: m.positions, indices: idx };
  const edges = buildEdgeTable(work);
  const visited = new Uint8Array(n);
  const flip = new Uint8Array(n);
  const stack: number[] = [];
  const compOf = new Int32Array(n).fill(-1);
  let comps = 0;
  const from = (h: number) => idx[h];
  for (let s = 0; s < n; s++) {
    if (visited[s]) continue;
    visited[s] = 1;
    compOf[s] = comps;
    stack.push(s);
    while (stack.length) {
      const f = stack.pop()!;
      for (let k = 0; k < 3; k++) {
        const h = f * 3 + k;
        const t = edges.twin[h];
        if (t < 0) continue;
        const g = (t / 3) | 0;
        if (visited[g]) continue;
        // Com f já na orientação final, g precisa percorrer a aresta compartilhada no sentido oposto.
        const sameDirection = from(h) === from(t);
        flip[g] = (sameDirection ? 1 : 0) ^ flip[f];
        visited[g] = 1;
        compOf[g] = comps;
        stack.push(g);
      }
    }
    comps++;
  }
  let flipped = 0;
  for (let f = 0; f < n; f++) {
    if (!flip[f]) continue;
    const b = idx[f * 3 + 1];
    idx[f * 3 + 1] = idx[f * 3 + 2];
    idx[f * 3 + 2] = b;
    flipped++;
  }
  // Cascas fechadas "do avesso": o sinal do volume deve bater com o aninhamento (sólido por fora,
  // cavidade de um objeto oco por dentro). Só inverte as que estão erradas.
  const open = new Uint8Array(comps);
  for (let f = 0; f < n; f++) for (let k = 0; k < 3; k++) if (edges.twin[f * 3 + k] === -1) open[compOf[f]] = 1;
  const shells = shellNesting(work);
  for (const shell of shells) {
    const c = compOf[shell.faces[0]];
    if (open[c]) continue;
    const cavity = shell.depth % 2 === 1;
    if (cavity ? shell.signedVolume <= 0 : shell.signedVolume >= 0) continue;
    for (const f of shell.faces) {
      const b = idx[f * 3 + 1];
      idx[f * 3 + 1] = idx[f * 3 + 2];
      idx[f * 3 + 2] = b;
      flipped++;
    }
  }
  return { mesh: work, flipped };
}

/** Triangulação em leque a partir do centróide (último recurso para buracos não planares). */
function fanTriangulate(loop: number[], positions: number[]): { tris: number[]; extra: Vec3 } {
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const v of loop) {
    cx += positions[v * 3];
    cy += positions[v * 3 + 1];
    cz += positions[v * 3 + 2];
  }
  const extra: Vec3 = [cx / loop.length, cy / loop.length, cz / loop.length];
  const center = positions.length / 3;
  const tris: number[] = [];
  for (let i = 0; i < loop.length; i++) tris.push(loop[i], loop[(i + 1) % loop.length], center);
  return { tris, extra };
}

/**
 * Fecha um laço de vértices (já na ordem das novas faces) projetando-o no plano de melhor ajuste.
 * Devolve triângulos com índices globais e vértices extras eventualmente criados.
 */
/** Polígono 2D sem autointerseções (teste par a par, suficiente para contornos de corte). */
export function isSimplePolygon(poly: Vec2[]): boolean {
  const n = poly.length;
  const cross = (a: Vec2, b: Vec2, c: Vec2) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const c = poly[j];
      const d = poly[(j + 1) % n];
      if (Math.max(a[0], b[0]) < Math.min(c[0], d[0]) || Math.max(c[0], d[0]) < Math.min(a[0], b[0])) continue;
      if (Math.max(a[1], b[1]) < Math.min(c[1], d[1]) || Math.max(c[1], d[1]) < Math.min(a[1], b[1])) continue;
      const d1 = cross(a, b, c);
      const d2 = cross(a, b, d);
      const d3 = cross(c, d, a);
      const d4 = cross(c, d, b);
      if (d1 * d2 < 0 && d3 * d4 < 0) return false;
    }
  }
  return true;
}

export function capLoop(
  loop: number[],
  positions: number[],
  triangulate: Triangulator | null,
  strict = false,
): { tris: number[]; extraVerts: Vec3[] } | null {
  if (loop.length === 3) return { tris: [loop[0], loop[1], loop[2]], extraVerts: [] };
  const pts: Vec3[] = loop.map((v) => [positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]]);
  const nrm = newellNormal(pts);
  if (triangulate && length(nrm) > 1e-12) {
    const frame = frameFromNormal(pts[0], nrm);
    const poly: Vec2[] = pts.map((p) => {
      const l = toLocal(frame, p);
      return [l[0], l[1]];
    });
    if (strict && !isSimplePolygon(poly)) return null;
    if (polygonArea2D(poly) > 0) {
      const local = triangulate(poly);
      if (local && local.length === (loop.length - 2) * 3) {
        return { tris: local.map((i) => loop[i]), extraVerts: [] };
      }
    }
  }
  if (strict) return null;
  const { tris, extra } = fanTriangulate(loop, positions);
  return { tris, extraVerts: [extra] };
}

export function repairMesh(input: IndexedMesh, opts: RepairOptions, triangulate: Triangulator | null): RepairResult {
  const log: string[] = [];
  let mesh: IndexedMesh = input;
  let faceMap: Int32Array = Int32Array.from({ length: triCount(input) }, (_, i) => i);

  if (opts.removeDegenerate) {
    const drop = findDegenerateFaces(mesh);
    const count = drop.reduce((s, x) => s + x, 0);
    if (count) {
      ({ mesh, faceMap } = removeFaces(mesh, faceMap, drop));
      log.push(`${count} face(s) degenerada(s) removida(s).`);
    }
  }
  if (opts.removeDuplicates) {
    const drop = findDuplicateFaces(mesh);
    const count = drop.reduce((s, x) => s + x, 0);
    if (count) {
      ({ mesh, faceMap } = removeFaces(mesh, faceMap, drop));
      log.push(`${count} face(s) duplicada(s) removida(s).`);
    }
  }
  if (opts.removeSmallComponents) {
    const { count, comp } = faceComponents(mesh, faceNeighbors(mesh));
    if (count > 1) {
      const { areas } = faceNormalsAndAreas(mesh);
      const compArea = new Float64Array(count);
      let total = 0;
      for (let f = 0; f < areas.length; f++) {
        compArea[comp[f]] += areas[f];
        total += areas[f];
      }
      const small = new Uint8Array(count);
      let removed = 0;
      for (let c = 0; c < count; c++)
        if (compArea[c] < total * opts.smallComponentRatio) {
          small[c] = 1;
          removed++;
        }
      if (removed) {
        const drop = new Uint8Array(areas.length);
        for (let f = 0; f < drop.length; f++) drop[f] = small[comp[f]];
        ({ mesh, faceMap } = removeFaces(mesh, faceMap, drop));
        log.push(`${removed} fragmento(s) minúsculo(s) removido(s).`);
      }
    }
  }
  if (opts.fixOrientation) {
    const r = orientConsistently(mesh);
    mesh = r.mesh;
    if (r.flipped) log.push(`${r.flipped} face(s) com orientação corrigida.`);
  }
  if (opts.fillHoles) {
    const r = fillHoles(mesh, faceMap, opts.maxHoleEdges, triangulate);
    ({ mesh, faceMap } = r);
    if (r.filled) log.push(`${r.filled} buraco(s) fechado(s).`);
    if (r.skipped) log.push(`${r.skipped} buraco(s) grande(s) demais para fechar automaticamente.`);
  }
  if (opts.fixSelfIntersections) {
    const r = untangleSelfIntersections(mesh, faceMap, triangulate);
    ({ mesh, faceMap } = r);
    if (r.found)
      log.push(
        r.remaining
          ? `${r.found} cruzamento(s) de triângulos; ${r.found - r.remaining} desfeito(s), ${r.remaining} ainda presente(s) (use a reconstrução por voxels).`
          : `${r.found} cruzamento(s) de triângulos (dobras locais) desfeito(s), refazendo ${r.removedFaces} face(s).`,
      );
  }
  if (!log.length) log.push("Nenhum problema encontrado para corrigir.");
  return { mesh, faceMap, log };
}

/**
 * Fecha os buracos (laços de borda) com até `maxHoleEdges` arestas. Com `fan`, cada buraco é fechado
 * em leque a partir de um vértice novo no centro: nenhuma aresta nova repete uma aresta da malha.
 */
export function fillHoles(
  mesh: IndexedMesh,
  faceMap: Int32Array,
  maxHoleEdges: number,
  triangulate: Triangulator | null,
  fan = false,
): { mesh: IndexedMesh; faceMap: Int32Array; filled: number; skipped: number } {
  const edges = buildEdgeTable(mesh);
  const loops = boundaryLoops(mesh, edges);
  if (!loops.length) return { mesh, faceMap, filled: 0, skipped: 0 };
  const positions = Array.from(mesh.positions);
  const newTris: number[] = [];
  let filled = 0;
  let skipped = 0;
  for (const loop of loops) {
    if (loop.length > maxHoleEdges) {
      skipped++;
      continue;
    }
    // As novas faces percorrem a borda no sentido oposto ao das faces existentes.
    const verts = loop.map((h) => halfEdgeFrom(mesh, h)).reverse();
    const cap =
      fan && verts.length > 3
        ? (() => {
            const f = fanTriangulate(verts, positions);
            return { tris: f.tris, extraVerts: [f.extra] };
          })()
        : capLoop(verts, positions, triangulate);
    if (!cap) continue;
    const { tris, extraVerts } = cap;
    for (const v of extraVerts) positions.push(v[0], v[1], v[2]);
    newTris.push(...tris);
    filled++;
  }
  if (!filled) return { mesh, faceMap, filled, skipped };
  const indices = new Uint32Array(mesh.indices.length + newTris.length);
  indices.set(mesh.indices);
  indices.set(newTris, mesh.indices.length);
  const map = new Int32Array(indices.length / 3).fill(-1);
  map.set(faceMap);
  return { mesh: { positions: new Float32Array(positions), indices }, faceMap: map, filled, skipped };
}

/**
 * Desfaz dobras locais (triângulos que se cruzam, comuns em malhas esculpidas ou geradas): retira as
 * faces envolvidas e uma vizinhança pequena, fecha o buraco pelo contorno e repete, crescendo a
 * vizinhança, até não sobrar cruzamento. Só a região da dobra muda; o resto da malha fica intacto.
 */
export function untangleSelfIntersections(
  input: IndexedMesh,
  inputMap: Int32Array,
  triangulate: Triangulator | null,
  maxRounds = 6,
): { mesh: IndexedMesh; faceMap: Int32Array; found: number; remaining: number; removedFaces: number } {
  let mesh = input;
  let faceMap = inputMap;
  let pairs = findSelfIntersections(mesh, 100000);
  const found = pairs.length;
  let removedFaces = 0;
  if (!found) return { mesh, faceMap, found, remaining: 0, removedFaces };
  // Primeiro desdobra no lugar: suavização amortecida só dos vértices das faces que se cruzam.
  // Dobras de centésimos de milímetro somem movendo os vértices na mesma ordem de grandeza.
  ({ mesh, pairs } = relaxFolds(mesh, pairs));
  // Faces a refazer: as que se cruzam e as que tocam arestas não-manifold de um fechamento anterior.
  const seeds = (m: IndexedMesh, crossing: [number, number][]) => {
    const out = new Set<number>();
    for (const [i, j] of crossing) out.add(i).add(j);
    const edges = buildEdgeTable(m);
    for (let h = 0; h < edges.twin.length; h++) if (edges.twin[h] < 0) out.add((h / 3) | 0);
    return out;
  };
  let pending = seeds(mesh, pairs);
  for (let round = 1; round <= maxRounds && pending.size; round++) {
    const n = triCount(mesh);
    const neighbors = faceNeighbors(mesh);
    const drop = new Uint8Array(n);
    for (const f of pending) drop[f] = 1;
    for (let ring = 1; ring < round; ring++) {
      const grow: number[] = [];
      for (let f = 0; f < n; f++)
        if (drop[f])
          for (let k = 0; k < 3; k++) {
            const g = neighbors[f * 3 + k];
            if (g >= 0 && !drop[g]) grow.push(g);
          }
      for (const f of grow) drop[f] = 1;
    }
    sealPinches(mesh, drop);
    for (let f = 0; f < n; f++) removedFaces += drop[f];
    ({ mesh, faceMap } = removeFaces(mesh, faceMap, drop));
    ({ mesh, faceMap } = fillHoles(mesh, faceMap, Number.MAX_SAFE_INTEGER, triangulate, true));
    pairs = findSelfIntersections(mesh, 100000);
    pending = seeds(mesh, pairs);
  }
  return { mesh: compactMesh(mesh), faceMap, found, remaining: pairs.length, removedFaces };
}

/** Suaviza (com amortecimento) os vértices das faces que se cruzam até a dobra se desfazer. */
function relaxFolds(input: IndexedMesh, crossing: [number, number][], iterations = 24): { mesh: IndexedMesh; pairs: [number, number][] } {
  const positions = input.positions.slice();
  const mesh: IndexedMesh = { positions, indices: input.indices };
  const n = triCount(mesh);
  const nv = positions.length / 3;
  // Vizinhos de cada vértice e faces de cada vértice.
  const adj: Set<number>[] = Array.from({ length: nv }, () => new Set<number>());
  const facesOf: number[][] = Array.from({ length: nv }, () => []);
  for (let f = 0; f < n; f++)
    for (let k = 0; k < 3; k++) {
      const a = mesh.indices[f * 3 + k];
      const b = mesh.indices[f * 3 + ((k + 1) % 3)];
      adj[a].add(b);
      adj[b].add(a);
      facesOf[a].push(f);
    }
  // A BVH aponta para o mesmo array de posições: basta reajustar as caixas a cada passo.
  const bvh = buildBVH(mesh);
  const recheck = (moved: Iterable<number>) => {
    const faces = new Set<number>();
    for (const v of moved) for (const f of facesOf[v]) faces.add(f);
    bvh.refit();
    return findSelfIntersections(mesh, 100000, undefined, undefined, { faces, bvh });
  };
  // Pares ainda abertos: os do começo, atualizados só onde algo se moveu.
  let open = new Map<number, [number, number]>(crossing.map((pr) => [pr[0] * n + pr[1], pr]));
  let bestCount = open.size;
  let best = positions.slice();
  for (let it = 0; it < iterations && open.size; it++) {
    const verts = new Set<number>();
    for (const [i, j] of open.values()) for (const f of [i, j]) for (let k = 0; k < 3; k++) verts.add(mesh.indices[f * 3 + k]);
    const next = new Map<number, [number, number, number]>();
    for (const v of verts) {
      const nb = adj[v];
      if (!nb.size) continue;
      let x = 0;
      let y = 0;
      let z = 0;
      for (const u of nb) {
        x += positions[u * 3];
        y += positions[u * 3 + 1];
        z += positions[u * 3 + 2];
      }
      const k = 0.5 / nb.size;
      next.set(v, [positions[v * 3] * 0.5 + x * k, positions[v * 3 + 1] * 0.5 + y * k, positions[v * 3 + 2] * 0.5 + z * k]);
    }
    for (const [v, q] of next) {
      positions[v * 3] = q[0];
      positions[v * 3 + 1] = q[1];
      positions[v * 3 + 2] = q[2];
    }
    // Pares que envolviam faces movidas são refeitos; os demais continuam como estavam.
    const touched = new Set<number>();
    for (const v of next.keys()) for (const f of facesOf[v]) touched.add(f);
    const kept = [...open.values()].filter(([i, j]) => !touched.has(i) && !touched.has(j));
    open = new Map([...kept, ...recheck(next.keys())].map((pr) => [pr[0] * n + pr[1], pr]));
    if (open.size < bestCount) {
      bestCount = open.size;
      best = positions.slice();
    }
  }
  positions.set(best);
  bvh.geometry.dispose();
  return { mesh, pairs: findSelfIntersections(mesh, 100000) };
}

/**
 * Garante que a região retirada não toque o resto por um vértice só (gravata): nesses vértices o
 * contorno do buraco passaria duas vezes e o fechamento sairia não-manifold. Retira o leque inteiro.
 */
function sealPinches(mesh: IndexedMesh, drop: Uint8Array): void {
  const n = triCount(mesh);
  const nv = mesh.positions.length / 3;
  const start = new Int32Array(nv + 1);
  for (let i = 0; i < n * 3; i++) start[mesh.indices[i] + 1]++;
  for (let v = 0; v < nv; v++) start[v + 1] += start[v];
  const fill = start.slice(0, nv);
  const fan = new Int32Array(n * 3);
  for (let f = 0; f < n; f++) for (let k = 0; k < 3; k++) fan[fill[mesh.indices[f * 3 + k]]++] = f;
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;
    for (let v = 0; v < nv; v++) {
      const faces = fan.subarray(start[v], start[v + 1]);
      let kept = 0;
      let gone = 0;
      for (const f of faces) {
        if (drop[f]) gone++;
        else kept++;
      }
      if (!kept || !gone) continue;
      // Grupos de faces mantidas ao redor de v, ligadas por arestas que passam por v.
      const keptFaces = Array.from(faces).filter((f) => !drop[f]);
      const group = keptFaces.map((_, i) => i);
      const root = (i: number): number => (group[i] === i ? i : (group[i] = root(group[i])));
      for (let a = 0; a < keptFaces.length; a++)
        for (let b = a + 1; b < keptFaces.length; b++) {
          let shared = 0;
          for (let x = 0; x < 3; x++)
            for (let y = 0; y < 3; y++) if (mesh.indices[keptFaces[a] * 3 + x] === mesh.indices[keptFaces[b] * 3 + y]) shared++;
          if (shared >= 2) group[root(a)] = root(b);
        }
      if (new Set(keptFaces.map((_, i) => root(i))).size > 1) {
        for (const f of faces) drop[f] = 1;
        changed = true;
      }
    }
    if (!changed) break;
  }
}

function compactMesh(m: IndexedMesh): IndexedMesh {
  const nv = m.positions.length / 3;
  const remap = new Int32Array(nv).fill(-1);
  let count = 0;
  for (let i = 0; i < m.indices.length; i++) if (remap[m.indices[i]] < 0) remap[m.indices[i]] = count++;
  if (count === nv) return m;
  const positions = new Float32Array(count * 3);
  for (let v = 0; v < nv; v++) {
    const r = remap[v];
    if (r < 0) continue;
    positions[r * 3] = m.positions[v * 3];
    positions[r * 3 + 1] = m.positions[v * 3 + 1];
    positions[r * 3 + 2] = m.positions[v * 3 + 2];
  }
  return { positions, indices: Uint32Array.from(m.indices, (i) => remap[i]) };
}

