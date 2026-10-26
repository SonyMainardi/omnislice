import type { CrossSection, Manifold } from "manifold-3d";
import { boundaryLoops } from "./analysis";
import {
  type BoundaryLoop,
  centroidOfFaces,
  cleanLabels,
  growFaces,
  islandLoops,
  labelIslands,
  sideOfLoop,
} from "./labels";
import { Arena, GeometryError, RunRegistry, type Wasm, halfSpaceSize } from "./manifoldBridge";
import { type PlaneFrame, type Vec2, type Vec3, add, dot, fitPlane, frameFromNormal, scale, sub, toLocal } from "./math";
import { type IndexedMesh, buildEdgeTable, faceCentroids, faceNeighbors, faceNormalsAndAreas, halfEdgeFrom, triCount } from "./mesh";
import { type PartGeometry, cutTag, tagCutId, tagSide } from "./part";
import { type Triangulator, capLoop } from "./repair";
import { FDM_MIN_WALL, FLAP_WIDTH, capFlap } from "./flaps";
import { decomposeSolids } from "./solids";

export interface CutRecord {
  id: number;
  kind: "plane" | "seam";
  frame: PlaneFrame;
}

export function wasmTriangulator(w: Wasm): Triangulator {
  return (poly) => {
    try {
      const tris = w.triangulate([poly]);
      const out: number[] = [];
      for (const t of tris) out.push(t[0], t[1], t[2]);
      return out;
    } catch {
      return null;
    }
  };
}

/** Remove pedaços numéricos sem volume que às vezes sobram de cortes tangentes. */
function meaningful(parts: Manifold[], total: number): Manifold[] {
  return parts.filter((p) => Math.abs(p.volume()) > Math.max(total * 1e-7, 1e-4));
}

// ---------------------------------------------------------------------------------------------
// Cortes exatos limitados a uma região
// ---------------------------------------------------------------------------------------------
//
// Um plano infinito atravessa o modelo inteiro: o plano do ombro também corta a base, o do pescoço
// corta as mãos erguidas. Juntar de volta os pedaços cortados à toa (união) deixa as duas faces do
// corte coladas por dentro da peça, e subtrair uma peça derivada do sólido deixa lâminas de
// arredondamento. Por isso cada separação é um único corte do sólido original por um cortador que é
// o semi-espaço limitado a um envoltório: uma caixa ou o casco convexo da peça esperada, que não pode
// encostar em nenhum outro trecho do sólido.

type Envelope = (m: Manifold) => Manifold;

function boxEnvelope(w: Wasm, margin: (size: number) => number): Envelope {
  return (m) => {
    const b = m.boundingBox();
    const size = Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
    const e = margin(size);
    return w.Manifold.cube([b.max[0] - b.min[0] + 2 * e, b.max[1] - b.min[1] + 2 * e, b.max[2] - b.min[2] + 2 * e]).translate([
      b.min[0] - e,
      b.min[1] - e,
      b.min[2] - e,
    ]);
  };
}

function hullEnvelope(factor: number): Envelope {
  return (m) => {
    const h = m.hull();
    const v = h.getMesh().vertProperties;
    const c: Vec3 = [0, 0, 0];
    const nv = v.length / 3;
    for (let i = 0; i < v.length; i += 3) {
      c[0] += v[i] / nv;
      c[1] += v[i + 1] / nv;
      c[2] += v[i + 2] / nv;
    }
    const out = h.translate([-c[0], -c[1], -c[2]]).scale(factor).translate(c);
    h.delete();
    return out;
  };
}

function envelopes(w: Wasm): Envelope[] {
  return [
    boxEnvelope(w, (s) => Math.max(0.5, s * 0.02)),
    boxEnvelope(w, (s) => Math.max(0.02, s * 0.001)),
    hullEnvelope(1.02),
    hullEnvelope(1.001),
  ];
}

/** Envoltório com origem própria: se alguma face dele aparecer no resultado, ele encostou no sólido. */
function guarded(m: Manifold, ids: number[]): Manifold {
  const g = m.asOriginal();
  m.delete();
  ids.push(g.originalID());
  return g;
}

function touchesGuard(m: Manifold, ids: number[]): boolean {
  const mesh = m.getMesh();
  // O Manifold mantém na lista trechos ("runs") vazios: só conta o que tem triângulos.
  for (let r = 0; r < mesh.numRun; r++)
    if (ids.includes(mesh.runOriginalID[r]) && mesh.runIndex[r + 1] > mesh.runIndex[r]) return true;
  return false;
}

/**
 * Corta `whole` uma única vez por `buildCutter(envelope)` e aceita o resultado se nenhum envoltório
 * encostou no sólido e a parte de dentro tem o volume esperado. Tenta envoltórios cada vez mais
 * justos; devolve null se nenhum serve.
 */
function exactSplit(
  w: Wasm,
  arena: Arena,
  whole: Manifold,
  expectedInside: number,
  buildCutter: (envelope: Envelope, guards: number[]) => Manifold,
): [Manifold, Manifold] | null {
  const vWhole = whole.volume();
  const tol = Math.max(Math.abs(vWhole) * 1e-7, 1e-6);
  for (const envelope of envelopes(w)) {
    const guards: number[] = [];
    const cutter = buildCutter(envelope, guards);
    const [inside, outside] = whole.split(cutter);
    cutter.delete();
    const ok =
      !touchesGuard(inside, guards) &&
      !touchesGuard(outside, guards) &&
      Math.abs(inside.volume() - expectedInside) <= tol &&
      Math.abs(outside.volume() - (vWhole - expectedInside)) <= tol;
    if (ok) return [arena.track(inside), arena.track(outside)];
    if (process.env.OMNISLICE_DEBUG)
      console.log("exactSplit falhou:", { guardIn: touchesGuard(inside, guards), guardOut: touchesGuard(outside, guards), vIn: inside.volume(), expectedInside, vOut: outside.volume(), vWhole });
    inside.delete();
    outside.delete();
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Corte por plano
// ---------------------------------------------------------------------------------------------

export interface PlaneCutResult {
  front: PartGeometry[];
  back: PartGeometry[];
}

/**
 * Corta uma peça por um plano. O lado para onde a normal aponta é a "frente".
 * Com `separateComponents`, cada pedaço solto de cada lado vira uma peça própria.
 */
export function cutByPlane(
  w: Wasm,
  g: PartGeometry,
  frame: PlaneFrame,
  cutId: number,
  separateComponents: boolean,
): PlaneCutResult {
  const reg = new RunRegistry(w);
  const arena = new Arena();
  try {
    const solid = arena.track(reg.fromGeometry(g));
    const total = Math.abs(solid.volume());
    const cutter = arena.track(reg.halfSpace(frame, halfSpaceSize(solid), cutId));
    const [pos, neg] = arena.trackAll(solid.split(cutter));
    const minVolume = Math.max(total * 1e-4, 1e-3);
    if (Math.abs(pos.volume()) < minVolume || Math.abs(neg.volume()) < minVolume)
      throw new GeometryError(
        "O plano não atravessa a peça. Mova ou gire o plano até ele cruzar o modelo.",
        "plano-fora",
      );
    // Migalhas: pedacinhos soltos de um lado que encostam no outro (a ponta de uma mão que desce
    // além do plano, a lente fina de um plano quase tangente) voltam para o lado que tocam, em vez
    // de virarem peças minúsculas. Separando pedaços soltos, só os que seriam fragmentos voltam.
    const posC = arena.trackAll(decomposeSolids(pos));
    const negC = arena.trackAll(decomposeSolids(neg));
    const crumbs = (list: Manifold[], other: Manifold) => {
      if (list.length < 2) return [];
      const side = list.reduce((s, c) => s + Math.abs(c.volume()), 0);
      return list.filter((c) => {
        const v = Math.abs(c.volume());
        const small = separateComponents
          ? v < Math.max(total * 1e-3, 1) || (2 * v) / Math.max(c.surfaceArea(), 1e-12) < 0.3
          : v < side * 0.03;
        return small && c.minGap(other, 0.01) < 1e-3;
      });
    };
    const toNeg = crumbs(posC, neg);
    const toPos = crumbs(negC, pos);
    const pieces = (m: Manifold) =>
      separateComponents ? meaningful(arena.trackAll(decomposeSolids(m)), total).map((x) => reg.toGeometry(x)) : [reg.toGeometry(m)];
    if (!toNeg.length && !toPos.length) return { front: pieces(pos), back: pieces(neg) };
    // Um único corte exato em que o plano desvia das migalhas: o cortador é o semi-espaço sem os
    // envoltórios das migalhas da frente e com os envoltórios das migalhas do verso.
    const expectedFront =
      posC.filter((c) => !toNeg.includes(c)).reduce((s, c) => s + c.volume(), 0) + toPos.reduce((s, c) => s + c.volume(), 0);
    const exact = exactSplit(w, arena, solid, expectedFront, (envelope, guards) => {
      let region = reg.halfSpace(frame, halfSpaceSize(solid), cutId);
      for (const c of toNeg) {
        const e = guarded(envelope(c), guards);
        const next = region.subtract(e);
        region.delete();
        e.delete();
        region = next;
      }
      for (const c of toPos) {
        const e = guarded(envelope(c), guards);
        const next = region.add(e);
        region.delete();
        e.delete();
        region = next;
      }
      return region;
    });
    // Sem envoltório que sirva, as migalhas ficam onde o plano as deixou (o relatório avisa).
    if (!exact) return { front: pieces(pos), back: pieces(neg) };
    return { front: pieces(exact[0]), back: pieces(exact[1]) };
  } finally {
    arena.dispose();
  }
}

/** Separa cascas soltas de uma peça em peças independentes. */
export function splitComponents(w: Wasm, g: PartGeometry): PartGeometry[] {
  const reg = new RunRegistry(w);
  const arena = new Arena();
  try {
    const solid = arena.track(reg.fromGeometry(g));
    const total = Math.abs(solid.volume());
    return meaningful(arena.trackAll(decomposeSolids(solid)), total).map((m) => reg.toGeometry(m));
  } finally {
    arena.dispose();
  }
}

/** Une várias peças em uma só (união booleana). */
export function unionParts(w: Wasm, parts: PartGeometry[]): PartGeometry {
  const reg = new RunRegistry(w);
  const arena = new Arena();
  try {
    const solids = parts.map((p) => arena.track(reg.fromGeometry(p)));
    return reg.toGeometry(arena.track(w.Manifold.union(solids)));
  } finally {
    arena.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// Divisão por regiões pintadas
// ---------------------------------------------------------------------------------------------

export type SplitMode = "auto" | "plane" | "seam";

export interface RegionSplitInput {
  geometry: PartGeometry;
  /** Rótulo por triângulo de `geometry.mesh`. */
  labels: Uint16Array;
  /** Rótulos que viram peças próprias; os demais se juntam ao rótulo-base. */
  separate: number[];
  baseLabel: number;
  mode: SplitMode;
  firstCutId: number;
  /** Fração mínima de área correta para aceitar um corte plano (0–1). */
  purityThreshold?: number;
  /** Limpa ilhas minúsculas e serrilhados da pintura antes de cortar. */
  cleanup?: boolean;
}

export interface IslandReport {
  label: number;
  method: "plano" | "contorno" | "componente" | "falhou";
  purity: number;
  completeness: number;
  message?: string;
}

export interface RegionSplitResult {
  parts: { label: number; geometry: PartGeometry }[];
  cuts: CutRecord[];
  islands: IslandReport[];
  nextCutId: number;
  /** Rótulos efetivamente usados (após limpeza), por triângulo da entrada. */
  cleanedLabels: Uint16Array;
}

interface FaceStats {
  islandArea: number;
  originArea: number;
  ringHits: number;
  sideArea: number;
  /** Área perto da junção e quanto dela é da ilha. */
  nearArea: number;
  nearIslandArea: number;
  /** Triângulos do outro lado do laço ainda presentes. */
  outerHits: number;
}

/**
 * Divide uma peça seguindo regiões pintadas. Ilhas "folha" (com uma única costura) são destacadas
 * primeiro; cada costura vira um corte plano ajustado ao contorno ou, se o plano atravessar outra
 * parte do modelo, um corte que segue exatamente o contorno pintado, fechado por uma tampa triangulada.
 */
export function splitByRegions(w: Wasm, input: RegionSplitInput, triangulate: Triangulator): RegionSplitResult {
  const { geometry, baseLabel, mode } = input;
  const purityThreshold = input.purityThreshold ?? 0.97;
  const mesh = geometry.mesh;
  const n = triCount(mesh);
  if (input.labels.length !== n) throw new GeometryError("Pintura e malha não correspondem.", "rotulos");

  const edges = buildEdgeTable(mesh);
  const neighbors = faceNeighbors(mesh, edges);
  if (boundaryLoops(mesh, edges).length > 0)
    throw new GeometryError("A peça tem buracos. Repare a malha antes de dividir.", "aberta");
  const { areas, normals: normalsArr } = faceNormalsAndAreas(mesh);
  const centroids = faceCentroids(mesh);
  let totalArea = 0;
  for (let f = 0; f < n; f++) totalArea += areas[f];

  const separate = new Set(input.separate.filter((l) => l !== baseLabel));
  let labels: Uint16Array = new Uint16Array(n);
  for (let f = 0; f < n; f++) labels[f] = separate.has(input.labels[f]) ? input.labels[f] : baseLabel;
  if (input.cleanup !== false)
    labels = cleanLabels(labels, neighbors, areas, {
      minIslandArea: totalArea * 0.001,
      minIslandFaces: 8,
      smoothIterations: 3,
    });

  labels = attachDetachedBase(labels, neighbors, areas, baseLabel);
  const { islands, islandOf } = labelIslands(labels, neighbors, areas);
  let baseIsland = -1;
  for (const isl of islands)
    if (isl.label === baseLabel && (baseIsland < 0 || isl.area > islands[baseIsland].area)) baseIsland = isl.id;
  if (baseIsland < 0) baseIsland = islands.reduce((b, i) => (i.area > islands[b].area ? i.id : b), 0);

  const loopsByIsland = new Map<number, BoundaryLoop[]>();
  for (const isl of islands) {
    if (isl.id === baseIsland) continue;
    const set = new Uint8Array(n);
    for (const f of isl.faces) set[f] = 1;
    loopsByIsland.set(isl.id, mergeCoplanarLoops(mesh, islandLoops(mesh, edges, (f) => set[f] === 1, isl.faces, islandOf)));
  }

  // Todo objeto do WASM fica no Arena e é liberado ao final; só os PartGeometry saem daqui.
  const reg = new RunRegistry(w);
  const arena = new Arena();
  const cuts: CutRecord[] = [];
  const reports: IslandReport[] = [];
  let nextCutId = input.firstCutId;
  const resultsByLabel = new Map<number, Manifold[]>();
  const peeled = new Set<number>();

  // A geometria de trabalho troca `src` pelo índice do triângulo, para rastrear os rótulos.
  const work: PartGeometry = { mesh, src: Int32Array.from({ length: n }, (_, i) => i), cut: geometry.cut };

  /** Libera sólidos intermediários assim que deixam de ser usados (o heap do WASM é limitado). */
  const free = (...ms: Manifold[]) => {
    for (const m of ms) {
      arena.release(m);
      m.delete();
    }
  };

  const push = (label: number, m: Manifold) => {
    const list = resultsByLabel.get(label);
    if (list) list.push(m);
    else resultsByLabel.set(label, [m]);
  };

  const statsOf = (
    m: Manifold,
    island: number,
    ring?: Set<number>,
    side?: Uint8Array,
    near?: Uint8Array,
    outer?: Set<number>,
  ): FaceStats => {
    const g = reg.toGeometry(m);
    const a = faceNormalsAndAreas(g.mesh).areas;
    const s: FaceStats = { islandArea: 0, originArea: 0, ringHits: 0, sideArea: 0, nearArea: 0, nearIslandArea: 0, outerHits: 0 };
    for (let t = 0; t < g.src.length; t++) {
      const o = g.src[t];
      if (o < 0) continue;
      s.originArea += a[t];
      if (islandOf[o] === island) s.islandArea += a[t];
      if (ring?.has(o)) s.ringHits++;
      if (outer?.has(o)) s.outerHits++;
      if (side?.[o]) s.sideArea += a[t];
      if (near?.[o]) {
        s.nearArea += a[t];
        if (islandOf[o] === island) s.nearIslandArea += a[t];
      }
    }
    return s;
  };

  /** Pureza do pedaço: pelo lado do laço e, perto da junção, só faces da própria ilha. */
  const purityOf = (s: FaceStats) => {
    const bySide = s.originArea > 0 ? s.sideArea / s.originArea : 0;
    const local = s.nearArea > 0 ? s.nearIslandArea / s.nearArea : 1;
    return Math.min(bySide, local);
  };

  /** Faixa ao redor do laço: o que o plano corta ali é o que importa para a pureza. */
  const nearMask = (fit: ReturnType<typeof fitPlane>) => {
    const r = 3 * fit.radius + 2;
    const r2 = r * r;
    const mask = new Uint8Array(n);
    for (let f = 0; f < n; f++) {
      const dx = centroids[f * 3] - fit.centroid[0];
      const dy = centroids[f * 3 + 1] - fit.centroid[1];
      const dz = centroids[f * 3 + 2] - fit.centroid[2];
      if (dx * dx + dy * dy + dz * dz < r2) mask[f] = 1;
    }
    return mask;
  };

  const unresolved = (id: number) =>
    (loopsByIsland.get(id) ?? []).filter((l) => [...l.neighborIslands].some((j) => !peeled.has(j)));

  const loopFrame = (island: number, loop: BoundaryLoop) => {
    const pts = new Float64Array(loop.vertices.length * 3);
    loop.vertices.forEach((v, i) => {
      pts[i * 3] = mesh.positions[v * 3];
      pts[i * 3 + 1] = mesh.positions[v * 3 + 1];
      pts[i * 3 + 2] = mesh.positions[v * 3 + 2];
    });
    const fit = fitPlane(pts, loop.vertices.length);
    // Orienta a normal para dentro da ilha comparando faixas de faces dos dois lados do laço.
    const inner = growFaces(loop.innerFaces, neighbors, (f) => islandOf[f] === island, 4);
    const outer = growFaces(loop.outerFaces, neighbors, (f) => islandOf[f] !== island, 4);
    const ci = centroidOfFaces(inner, centroids, areas);
    const co = centroidOfFaces(outer, centroids, areas);
    const normal = dot(fit.normal, sub(ci, co)) < 0 ? scale(fit.normal, -1) : fit.normal;
    return { fit, normal };
  };

  try {
    let rest = arena.track(reg.fromGeometry(work));
    const size = halfSpaceSize(rest);
    // Ilhas desprezíveis (faces degeneradas, pontinhos de pintura) ficam com o corpo principal.
    const pending = islands.filter((i) => i.id !== baseIsland && i.area >= totalArea * 0.0005 && i.faces.length >= 3);

    /**
     * Avalia planos candidatos sem booleanas: inunda a superfície a partir das faces do contorno,
     * só por faces do lado positivo, e mede quanto do pedaço resultante é do lado certo do laço.
     */
    const rankPlanes = (
      island: number,
      loop: BoundaryLoop,
      fit: ReturnType<typeof fitPlane>,
      normal: Vec3,
      side: Uint8Array,
      near: Uint8Array,
    ): { frame: PlaneFrame; penalty: number; score: number }[] => {
      const isl = islands[island];
      // Eixo principal da ilha (para membros alongados, o corte perpendicular ao eixo é o natural).
      const pts = new Float64Array(isl.faces.length * 3);
      isl.faces.forEach((f, i) => {
        pts[i * 3] = centroids[f * 3];
        pts[i * 3 + 1] = centroids[f * 3 + 1];
        pts[i * 3 + 2] = centroids[f * 3 + 2];
      });
      const shape = fitPlane(pts, isl.faces.length);
      const ic = shape.centroid;
      let axis = shape.axes[0];
      if (dot(axis, sub(ic, fit.centroid)) < 0) axis = scale(axis, -1);
      const spread = shape.axes.map((a) => {
        let lo = Infinity;
        let hi = -Infinity;
        for (let i = 0; i < isl.faces.length; i++) {
          const t = dot([pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]], a);
          lo = Math.min(lo, t);
          hi = Math.max(hi, t);
        }
        return hi - lo;
      });
      const normals: { n: Vec3; penalty: number }[] = [{ n: normal, penalty: 0 }];
      if (spread[0] > spread[1] * 1.6 && dot(axis, normal) > 0.2) {
        normals.push({ n: axis, penalty: 0.002 });
        const mid = add(axis, normal);
        normals.push({ n: scale(mid, 1 / Math.hypot(...mid)), penalty: 0.001 });
      }
      // Ilhas achatadas (uma base, por exemplo): o corte natural é paralelo à face larga.
      let thin = shape.axes[2];
      const towards = dot(thin, sub(ic, fit.centroid));
      if (towards < 0) thin = scale(thin, -1);
      if (spread[2] < spread[1] * 0.3 && Math.abs(towards) > 1e-3 && Math.abs(dot(thin, normal)) < 0.999)
        normals.push({ n: thin, penalty: 0.001 });
      // Normais a poucos graus de um eixo do mundo são endireitadas (bases, cortes horizontais).
      for (const c of normals.slice())
        for (let k = 0; k < 3; k++) {
          const axisVec: Vec3 = [0, 0, 0];
          axisVec[k] = Math.sign(c.n[k]) || 1;
          if (Math.abs(c.n[k]) > Math.cos((6 * Math.PI) / 180) && Math.abs(c.n[k]) < 0.99999)
            normals.push({ n: axisVec, penalty: c.penalty - 0.003 });
        }
      // Também testa as normais invertidas: a orientação estimada pelo contorno pode falhar.
      for (const c of normals.slice()) normals.push({ n: scale(c.n, -1), penalty: c.penalty + 0.01 });
      // Faces planas grandes e paralelas perto da junção (ex.: o topo de uma base): o corte
      // "gruda" nelas para não deixar lâminas finas de um lado ou do outro.
      const flatOffsets = (nrm: Vec3): number[] => {
        const buckets = new Map<number, number>();
        const sums = new Map<number, number>();
        const c0 = dot(fit.centroid, nrm);
        for (let f = 0; f < n; f++) {
          const cos = normalsArr[f * 3] * nrm[0] + normalsArr[f * 3 + 1] * nrm[1] + normalsArr[f * 3 + 2] * nrm[2];
          // Só faces voltadas para o lado vizinho (ex.: o topo da base, não o fundo dela).
          if (cos > -0.998) continue;
          const d = centroids[f * 3] * nrm[0] + centroids[f * 3 + 1] * nrm[1] + centroids[f * 3 + 2] * nrm[2] - c0;
          if (Math.abs(d) > fit.radius) continue;
          const key = Math.round(d / 0.02);
          buckets.set(key, (buckets.get(key) ?? 0) + areas[f]);
          sums.set(key, (sums.get(key) ?? 0) + d * areas[f]);
        }
        let bestKey = 0;
        let bestArea = 0;
        // Entre as faces planas grandes, a mais próxima da junção.
        for (const [key, a] of buckets)
          if (a > fit.radius * fit.radius * 2 && (bestArea === 0 || Math.abs(key) < Math.abs(bestKey))) {
            bestArea = a;
            bestKey = key;
          }
        // Média exata das faces do grupo: o plano cai exatamente na face, sem película fina.
        const exact = (sums.get(bestKey) ?? 0) / Math.max(bestArea, 1e-12);
        return bestArea > fit.radius * fit.radius * 2 ? [exact / Math.max(fit.radius, 1e-9)] : [];
      };
      const present = (f: number) => !peeled.has(islandOf[f]);
      const out: { frame: PlaneFrame; penalty: number; score: number }[] = [];
      const visited = new Int32Array(n).fill(-1);
      let stamp = 0;
      for (const { n: nrm, penalty } of normals) {
        const flats = flatOffsets(nrm);
        for (const k of [...[0, 0.1, 0.2, 0.35, 0.5, 0.75], ...flats]) {
          const origin = add(fit.centroid, scale(nrm, k * fit.radius));
          const d0 = dot(origin, nrm);
          const eps = 1e-4 * Math.max(fit.radius, 1);
          // Faces sobre o próprio plano ficam do lado em que está o sólido delas (oposto à normal da face).
          const positive = (f: number) => {
            const d = centroids[f * 3] * nrm[0] + centroids[f * 3 + 1] * nrm[1] + centroids[f * 3 + 2] * nrm[2] - d0;
            if (d > eps) return true;
            if (d < -eps) return false;
            return normalsArr[f * 3] * nrm[0] + normalsArr[f * 3 + 1] * nrm[1] + normalsArr[f * 3 + 2] * nrm[2] < 0;
          };
          stamp++;
          const stack: number[] = [];
          for (const f of loop.innerFaces) if (positive(f) && visited[f] !== stamp) (visited[f] = stamp), stack.push(f);
          if (!stack.length)
            for (const f of isl.faces) if (positive(f) && visited[f] !== stamp) (visited[f] = stamp), stack.push(f);
          let sArea = 0;
          let sideArea = 0;
          let islandArea = 0;
          let nearArea = 0;
          let nearIsland = 0;
          while (stack.length) {
            const f = stack.pop()!;
            sArea += areas[f];
            if (side[f]) sideArea += areas[f];
            if (islandOf[f] === island) islandArea += areas[f];
            if (near[f]) {
              nearArea += areas[f];
              if (islandOf[f] === island) nearIsland += areas[f];
            }
            for (let j = 0; j < 3; j++) {
              const g = neighbors[f * 3 + j];
              if (g < 0 || visited[g] === stamp || !present(g) || !positive(g)) continue;
              visited[g] = stamp;
              stack.push(g);
            }
          }
          if (sArea <= 0) continue;
          const purity = Math.min(sideArea / sArea, nearArea > 0 ? nearIsland / nearArea : 1);
          const completeness = isl.area > 0 ? islandArea / isl.area : 0;
          // Cortar exatamente numa face plana grande (topo de uma base) é o corte limpo: bônus.
          const p = penalty + 0.01 * Math.abs(k) - (flats.includes(k) ? 0.12 : 0);
          out.push({
            frame: frameFromNormal(origin, nrm),
            penalty: p,
            score: purity - 2 * Math.max(0, 0.95 - completeness) - p,
          });
        }
      }
      return out.sort((a, b) => b.score - a.score);
    };

    /**
     * Maior aba (mm) que o plano deixaria: na tampa da peça e, do outro lado, só na mesma região
     * (o plano infinito também cortou longe dali, onde o corte exato não vai cortar).
     */
    const flapAcross = (piece: Manifold, other: Manifold, frame: PlaneFrame, cutId: number): number => {
      const gp = reg.toGeometry(piece);
      const tag = cutTag(cutId, 0);
      let lo: Vec2 = [Infinity, Infinity];
      let hi: Vec2 = [-Infinity, -Infinity];
      for (let t = 0; t < gp.cut.length; t++) {
        if (gp.cut[t] !== tag) continue;
        for (let k = 0; k < 3; k++) {
          const v = gp.mesh.indices[t * 3 + k] * 3;
          const l = toLocal(frame, [gp.mesh.positions[v], gp.mesh.positions[v + 1], gp.mesh.positions[v + 2]]);
          // Margem de uma aba inteira além da tampa: a lâmina do outro lado nasce na borda dela.
          lo = [Math.min(lo[0], l[0] - FLAP_WIDTH - 2), Math.min(lo[1], l[1] - FLAP_WIDTH - 2)];
          hi = [Math.max(hi[0], l[0] + FLAP_WIDTH + 2), Math.max(hi[1], l[1] + FLAP_WIDTH + 2)];
        }
      }
      if (!(hi[0] > lo[0])) return 0;
      const a = capFlap(gp, tag, frame, 0, FDM_MIN_WALL);
      const b = capFlap(reg.toGeometry(other), cutTag(cutId, 1), frame, 1, FDM_MIN_WALL, { lo, hi });
      return Math.max(a.width, b.width);
    };

    const planarPeel = (island: number, loops: BoundaryLoop[]) => {
      let A = rest;
      const others: Manifold[] = [];
      const localCuts: CutRecord[] = [];
      let cutId = nextCutId;
      for (const loop of loops) {
        // Um corte anterior desta ilha pode já ter separado o vizinho deste laço: nada a cortar.
        if (A !== rest && statsOf(A, island, undefined, undefined, undefined, new Set(loop.outerFaces)).outerHits === 0) continue;
        const { fit, normal } = loopFrame(island, loop);
        const ring = new Set(loop.innerFaces);
        const side = sideOfLoop(mesh, neighbors, loop);
        const near = nearMask(fit);
        let best: { frame: PlaneFrame; S: Manifold; drop: Manifold[]; score: number; flap: number } | null = null;
        // Candidatos: normal do contorno, eixo do membro e a média dos dois, com recuos para dentro
        // da ilha (perto de axilas e virilhas um recuo evita que o plano raspe na parte vizinha).
        // Todos são avaliados rápido sobre a superfície; os dois melhores passam pelo corte exato e,
        // se ainda deixarem aba (plano quase paralelo à superfície vizinha), os seguintes também.
        const candidates = rankPlanes(island, loop, fit, normal, side, near).slice(0, 8);
        for (const [ci, cand] of candidates.entries()) {
          if (ci >= 2 && best && best.flap < FLAP_WIDTH && !process.env.OMNISLICE_ALL) break;
          const frame = cand.frame;
          const cutter = arena.track(reg.halfSpace(frame, size, cutId));
          const [pos, neg] = arena.trackAll(A.split(cutter));
          free(cutter);
          const comps = arena.trackAll(decomposeSolids(pos));
          if (!comps.includes(pos)) free(pos);
          let pick = -1;
          let pickStats: FaceStats | null = null;
          for (let i = 0; i < comps.length; i++) {
            const s = statsOf(comps[i], island, ring, side, near);
            if (s.ringHits > 0 && (pickStats === null || s.ringHits > pickStats.ringHits)) {
              pick = i;
              pickStats = s;
            }
          }
          if (pick < 0)
            for (let i = 0; i < comps.length; i++) {
              const s = statsOf(comps[i], island, ring, side, near);
              if (s.islandArea > 0 && (pickStats === null || s.islandArea > pickStats.islandArea)) {
                pick = i;
                pickStats = s;
              }
            }
          if (pick < 0 || pickStats === null) {
            free(neg, ...comps);
            continue;
          }
          const purity = purityOf(pickStats);
          const completeness = islands[island].area > 0 ? pickStats.islandArea / islands[island].area : 0;
          const flap = flapAcross(comps[pick], neg, frame, cutId);
          // Uma aba pesa mais que um pouco de pintura do outro lado do plano.
          const flapPenalty = flap >= FLAP_WIDTH ? 0.3 + 0.05 * (flap - FLAP_WIDTH) : 0;
          const score = purity - 2 * Math.max(0, 0.95 - completeness) - cand.penalty - flapPenalty;
          if (process.env.OMNISLICE_DEBUG)
            console.log(`ilha ${islands[island].label} cand ${ci}: n=${frame.normal.map((x) => x.toFixed(3))} o=${frame.origin.map((x) => x.toFixed(2))} pureza ${purity.toFixed(3)} completude ${completeness.toFixed(3)} aba ${flap.toFixed(2)} pen ${cand.penalty.toFixed(3)} nota ${score.toFixed(3)}`);
          if (!best || score > best.score) {
            if (best) free(best.S, ...best.drop);
            best = { frame, S: comps[pick], drop: [neg, ...comps.filter((_, i) => i !== pick)], score, flap };
          } else free(neg, ...comps);
          if (purity > 0.995 && completeness > 0.95 && flap < FLAP_WIDTH && !process.env.OMNISLICE_ALL) break;
        }
        if (!best) {
          free(...others);
          if (A !== rest) free(A);
          return null;
        }
        others.push(...best.drop);
        if (A !== rest) free(A);
        A = best.S;
        localCuts.push({ id: cutId, kind: "plane", frame: best.frame });
        cutId++;
      }
      // Peça e resto saem de um único corte exato do resto original pelos planos desta ilha,
      // limitados a um envoltório da peça: o plano só corta onde a peça encosta no resto.
      const peeled = A;
      const exact = exactSplit(w, arena, rest, peeled.volume(), (envelope, guards) => {
        const planes = localCuts.map((c) => reg.halfSpace(c.frame, size, c.id));
        const e = guarded(envelope(peeled), guards);
        const cutter = w.Manifold.intersection([...planes, e]);
        for (const p of planes) p.delete();
        e.delete();
        return cutter;
      });
      free(...others);
      if (A !== rest) free(A);
      if (!exact) return null;
      const [part, restSolid] = exact;
      const s = statsOf(part, island);
      return {
        part,
        rest: restSolid,
        cuts: localCuts,
        purity: s.originArea > 0 ? s.islandArea / s.originArea : 0,
        completeness: islands[island].area > 0 ? s.islandArea / islands[island].area : 0,
      };
    };

    const seamPeel = (island: number) => {
      const R = reg.toGeometry(rest);
      const rm = R.mesh;
      const nt = triCount(rm);
      const rEdges = buildEdgeTable(rm);
      const rNeighbors = faceNeighbors(rm, rEdges);
      // Ilha de cada triângulo atual; tampas de cortes anteriores herdam a ilha vizinha dominante.
      const own = new Int32Array(nt).fill(-1);
      for (let t = 0; t < nt; t++) if (R.src[t] >= 0) own[t] = islandOf[R.src[t]];
      for (let pass = 0; pass < 256; pass++) {
        let changed = false;
        for (let t = 0; t < nt; t++) {
          if (own[t] >= 0) continue;
          const votes = new Map<number, number>();
          for (let k = 0; k < 3; k++) {
            const g = rNeighbors[t * 3 + k];
            if (g >= 0 && own[g] >= 0) votes.set(own[g], (votes.get(own[g]) ?? 0) + 1);
          }
          let best = -1;
          let bc = 0;
          for (const [j, c] of votes)
            if (c > bc) {
              best = j;
              bc = c;
            }
          if (best >= 0) {
            own[t] = best;
            changed = true;
          }
        }
        if (!changed) break;
      }
      const faces: number[] = [];
      for (let t = 0; t < nt; t++) if (own[t] === island) faces.push(t);
      if (!faces.length) return null;
      const inSet = new Uint8Array(nt);
      for (const f of faces) inSet[f] = 1;
      const loops = islandLoops(rm, rEdges, (f) => inSet[f] === 1, faces);
      if (!loops.length || loops.some((l) => !l.closed))
        throw new GeometryError("O contorno da região não forma um laço fechado.", "contorno-aberto");

      const positions = Array.from(rm.positions);
      const partCaps: number[] = [];
      const restCaps: number[] = [];
      const partCapTag: number[] = [];
      const restCapTag: number[] = [];
      const seamCuts: CutRecord[] = [];
      let irregular = false;
      let cutId = nextCutId;
      for (const loop of loops) {
        const verts = loop.halfEdges.map((h) => halfEdgeFrom(rm, h));
        const pts = new Float64Array(verts.length * 3);
        verts.forEach((v, i) => {
          pts[i * 3] = rm.positions[v * 3];
          pts[i * 3 + 1] = rm.positions[v * 3 + 1];
          pts[i * 3 + 2] = rm.positions[v * 3 + 2];
        });
        const fit = fitPlane(pts, verts.length);
        if (fit.maxDeviation > 0.35 * Math.max(fit.radius, 1e-6)) irregular = true;
        // A tampa da peça percorre a borda no sentido oposto ao das faces da ilha.
        const cap = capLoop(verts.slice().reverse(), positions, triangulate, true);
        if (!cap)
          throw new GeometryError("O contorno pintado se cruza quando achatado; não dá para tampar sem deformar.", "contorno-cruzado");
        const { tris, extraVerts } = cap;
        for (const v of extraVerts) positions.push(v[0], v[1], v[2]);
        // A frente do corte aponta para dentro da ilha (mesma convenção do corte plano).
        const capNormal = triangleNormalSum(tris, positions);
        const normal = dot(fit.normal, capNormal) > 0 ? scale(fit.normal, -1) : fit.normal;
        seamCuts.push({ id: cutId, kind: "seam", frame: frameFromNormal(fit.centroid, normal) });
        for (let i = 0; i < tris.length; i += 3) {
          partCaps.push(tris[i], tris[i + 1], tris[i + 2]);
          partCapTag.push(cutTag(cutId, 0));
          restCaps.push(tris[i], tris[i + 2], tris[i + 1]);
          restCapTag.push(cutTag(cutId, 1));
        }
        cutId++;
      }
      const pos32 = new Float32Array(positions);
      const build = (keep: (t: number) => boolean, caps: number[], capTags: number[]): PartGeometry => {
        const kept: number[] = [];
        for (let t = 0; t < nt; t++) if (keep(t)) kept.push(t);
        const total = kept.length + capTags.length;
        const indices = new Uint32Array(total * 3);
        const src = new Int32Array(total);
        const cut = new Int32Array(total);
        kept.forEach((t, i) => {
          indices[i * 3] = rm.indices[t * 3];
          indices[i * 3 + 1] = rm.indices[t * 3 + 1];
          indices[i * 3 + 2] = rm.indices[t * 3 + 2];
          src[i] = R.src[t];
          cut[i] = R.cut[t];
        });
        for (let i = 0; i < capTags.length; i++) {
          const o = kept.length + i;
          indices[o * 3] = caps[i * 3];
          indices[o * 3 + 1] = caps[i * 3 + 1];
          indices[o * 3 + 2] = caps[i * 3 + 2];
          src[o] = -1;
          cut[o] = capTags[i];
        }
        return compactGeometry({ mesh: { positions: pos32, indices }, src, cut });
      };
      const part = arena.track(reg.fromGeometry(build((t) => inSet[t] === 1, partCaps, partCapTag)));
      const restSolid = arena.track(reg.fromGeometry(build((t) => inSet[t] === 0, restCaps, restCapTag)));
      return { part, rest: restSolid, cuts: seamCuts, irregular };
    };

    while (pending.length) {
      pending.sort((a, b) => unresolved(a.id).length - unresolved(b.id).length || a.area - b.area);
      const island = pending.shift()!;
      const loops = unresolved(island.id);
      let accepted = false;
      const report: IslandReport = { label: island.label, method: "falhou", purity: 0, completeness: 0 };

      if (loops.length === 0) {
        // Casca solta (ou já isolada por cortes anteriores): basta separar o componente.
        const comps = arena.trackAll(decomposeSolids(rest));
        let best = -1;
        let bestStats: FaceStats | null = null;
        for (let i = 0; i < comps.length; i++) {
          const s = statsOf(comps[i], island.id);
          if (s.islandArea > 0 && (bestStats === null || s.islandArea > bestStats.islandArea)) {
            best = i;
            bestStats = s;
          }
        }
        if (best >= 0 && bestStats !== null && comps.length > 1) {
          report.purity = bestStats.originArea > 0 ? bestStats.islandArea / bestStats.originArea : 0;
          report.completeness = bestStats.islandArea / island.area;
          if (report.purity >= purityThreshold) {
            push(island.label, comps[best]);
            const others = comps.filter((_, i) => i !== best);
            const next = arena.track(w.Manifold.union(others));
            free(rest, ...others);
            rest = next;
            report.method = "componente";
            accepted = true;
          }
        }
        if (!accepted) free(...comps.filter((c) => c !== rest));
      }

      type Attempt = NonNullable<ReturnType<typeof planarPeel>>;
      const acceptPlanar = (attempt: Attempt, good: boolean) => {
        push(island.label, attempt.part);
        free(rest);
        rest = attempt.rest;
        cuts.push(...attempt.cuts);
        nextCutId += attempt.cuts.length;
        report.method = "plano";
        report.purity = attempt.purity;
        report.completeness = attempt.completeness;
        if (good && attempt.completeness < 0.95)
          report.message = `${Math.round((1 - attempt.completeness) * 100)}% da região pintada ficou na peça vizinha (o plano não segue a pintura exatamente).`;
        if (!good)
          report.message = "O plano de junção atravessa outra parte do modelo. Confira a peça ou ajuste a pintura.";
        accepted = true;
      };
      let fallback: Attempt | null = null;

      if (!accepted && loops.length > 0 && mode !== "seam") {
        const attempt = planarPeel(island.id, loops);
        if (attempt) {
          // Pureza: nada de outra parte do modelo dentro da peça. Completude mais tolerante: um plano
          // sempre desvia um pouco da fronteira pintada e deixa um pequeno toco do outro lado.
          const good = attempt.purity >= purityThreshold && attempt.completeness >= 0.75;
          if (good || mode === "plane") acceptPlanar(attempt, good);
          else fallback = attempt;
        }
      }

      if (!accepted && loops.length > 0 && mode !== "plane") {
        try {
          const seam = seamPeel(island.id);
          if (seam) {
            if (fallback) free(fallback.part, fallback.rest);
            fallback = null;
            push(island.label, seam.part);
            free(rest);
            rest = seam.rest;
            cuts.push(...seam.cuts);
            nextCutId += seam.cuts.length;
            report.method = "contorno";
            report.purity = 1;
            report.completeness = 1;
            if (seam.irregular)
              report.message = "O contorno pintado é bem irregular; a tampa do corte pode ficar inclinada.";
            accepted = true;
          }
        } catch (e) {
          report.message = (e as Error).message;
        }
      }

      // Melhor um plano imperfeito (peças válidas, com aviso) do que deixar a região sem separar.
      if (!accepted && fallback) {
        if (fallback.purity >= 0.6) acceptPlanar(fallback, false);
        else free(fallback.part, fallback.rest);
      }
      if (!accepted)
        report.message ??= "Não foi possível destacar esta região. Ajuste a pintura ou use o corte por plano.";
      peeled.add(island.id);
      reports.push(report);
    }

    push(baseLabel, rest);

    const unions = new Map<number, Manifold>();
    for (const [label, solids] of resultsByLabel)
      unions.set(label, solids.length === 1 ? solids[0] : arena.track(w.Manifold.union(solids)));
    // Lâminas e lascas soltas que sobram entre cortes vizinhos não são peças imprimíveis: são
    // descartadas (o volume perdido entra no relatório).
    let dropped = 0;
    for (const [label, u] of [...unions]) {
      const comps = arena.trackAll(decomposeSolids(u));
      if (comps.length < 2) continue;
      const vol = Math.abs(u.volume());
      const keep = comps.filter((c) => {
        const v = Math.abs(c.volume());
        // Lasca: muito pequena, ou uma lâmina fina demais para imprimir (espessura média 2V/A).
        const thin = (2 * v) / Math.max(c.surfaceArea(), 1e-9) < 0.6 && v < vol * 0.02;
        const sliver = (v < vol * 0.01 && v < 50) || thin;
        if (sliver) dropped += v;
        return !sliver;
      });
      if (keep.length !== comps.length) unions.set(label, arena.track(w.Manifold.union(keep)));
    }
    if (dropped > 0.01)
      reports.push({
        label: baseLabel,
        method: "componente",
        purity: 1,
        completeness: 1,
        message: `${dropped.toFixed(1)} mm³ de lascas soltas entre cortes vizinhos foram descartados.`,
      });

    const parts: RegionSplitResult["parts"] = [];
    for (const [label, merged] of unions) {
      const g = reg.toGeometry(merged);
      if (triCount(g.mesh) === 0) continue;
      // Volta de "índice do triângulo" para a origem real da face (cor/material do modelo).
      const src = new Int32Array(g.src.length);
      for (let t = 0; t < src.length; t++) src[t] = g.src[t] >= 0 ? geometry.src[g.src[t]] : -1;
      parts.push({ label, geometry: { mesh: g.mesh, src, cut: g.cut } });
    }
    parts.sort((a, b) => (a.label === baseLabel ? -1 : b.label === baseLabel ? 1 : a.label - b.label));
    return { parts, cuts, islands: reports, nextCutId, cleanedLabels: labels };
  } finally {
    arena.dispose();
  }
}

/**
 * Junta laços de uma mesma ilha que estão no mesmo plano (ex.: os dois pés apoiados na base): um
 * único corte plano separa todos de uma vez, o que também quebra ciclos como tronco–pernas–base.
 */
function mergeCoplanarLoops(mesh: IndexedMesh, loops: BoundaryLoop[]): BoundaryLoop[] {
  if (loops.length < 2) return loops;
  const fits = loops.map((l) => {
    const pts = new Float64Array(l.vertices.length * 3);
    l.vertices.forEach((v, i) => {
      pts[i * 3] = mesh.positions[v * 3];
      pts[i * 3 + 1] = mesh.positions[v * 3 + 1];
      pts[i * 3 + 2] = mesh.positions[v * 3 + 2];
    });
    return fitPlane(pts, l.vertices.length);
  });
  const group = loops.map((_, i) => i);
  for (let i = 0; i < loops.length; i++)
    for (let j = i + 1; j < loops.length; j++) {
      const a = fits[i];
      const b = fits[j];
      const tol = 0.3 * Math.max(a.radius, b.radius) + 0.5;
      const coplanar =
        Math.abs(dot(a.normal, b.normal)) > 0.98 && Math.abs(dot(sub(b.centroid, a.centroid), a.normal)) < tol;
      if (coplanar) {
        const from = group[j];
        const to = group[i];
        for (let k = 0; k < group.length; k++) if (group[k] === from) group[k] = to;
      }
    }
  const merged = new Map<number, BoundaryLoop>();
  loops.forEach((l, i) => {
    const m = merged.get(group[i]);
    if (!m) merged.set(group[i], { ...l, neighborIslands: new Set(l.neighborIslands) });
    else {
      m.halfEdges = m.halfEdges.concat(l.halfEdges);
      m.vertices = m.vertices.concat(l.vertices);
      m.innerFaces = m.innerFaces.concat(l.innerFaces);
      m.outerFaces = m.outerFaces.concat(l.outerFaces);
      for (const x of l.neighborIslands) m.neighborIslands.add(x);
      m.closed = m.closed && l.closed;
    }
  });
  return [...merged.values()];
}

/**
 * Trechos do corpo principal que não tocam a maior ilha dele (ex.: um chapéu não marcado preso só à
 * cabeça) acompanham a peça vizinha com a maior fronteira, em vez de virar um pedaço solto do corpo.
 */
function attachDetachedBase(labels: Uint16Array, neighbors: Int32Array, areas: Float32Array, baseLabel: number): Uint16Array {
  const { islands, islandOf } = labelIslands(labels, neighbors, areas);
  const bases = islands.filter((i) => i.label === baseLabel);
  if (bases.length < 2) return labels;
  const main = bases.reduce((a, b) => (b.area > a.area ? b : a));
  const out = labels.slice();
  for (const isl of bases) {
    if (isl === main) continue;
    const border = new Map<number, number>();
    for (const f of isl.faces)
      for (let k = 0; k < 3; k++) {
        const g = neighbors[f * 3 + k];
        if (g >= 0 && islandOf[g] !== isl.id && labels[g] !== baseLabel) border.set(labels[g], (border.get(labels[g]) ?? 0) + 1);
      }
    let best = -1;
    let count = 0;
    for (const [l, c] of border)
      if (c > count) {
        best = l;
        count = c;
      }
    if (best >= 0) for (const f of isl.faces) out[f] = best;
  }
  return out;
}

function triangleNormalSum(tris: number[], positions: number[]): Vec3 {
  let x = 0;
  let y = 0;
  let z = 0;
  for (let i = 0; i < tris.length; i += 3) {
    const a = tris[i] * 3;
    const b = tris[i + 1] * 3;
    const c = tris[i + 2] * 3;
    const ux = positions[b] - positions[a];
    const uy = positions[b + 1] - positions[a + 1];
    const uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a];
    const vy = positions[c + 1] - positions[a + 1];
    const vz = positions[c + 2] - positions[a + 2];
    x += uy * vz - uz * vy;
    y += uz * vx - ux * vz;
    z += ux * vy - uy * vx;
  }
  return [x, y, z];
}

/** Remove vértices não usados mantendo os atributos por triângulo. */
export function compactGeometry(g: PartGeometry): PartGeometry {
  const nv = g.mesh.positions.length / 3;
  const remap = new Int32Array(nv).fill(-1);
  let count = 0;
  const idx = g.mesh.indices;
  for (let i = 0; i < idx.length; i++) if (remap[idx[i]] === -1) remap[idx[i]] = count++;
  const positions = new Float32Array(count * 3);
  for (let v = 0; v < nv; v++) {
    const r = remap[v];
    if (r < 0) continue;
    positions[r * 3] = g.mesh.positions[v * 3];
    positions[r * 3 + 1] = g.mesh.positions[v * 3 + 1];
    positions[r * 3 + 2] = g.mesh.positions[v * 3 + 2];
  }
  const indices = new Uint32Array(idx.length);
  for (let i = 0; i < idx.length; i++) indices[i] = remap[idx[i]];
  return { mesh: { positions, indices }, src: g.src, cut: g.cut };
}

// ---------------------------------------------------------------------------------------------
// Interfaces (faces de contato entre peças criadas por cortes)
// ---------------------------------------------------------------------------------------------

export interface PartRef {
  id: string;
  geometry: PartGeometry;
}

export interface Interface {
  id: string;
  cutId: number;
  kind: "plane" | "seam";
  frame: PlaneFrame;
  /** Peça do lado da frente do corte (para onde a normal aponta). */
  front: string;
  back: string;
  /** Região de contato no plano do corte (contornos externos CCW e furos CW). */
  polygons: Vec2[][];
  area: number;
  /** Afastamento máximo da tampa em relação ao plano (0 para cortes planos). */
  deviation: number;
}

function capSection(w: Wasm, g: PartGeometry, tag: number, frame: PlaneFrame): { cs: CrossSection; deviation: number } {
  const polys: Vec2[][] = [];
  let deviation = 0;
  const p = g.mesh.positions;
  const idx = g.mesh.indices;
  for (let t = 0; t < g.cut.length; t++) {
    if (g.cut[t] !== tag) continue;
    const tri: Vec2[] = [];
    for (let k = 0; k < 3; k++) {
      const v = idx[t * 3 + k] * 3;
      const l = toLocal(frame, [p[v], p[v + 1], p[v + 2]]);
      deviation = Math.max(deviation, Math.abs(l[2]));
      tri.push([l[0], l[1]]);
    }
    const area =
      (tri[1][0] - tri[0][0]) * (tri[2][1] - tri[0][1]) - (tri[2][0] - tri[0][0]) * (tri[1][1] - tri[0][1]);
    if (Math.abs(area) < 1e-12) continue;
    polys.push(area > 0 ? tri : [tri[0], tri[2], tri[1]]);
  }
  return { cs: new w.CrossSection(polys, "Positive"), deviation };
}

/** Recalcula todas as interfaces a partir das marcas de corte das peças. */
export function computeInterfaces(w: Wasm, parts: PartRef[], cuts: CutRecord[], minArea = 0.5): Interface[] {
  const out: Interface[] = [];
  const byCut = new Map<number, { front: PartRef[]; back: PartRef[] }>();
  for (const part of parts) {
    const seen = new Set<number>();
    for (let t = 0; t < part.geometry.cut.length; t++) {
      const tag = part.geometry.cut[t];
      if (tag < 0 || seen.has(tag)) continue;
      seen.add(tag);
      const id = tagCutId(tag);
      let entry = byCut.get(id);
      if (!entry) byCut.set(id, (entry = { front: [], back: [] }));
      (tagSide(tag) === 0 ? entry.front : entry.back).push(part);
    }
  }
  for (const cut of cuts) {
    const entry = byCut.get(cut.id);
    if (!entry) continue;
    for (const f of entry.front)
      for (const b of entry.back) {
        if (f.id === b.id) continue;
        const a = capSection(w, f.geometry, cutTag(cut.id, 0), cut.frame);
        const c = capSection(w, b.geometry, cutTag(cut.id, 1), cut.frame);
        const contact = a.cs.intersect(c.cs);
        const simple = contact.simplify(0.01);
        const area = simple.area();
        if (area >= minArea) {
          out.push({
            id: `${cut.id}:${f.id}:${b.id}`,
            cutId: cut.id,
            kind: cut.kind,
            frame: cut.frame,
            front: f.id,
            back: b.id,
            polygons: simple.toPolygons() as Vec2[][],
            area,
            deviation: Math.max(a.deviation, c.deviation),
          });
        }
        a.cs.delete();
        c.cs.delete();
        contact.delete();
        simple.delete();
      }
  }
  return out;
}
