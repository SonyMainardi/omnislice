import {
  type Bounds,
  type EdgeTable,
  type IndexedMesh,
  buildEdgeTable,
  computeBounds,
  faceComponents,
  faceNeighbors,
  faceNormalsAndAreas,
  halfEdgeFrom,
  halfEdgeTo,
  triCount,
  vertCount,
} from "./mesh";
import type { Vec3 } from "./math";
import { shellNesting } from "./solids";

export type Severity = "erro" | "aviso" | "info";

export interface Issue {
  severity: Severity;
  code: string;
  message: string;
}

export interface MeshReport {
  triangles: number;
  vertices: number;
  components: number;
  boundaryEdges: number;
  holes: number;
  nonManifoldEdges: number;
  inconsistentEdges: number;
  degenerateFaces: number;
  duplicateFaces: number;
  invertedComponents: number;
  /** Cavidades internas fechadas (objeto oco): cascas aninhadas com as normais para dentro. */
  voids: number;
  /** Cascas fechadas inteiras dentro de outra com as normais para fora (material sobreposto). */
  embeddedShells: number;
  /** Volume em comum entre cascas que se sobrepõem (mm³; null = não verificado). */
  overlapVolume: number | null;
  /** Malha fechada (sem bordas abertas nem arestas não-manifold). */
  watertight: boolean;
  /** Volume (mm³) quando a malha é fechada; caso contrário é uma estimativa. */
  volume: number;
  area: number;
  bounds: Bounds;
  size: Vec3;
  /** Interseções entre triângulos (null = não verificado). */
  selfIntersections: number | null;
  issues: Issue[];
}

/** Ids de face degenerada (área ~0 ou índices repetidos). */
export function findDegenerateFaces(m: IndexedMesh, areaEps?: number): Uint8Array {
  const n = triCount(m);
  const out = new Uint8Array(n);
  const { areas } = faceNormalsAndAreas(m);
  let total = 0;
  for (let i = 0; i < n; i++) total += areas[i];
  const eps = areaEps ?? Math.max((total / Math.max(n, 1)) * 1e-9, 1e-14);
  for (let f = 0; f < n; f++) {
    const a = m.indices[f * 3];
    const b = m.indices[f * 3 + 1];
    const c = m.indices[f * 3 + 2];
    if (a === b || b === c || a === c || areas[f] <= eps) out[f] = 1;
  }
  return out;
}

/** Marca faces duplicadas (mesmo conjunto de vértices), mantendo a primeira ocorrência. */
export function findDuplicateFaces(m: IndexedMesh): Uint8Array {
  const n = triCount(m);
  const out = new Uint8Array(n);
  const seen = new Map<string, number>();
  for (let f = 0; f < n; f++) {
    const t = [m.indices[f * 3], m.indices[f * 3 + 1], m.indices[f * 3 + 2]].sort((x, y) => x - y);
    const key = `${t[0]},${t[1]},${t[2]}`;
    if (seen.has(key)) out[f] = 1;
    else seen.set(key, f);
  }
  return out;
}

/** Laços de borda (buracos) como listas de meias-arestas encadeadas. */
export function boundaryLoops(m: IndexedMesh, edges: EdgeTable): number[][] {
  const outgoing = new Map<number, number[]>();
  for (let h = 0; h < edges.twin.length; h++) {
    if (edges.twin[h] !== -1) continue;
    const from = halfEdgeFrom(m, h);
    const list = outgoing.get(from);
    if (list) list.push(h);
    else outgoing.set(from, [h]);
  }
  const used = new Set<number>();
  const loops: number[][] = [];
  for (const [, list] of outgoing) {
    for (const start of list) {
      if (used.has(start)) continue;
      const loop: number[] = [];
      let h = start;
      let guard = 0;
      while (!used.has(h) && guard++ < edges.twin.length) {
        used.add(h);
        loop.push(h);
        const next = outgoing.get(halfEdgeTo(m, h));
        const candidate = next?.find((x) => !used.has(x));
        if (candidate === undefined) break;
        h = candidate;
      }
      if (loop.length >= 3) loops.push(loop);
    }
  }
  return loops;
}

/** Buracos contados como grupos conexos de arestas de borda (não depende da orientação das faces). */
function countBoundaryComponents(m: IndexedMesh, edges: EdgeTable): number {
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let c = x;
    while (c !== r) {
      const next = parent.get(c)!;
      parent.set(c, r);
      c = next;
    }
    return r;
  };
  for (let e = 0; e < edges.numEdges; e++) {
    if (edges.edgeCount[e] !== 1) continue;
    const h = edges.edgeFirst[e];
    const a = halfEdgeFrom(m, h);
    const b = halfEdgeTo(m, h);
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }
  const roots = new Set<number>();
  for (const v of parent.keys()) roots.add(find(v));
  return roots.size;
}

export function analyzeMesh(m: IndexedMesh): MeshReport {
  const n = triCount(m);
  const edges = buildEdgeTable(m);
  let boundaryEdges = 0;
  let nonManifoldEdges = 0;
  let inconsistentEdges = 0;
  for (let e = 0; e < edges.numEdges; e++) {
    const c = edges.edgeCount[e];
    if (c === 1) boundaryEdges++;
    else if (c > 2) nonManifoldEdges++;
    else {
      const h = edges.edgeFirst[e];
      const t = edges.twin[h];
      // Arestas consistentes são percorridas em sentidos opostos pelas duas faces.
      if (t >= 0 && halfEdgeFrom(m, h) === halfEdgeFrom(m, t)) inconsistentEdges++;
    }
  }
  const holes = boundaryEdges > 0 ? countBoundaryComponents(m, edges) : 0;
  const degenerate = findDegenerateFaces(m);
  const duplicate = findDuplicateFaces(m);
  let degenerateFaces = 0;
  let duplicateFaces = 0;
  for (let f = 0; f < n; f++) {
    degenerateFaces += degenerate[f];
    duplicateFaces += duplicate[f];
  }
  const neighbors = faceNeighbors(m, edges);
  const { count: components, comp } = faceComponents(m, neighbors);
  const { areas } = faceNormalsAndAreas(m);
  const compVolume = new Float64Array(components);
  const compOpen = new Uint8Array(components);
  let area = 0;
  const p = m.positions;
  for (let f = 0; f < n; f++) {
    area += areas[f];
    const a = m.indices[f * 3] * 3;
    const b = m.indices[f * 3 + 1] * 3;
    const c = m.indices[f * 3 + 2] * 3;
    compVolume[comp[f]] +=
      (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) -
        p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
        p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) /
      6;
    for (let k = 0; k < 3; k++) if (edges.twin[f * 3 + k] < 0) compOpen[comp[f]] = 1;
  }
  // Casca externa com volume negativo está do avesso. Dentro de um sólido, uma casca com as normais
  // para dentro é uma cavidade (objeto oco); com as normais para fora é material sobreposto, que o
  // fatiador preenche (por isso não é "corrigida" para cavidade).
  const shells = shellNesting(m, neighbors);
  let volume = 0;
  let invertedComponents = 0;
  let voids = 0;
  let embeddedShells = 0;
  let solids = 0;
  for (let c = 0; c < components; c++) {
    volume += compVolume[c];
    const nestedInSolid = shells[c].depth % 2 === 1;
    if (compOpen[c]) {
      solids++;
      continue;
    }
    if (!nestedInSolid) {
      solids++;
      if (compVolume[c] < 0) invertedComponents++;
    } else if (compVolume[c] < 0) voids++;
    else embeddedShells++;
  }
  const bounds = computeBounds(m.positions);
  const size: Vec3 = [bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]];
  const watertight = boundaryEdges === 0 && nonManifoldEdges === 0;
  const report: MeshReport = {
    triangles: n,
    vertices: vertCount(m),
    components: solids,
    boundaryEdges,
    holes,
    nonManifoldEdges,
    inconsistentEdges,
    degenerateFaces,
    duplicateFaces,
    invertedComponents,
    voids,
    embeddedShells,
    overlapVolume: null,
    watertight,
    volume: Math.abs(volume),
    area,
    bounds,
    size,
    selfIntersections: null,
    issues: [],
  };
  report.issues = describeIssues(report);
  return report;
}

export function describeIssues(r: MeshReport): Issue[] {
  const issues: Issue[] = [];
  if (r.triangles === 0) {
    issues.push({ severity: "erro", code: "vazio", message: "O arquivo não contém triângulos." });
    return issues;
  }
  if (r.holes > 0)
    issues.push({
      severity: "erro",
      code: "buracos",
      message: `${r.holes} buraco(s) na superfície (${r.boundaryEdges} arestas abertas). A malha não é estanque.`,
    });
  if (r.nonManifoldEdges > 0)
    issues.push({
      severity: "erro",
      code: "nao-manifold",
      message: `${r.nonManifoldEdges} aresta(s) não-manifold (compartilhadas por mais de duas faces).`,
    });
  if (r.inconsistentEdges > 0)
    issues.push({
      severity: "aviso",
      code: "orientacao",
      message: `${r.inconsistentEdges} aresta(s) com faces em orientação inconsistente (normais invertidas).`,
    });
  if (r.invertedComponents > 0)
    issues.push({
      severity: "aviso",
      code: "invertido",
      message: `${r.invertedComponents} parte(s) fechada(s) com normais para dentro.`,
    });
  if (r.degenerateFaces > 0)
    issues.push({
      severity: "aviso",
      code: "degeneradas",
      message: `${r.degenerateFaces} face(s) degenerada(s) (área zero).`,
    });
  if (r.duplicateFaces > 0)
    issues.push({ severity: "aviso", code: "duplicadas", message: `${r.duplicateFaces} face(s) duplicada(s).` });
  if (r.selfIntersections && r.selfIntersections > 0)
    issues.push({
      severity: "aviso",
      code: "intersecoes",
      message: `${r.selfIntersections}${r.selfIntersections >= 1000 ? "+" : ""} par(es) de triângulos se cruzando.`,
    });
  if (r.components > 1)
    issues.push({
      severity: "info",
      code: "componentes",
      message: `${r.components} cascas separadas no mesmo arquivo.`,
    });
  if (r.voids > 0)
    issues.push({
      severity: "info",
      code: "oco",
      message: `Objeto oco: ${r.voids} cavidade(s) interna(s) fechada(s), preservada(s) nos cortes.`,
    });
  if (r.overlapVolume && r.overlapVolume > 1e-3)
    issues.push({
      severity: "aviso",
      code: "sobreposicao",
      message: `Cascas sobrepostas (${r.overlapVolume.toFixed(1)} mm³ em comum). O reparo une as cascas como o fatiador faria.`,
    });
  else if (r.embeddedShells > 0 && r.overlapVolume === null)
    issues.push({
      severity: "aviso",
      code: "sobreposicao",
      message: `${r.embeddedShells} casca(s) dentro de outra (material sobreposto). O reparo une as cascas.`,
    });
  const maxDim = Math.max(...r.size);
  if (maxDim < 1)
    issues.push({
      severity: "aviso",
      code: "escala",
      message: `O modelo mede só ${maxDim.toFixed(3)} mm. Talvez esteja em metros ou centímetros: ajuste a escala.`,
    });
  if (issues.every((i) => i.severity === "info"))
    issues.unshift({ severity: "info", code: "ok", message: "Malha fechada e consistente, pronta para dividir." });
  return issues;
}
