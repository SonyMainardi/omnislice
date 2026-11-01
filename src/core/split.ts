import type { CrossSection, Manifold } from "manifold-3d";
import { DoubleSide, Ray } from "three";
import type { MeshBVH } from "three-mesh-bvh";
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
import { type PlaneFrame, type Vec2, type Vec3, add, cross, dot, fitPlane, frameFromNormal, length, scale, sub, toLocal } from "./math";
import { type IndexedMesh, buildEdgeTable, faceCentroids, faceNeighbors, faceNormalsAndAreas, halfEdgeFrom, triCount } from "./mesh";
import { type PartGeometry, cutTag, tagCutId, tagSide } from "./part";
import { type Triangulator, capLoop, membraneCap } from "./repair";
import { FDM_MIN_WALL, FLAP_WIDTH, capFlap } from "./flaps";
import { decomposeSolids, solidComponents, subsetGeometry } from "./solids";
import { MIXED_SOLID, attachLooseAccessories } from "./accessories";
import { buildBVH, findSelfIntersections, roundingTolerance } from "./bvh";

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
 *
 * `admissible` descarta antes, sem booleana no sólido inteiro, um envoltório que certamente vai
 * encostar no sólido: em malhas de centenas de milhares de triângulos cada tentativa custa minutos.
 */
function exactSplit(
  w: Wasm,
  arena: Arena,
  whole: Manifold,
  expectedInside: number,
  buildCutter: (envelope: Envelope, guards: number[]) => Manifold,
  admissible?: (envelope: Envelope) => boolean,
): [Manifold, Manifold] | null {
  const vWhole = whole.volume();
  const tol = Math.max(Math.abs(vWhole) * 1e-7, 1e-6);
  for (const envelope of envelopes(w)) {
    if (admissible && !admissible(envelope)) continue;
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
 *
 * Numa peça com vários sólidos independentes (projeto multipartes, acessórios modelados à parte),
 * só os sólidos que o plano atravessa são cortados, cada um sozinho; os outros vão inteiros, sem
 * booleanas, para o lado em que estão.
 */
export function cutByPlane(
  w: Wasm,
  g: PartGeometry,
  frame: PlaneFrame,
  cutId: number,
  separateComponents: boolean,
): PlaneCutResult {
  const mesh = g.mesh;
  const { count, comp } = solidComponents(mesh);
  if (count < 2) return cutSolidByPlane(w, g, frame, cutId, separateComponents);
  const facesOf = groupFaces(comp, count);
  const p = mesh.positions;
  const idx = mesh.indices;
  // Folga do teste de lado: arredondamento das coordenadas.
  const eps = roundingTolerance(mesh);
  const d0 = dot(frame.origin, frame.normal);
  const front: PartGeometry[] = [];
  const back: PartGeometry[] = [];
  for (let s = 0; s < count; s++) {
    const faces = facesOf[s];
    let lo = Infinity;
    let hi = -Infinity;
    let sum = 0;
    for (let i = 0; i < faces.length; i++)
      for (let k = 0; k < 3; k++) {
        const v = idx[faces[i] * 3 + k] * 3;
        const d = p[v] * frame.normal[0] + p[v + 1] * frame.normal[1] + p[v + 2] * frame.normal[2] - d0;
        if (d < lo) lo = d;
        if (d > hi) hi = d;
        sum += d;
      }
    const sub = subsetGeometry(g, faces);
    if (lo >= -eps || hi <= eps) {
      (lo >= -eps ? front : back).push(sub);
      continue;
    }
    try {
      const r = cutSolidByPlane(w, sub, frame, cutId, separateComponents);
      front.push(...r.front);
      back.push(...r.back);
    } catch (e) {
      // O plano só raspa este sólido: ele vai inteiro para o lado em que está.
      if (!(e instanceof GeometryError) || e.code !== "plano-fora") throw e;
      (sum >= 0 ? front : back).push(sub);
    }
  }
  // Sem nada de um dos lados o plano não separa nada (com sólidos dos dois lados, mesmo sem
  // atravessar nenhum, o plano separa os objetos).
  if (!front.length || !back.length)
    throw new GeometryError("O plano não atravessa a peça. Mova ou gire o plano até ele cruzar o modelo.", "plano-fora");
  if (separateComponents) return { front, back };
  return { front: [concatGeometry(front)], back: [concatGeometry(back)] };
}

/** Corte por plano de um sólido (uma casca com as cavidades dela, ou uma peça já unida). */
function cutSolidByPlane(
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

/** Andamento de uma operação longa: fração concluída (0–1) e o que está sendo feito. */
export type ProgressFn = (fraction: number, label: string) => void;

/**
 * Divide uma peça seguindo regiões pintadas.
 *
 * Cada sólido independente do arquivo (uma casca externa com as cavidades dela) é tratado à parte:
 * um sólido inteiro de uma só região vai direto para a peça dessa região, sem booleanas e sem mudar
 * nada na geometria (acessórios, olhos, decalques e objetos separados de um projeto). Só os sólidos
 * com mais de uma região pintada são cortados, cada um sozinho: o corte não depende do tamanho do
 * resto do arquivo e não atravessa outras cascas que encostam ou se sobrepõem a ele.
 */
export function splitByRegions(w: Wasm, input: RegionSplitInput, triangulate: Triangulator, onProgress?: ProgressFn): RegionSplitResult {
  const { geometry, baseLabel, mode } = input;
  const purityThreshold = input.purityThreshold ?? 0.97;
  const mesh = geometry.mesh;
  const n = triCount(mesh);
  if (input.labels.length !== n) throw new GeometryError("Pintura e malha não correspondem.", "rotulos");

  const edges = buildEdgeTable(mesh);
  const neighbors = faceNeighbors(mesh, edges);
  if (boundaryLoops(mesh, edges).length > 0)
    throw new GeometryError("A peça tem buracos. Repare a malha antes de dividir.", "aberta");
  const { areas } = faceNormalsAndAreas(mesh);
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
  // Sólidos independentes e a região de cada um (cavidades não contam: ninguém pinta o lado de dentro).
  const { count, comp, shells } = solidComponents(mesh, neighbors);
  labels = attachDetachedBase(labels, neighbors, areas, baseLabel, comp);
  const cavityFace = new Uint8Array(n);
  for (const s of shells) if (s.depth % 2 === 1) for (const f of s.faces) cavityFace[f] = 1;
  const MIXED = MIXED_SOLID;
  const UNSET = -2;
  const solidLabel = new Int32Array(count).fill(UNSET);
  for (let f = 0; f < n; f++) {
    if (cavityFace[f]) continue;
    const s = comp[f];
    if (solidLabel[s] === UNSET) solidLabel[s] = labels[f];
    else if (solidLabel[s] !== labels[f]) solidLabel[s] = MIXED;
  }
  const facesOf = groupFaces(comp, count);
  for (let s = 0; s < count; s++) if (solidLabel[s] === UNSET) solidLabel[s] = labels[facesOf[s][0]];
  const reports: IslandReport[] = [];

  // Acessórios soltos sem pintura cravados numa região separada (logotipo no chapéu, espada na mão)
  // acompanham essa região.
  const attached = attachLooseAccessories(mesh, labels, areas, facesOf, solidLabel, baseLabel);
  const movedTo = new Map<number, number>();
  for (const { solid, label } of attached) {
    solidLabel[solid] = label;
    for (const f of facesOf[solid]) labels[f] = label;
    movedTo.set(label, (movedTo.get(label) ?? 0) + 1);
  }
  for (const [label, k] of movedTo)
    reports.push({
      label,
      method: "componente",
      purity: 1,
      completeness: 1,
      message: `${k} casca(s) solta(s) presa(s) nesta peça (detalhes ou acessórios modelados à parte) foram junto com ela.`,
    });

  const chunks = new Map<number, PartGeometry[]>();
  const addChunk = (label: number, g: PartGeometry) => {
    const list = chunks.get(label);
    if (list) list.push(g);
    else chunks.set(label, [g]);
  };
  const cuts: CutRecord[] = [];
  let nextCutId = input.firstCutId;
  const mixed: number[] = [];
  for (let s = 0; s < count; s++) if (solidLabel[s] === MIXED) mixed.push(s);
  // Peso de cada sólido no andamento: proporcional ao número de triângulos.
  const work = mixed.reduce((sum, s) => sum + facesOf[s].length, 0);
  let doneWork = 0;
  mixed.forEach((s, i) => {
    const faces = facesOf[s];
    const sub = subsetGeometry(geometry, faces);
    const subLabels = new Uint16Array(faces.length);
    for (let k = 0; k < faces.length; k++) subLabels[k] = labels[faces[k]];
    const label = mixed.length > 1 ? `Cortando as regiões (sólido ${i + 1} de ${mixed.length})` : "Cortando as regiões";
    const r = splitSolid(
      w,
      sub,
      subLabels,
      {
        baseLabel,
        mode,
        purityThreshold,
        firstCutId: nextCutId,
        minIslandArea: totalArea * 0.0005,
        progress: (f) => onProgress?.((doneWork + f * faces.length) / Math.max(work, 1), label),
      },
      triangulate,
    );
    doneWork += faces.length;
    for (const p of r.parts) addChunk(p.label, p.geometry);
    cuts.push(...r.cuts);
    reports.push(...r.islands);
    nextCutId = r.nextCutId;
  });
  for (let s = 0; s < count; s++) if (solidLabel[s] !== MIXED) addChunk(solidLabel[s], subsetGeometry(geometry, facesOf[s]));
  onProgress?.(1, "Montando as peças");

  const parts: RegionSplitResult["parts"] = [];
  for (const [label, list] of chunks) {
    const g = list.length === 1 ? list[0] : concatGeometry(list);
    if (triCount(g.mesh) > 0) parts.push({ label, geometry: g });
  }
  parts.sort((a, b) => (a.label === baseLabel ? -1 : b.label === baseLabel ? 1 : a.label - b.label));
  return { parts, cuts, islands: reports, nextCutId, cleanedLabels: labels };
}

/** Faces de cada componente (ordenação por contagem). */
function groupFaces(comp: Int32Array, count: number): Int32Array[] {
  const sizes = new Int32Array(count);
  for (let f = 0; f < comp.length; f++) sizes[comp[f]]++;
  const out = Array.from({ length: count }, (_, s) => new Int32Array(sizes[s]));
  const fill = new Int32Array(count);
  for (let f = 0; f < comp.length; f++) out[comp[f]][fill[comp[f]]++] = f;
  return out;
}

/** Junta peças sem booleanas (cascas que já eram independentes no arquivo). */
export function concatGeometry(list: PartGeometry[]): PartGeometry {
  let nv = 0;
  let nt = 0;
  for (const g of list) {
    nv += g.mesh.positions.length / 3;
    nt += g.mesh.indices.length / 3;
  }
  const positions = new Float32Array(nv * 3);
  const indices = new Uint32Array(nt * 3);
  const src = new Int32Array(nt);
  const cut = new Int32Array(nt);
  let ov = 0;
  let ot = 0;
  for (const g of list) {
    positions.set(g.mesh.positions, ov * 3);
    const idx = g.mesh.indices;
    for (let i = 0; i < idx.length; i++) indices[ot * 3 + i] = idx[i] + ov;
    src.set(g.src, ot);
    cut.set(g.cut, ot);
    ov += g.mesh.positions.length / 3;
    ot += idx.length / 3;
  }
  return { mesh: { positions, indices }, src, cut };
}

interface SolidSplitOptions {
  baseLabel: number;
  mode: SplitMode;
  firstCutId: number;
  purityThreshold: number;
  /** Área mínima (mm²) para uma ilha virar peça; as menores ficam com a peça vizinha. */
  minIslandArea: number;
  /** Fração (0–1) das ilhas deste sólido já tratadas. */
  progress?: (fraction: number) => void;
}

interface SolidSplitResult {
  parts: { label: number; geometry: PartGeometry }[];
  cuts: CutRecord[];
  islands: IslandReport[];
  nextCutId: number;
}

/**
 * Corta um sólido (uma casca fechada com as cavidades dela) pelas regiões pintadas. Ilhas "folha"
 * (com uma única costura) são destacadas primeiro; cada costura vira um corte plano ajustado ao
 * contorno ou, se o plano atravessar outra parte do modelo, um corte que segue exatamente o contorno
 * pintado, fechado por uma tampa triangulada.
 */
function splitSolid(
  w: Wasm,
  geometry: PartGeometry,
  labels: Uint16Array,
  opts: SolidSplitOptions,
  triangulate: Triangulator,
): SolidSplitResult {
  const { baseLabel, mode, purityThreshold } = opts;
  const mesh = geometry.mesh;
  const n = triCount(mesh);
  const edges = buildEdgeTable(mesh);
  const neighbors = faceNeighbors(mesh, edges);
  const { areas, normals: normalsArr } = faceNormalsAndAreas(mesh);
  const centroids = faceCentroids(mesh);

  const { islands, islandOf } = labelIslands(labels, neighbors, areas);
  let baseIsland = -1;
  for (const isl of islands)
    if (isl.label === baseLabel && (baseIsland < 0 || isl.area > islands[baseIsland].area)) baseIsland = isl.id;
  if (baseIsland < 0) baseIsland = islands.reduce((b, i) => (i.area > islands[b].area ? i.id : b), 0);
  // O que sobra no fim fica com a região da ilha-base (o corpo principal, ou a maior região quando
  // este sólido não tem nada do corpo principal).
  const restLabel = islands[baseIsland].label;
  // Ilhas desprezíveis (faces degeneradas, pontinhos de pintura) ficam com o corpo principal.
  const pending = islands.filter((i) => i.id !== baseIsland && i.area >= opts.minIslandArea && i.faces.length >= 3);
  // Nada a destacar: o sólido segue inteiro, sem passar pelo Manifold.
  if (!pending.length) return { parts: [{ label: restLabel, geometry }], cuts: [], islands: [], nextCutId: opts.firstCutId };

  const loopsByIsland = new Map<number, BoundaryLoop[]>();
  for (const isl of pending) {
    const set = new Uint8Array(n);
    for (const f of isl.faces) set[f] = 1;
    loopsByIsland.set(isl.id, mergeCoplanarLoops(mesh, islandLoops(mesh, edges, (f) => set[f] === 1, isl.faces, islandOf)));
  }

  // Todo objeto do WASM fica no Arena e é liberado ao final; só os PartGeometry saem daqui.
  const reg = new RunRegistry(w);
  const arena = new Arena();
  const cuts: CutRecord[] = [];
  const reports: IslandReport[] = [];
  let nextCutId = opts.firstCutId;
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
    const totalIslands = pending.length;
    opts.progress?.(0);

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
      // Material do lado positivo de cada plano que não é da peça (o plano infinito também o cortou).
      const blockers: Manifold[][] = [];
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
          if (ci >= 2 && best && best.flap < FLAP_WIDTH) break;
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
          const base = purity - 2 * Math.max(0, 0.95 - completeness) - cand.penalty;
          // A aba só tira pontos: um candidato que já perde sem ela não precisa ser medido (a medida
          // lança milhares de raios). Ela ainda é medida quando pode encerrar a busca (abaixo).
          const canStop = purity > 0.995 && completeness > 0.95;
          if (best && base <= best.score && !canStop) {
            free(neg, ...comps);
            continue;
          }
          const flap = flapAcross(comps[pick], neg, frame, cutId);
          // Uma aba pesa mais que um pouco de pintura do outro lado do plano.
          const flapPenalty = flap >= FLAP_WIDTH ? 0.3 + 0.05 * (flap - FLAP_WIDTH) : 0;
          const score = base - flapPenalty;
          if (!best || score > best.score) {
            if (best) free(best.S, ...best.drop);
            best = { frame, S: comps[pick], drop: [neg, ...comps.filter((_, i) => i !== pick)], score, flap };
          } else free(neg, ...comps);
          if (purity > 0.995 && completeness > 0.95 && flap < FLAP_WIDTH) break;
        }
        if (!best) {
          free(...others);
          if (A !== rest) free(A);
          return null;
        }
        others.push(...best.drop);
        blockers.push(best.drop.slice(1));
        if (A !== rest) free(A);
        A = best.S;
        localCuts.push({ id: cutId, kind: "plane", frame: best.frame });
        cutId++;
      }
      // Peça e resto saem de um único corte exato do resto original pelos planos desta ilha,
      // limitados a um envoltório da peça: o plano só corta onde a peça encosta no resto.
      const peeled = A;
      // Com um único plano, o material do resto dentro do cortador é exatamente o que o plano deixou
      // do lado da peça sem ser dela: se o envoltório pega qualquer parte disso, o corte exato vai
      // falhar (encosta no sólido ou leva material a mais). O teste é feito só com esses pedaços,
      // sem a booleana no sólido inteiro.
      const admissible =
        localCuts.length === 1
          ? (envelope: Envelope) => {
              const near = blockers[0];
              if (!near.length) return true;
              const e = envelope(peeled);
              try {
                const box = e.boundingBox();
                return near.every((q) => {
                  const b = q.boundingBox();
                  const apart = [0, 1, 2].some((k) => b.min[k] > box.max[k] || box.min[k] > b.max[k]);
                  if (apart) return true;
                  const x = e.intersect(q);
                  const empty = x.isEmpty();
                  x.delete();
                  return empty;
                });
              } finally {
                e.delete();
              }
            }
          : undefined;
      const exact = exactSplit(
        w,
        arena,
        rest,
        peeled.volume(),
        (envelope, guards) => {
          const planes = localCuts.map((c) => reg.halfSpace(c.frame, size, c.id));
          const e = guarded(envelope(peeled), guards);
          const cutter = w.Manifold.intersection([...planes, e]);
          for (const p of planes) p.delete();
          e.delete();
          return cutter;
        },
        admissible,
      );
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
      // Triângulos de tampa que ainda atravessam a superfície (a peça sai com autointerseção).
      let crossings = 0;
      // Maior fração de uma tampa fora do material (tampa fechando um vão pelo lado de fora).
      let outside = 0;
      let solidBVH: MeshBVH | null = null;
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
        // Contorno que se cruza quando achatado (ex.: dá a volta num relevo): tampa curva em membrana.
        // Uma tampa plana num contorno muito ondulado pode atravessar a superfície: também vira membrana.
        let cap = capLoop(verts.slice().reverse(), positions, triangulate, true);
        let crossing = cap ? capCrossings(rm, positions, cap.tris, cap.extraVerts) : 0;
        if (!cap || crossing > 0) {
          const membrane = membraneCap(verts.slice().reverse(), positions);
          const membraneCrossing = capCrossings(rm, positions, membrane.tris, membrane.extraVerts);
          if (!cap || membraneCrossing < crossing) {
            cap = membrane;
            crossing = membraneCrossing;
          }
          irregular = true;
        }
        crossings += crossing;
        solidBVH ??= buildBVH(rm);
        outside = Math.max(outside, capOutsideFraction(solidBVH, positions, cap.tris, cap.extraVerts));
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
      solidBVH?.geometry.dispose();
      return { part, rest: restSolid, cuts: seamCuts, irregular, crossings, outside };
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
      let fallbackGood = false;

      if (!accepted && loops.length > 0 && mode !== "seam") {
        const attempt = planarPeel(island.id, loops);
        if (attempt) {
          // Pureza: nada de outra parte do modelo dentro da peça. Completude mais tolerante: um plano
          // sempre desvia um pouco da fronteira pintada e deixa um pequeno toco do outro lado.
          const good = attempt.purity >= purityThreshold && attempt.completeness >= 0.75;
          // Mas um plano que deixa um pedaço visível da região na peça vizinha (o calcanhar de um
          // sapato que entra na barra da calça, por exemplo) não é o corte que o usuário pintou: no
          // modo automático o contorno pintado é tentado antes, e o plano fica de reserva.
          const complete = attempt.completeness >= 0.95;
          if ((good && complete) || mode === "plane") acceptPlanar(attempt, good);
          else {
            fallback = attempt;
            fallbackGood = good;
          }
        }
      }

      if (!accepted && loops.length > 0 && mode !== "plane") {
        try {
          const seam = seamPeel(island.id);
          // Tampa no ar (fechando um vão por fora) ou cruzando a superfície em muitos pontos: as
          // peças se sobrepõem e não servem. Poucos cruzamentos (a tampa raspa num relevo) passam
          // com aviso.
          const offMaterial = seam !== null && seam.outside > 0.2;
          const tangled = seam !== null && seam.crossings > 20;
          // Um plano imperfeito, mas que gera sólidos válidos, é melhor que uma tampa com defeito
          // grave. Uma tampa que só raspa a superfície em poucos pontos segue a pintura e fica (com
          // aviso): perder um pedaço da peça pintada é pior.
          if (seam && (tangled || offMaterial) && fallback && (fallbackGood || fallback.purity >= 0.6)) {
            free(seam.part, seam.rest);
            acceptPlanar(fallback, fallbackGood);
            fallback = null;
            report.message = fallbackGood
              ? `${report.message ?? ""} O contorno pintado não permitiu uma tampa limpa; a peça foi separada pelo plano. Ajuste a pintura nessa fronteira se precisar da peça inteira.`.trim()
              : "O contorno pintado é irregular demais para uma tampa que siga a pintura; a peça foi separada por um plano. Confira a peça ou ajuste a pintura.";
          } else if (seam && (offMaterial || tangled)) {
            free(seam.part, seam.rest);
            report.message = offMaterial
              ? "A fronteira pintada contorna um vão (por exemplo, a boca de um chapéu): não dá para fechar o corte por dentro do material. Pinte a peça inteira (ferramenta Casca, se ela for uma casca separada) ou use o corte por plano."
              : "A fronteira pintada é irregular demais: a tampa do corte atravessaria a superfície e as peças ficariam sobrepostas. Suavize a pintura nessa fronteira, pinte a peça inteira (ferramenta Casca, se ela for uma casca separada) ou use o corte por plano.";
          } else if (seam) {
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
            if (seam.crossings > 0)
              report.message = `A tampa do corte raspa a superfície do modelo em ${seam.crossings} ponto(s) (contorno pintado irregular). Confira a peça; se precisar, suavize a pintura nessa fronteira ou use o corte por plano.`;
            accepted = true;
          }
        } catch (e) {
          report.message = (e as Error).message;
        }
      }

      // Melhor um plano imperfeito (peças válidas, com aviso) do que deixar a região sem separar.
      if (!accepted && fallback) {
        if (fallbackGood || fallback.purity >= 0.6) acceptPlanar(fallback, fallbackGood);
        else free(fallback.part, fallback.rest);
      }
      if (!accepted)
        report.message ??= "Não foi possível destacar esta região. Ajuste a pintura ou use o corte por plano.";
      peeled.add(island.id);
      reports.push(report);
      opts.progress?.((totalIslands - pending.length) / Math.max(totalIslands, 1));
    }

    push(restLabel, rest);

    const unions = new Map<number, Manifold>();
    for (const [label, solids] of resultsByLabel)
      unions.set(label, solids.length === 1 ? solids[0] : arena.track(w.Manifold.union(solids)));
    // Lâminas e lascas soltas que sobram entre cortes vizinhos não são peças imprimíveis: são
    // descartadas (o volume perdido entra no relatório). Só conta como lasca um pedaço que tem face
    // de um corte desta divisão: o que já era assim no arquivo (um detalhe fino, um decalque) fica.
    const fromThisSplit = (c: Manifold) =>
      reg.toGeometry(c).cut.some((t) => t >= 0 && tagCutId(t) >= opts.firstCutId);
    let dropped = 0;
    for (const [label, u] of nextCutId > opts.firstCutId ? [...unions] : []) {
      const comps = arena.trackAll(decomposeSolids(u));
      if (comps.length < 2) continue;
      const vol = Math.abs(u.volume());
      const keep = comps.filter((c) => {
        const v = Math.abs(c.volume());
        // Lasca: muito pequena, ou uma lâmina fina demais para imprimir (espessura média 2V/A).
        const thin = (2 * v) / Math.max(c.surfaceArea(), 1e-9) < 0.6 && v < vol * 0.02;
        const sliver = ((v < vol * 0.01 && v < 50) || thin) && fromThisSplit(c);
        if (sliver) dropped += v;
        return !sliver;
      });
      if (keep.length !== comps.length) unions.set(label, arena.track(w.Manifold.union(keep)));
    }
    if (dropped > 0.01)
      reports.push({
        label: restLabel,
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
    return { parts, cuts, islands: reports, nextCutId };
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
 * O corpo principal é escolhido em cada sólido (`comp`): num arquivo com várias cascas, a parte não
 * pintada de uma casca continua sendo o corpo dela, mesmo que outra casca do arquivo seja maior.
 */
function attachDetachedBase(
  labels: Uint16Array,
  neighbors: Int32Array,
  areas: Float32Array,
  baseLabel: number,
  comp: Int32Array,
): Uint16Array {
  const { islands, islandOf } = labelIslands(labels, neighbors, areas);
  const bases = islands.filter((i) => i.label === baseLabel);
  if (bases.length < 2) return labels;
  const mainOf = new Map<number, (typeof bases)[number]>();
  for (const isl of bases) {
    const s = comp[isl.faces[0]];
    const cur = mainOf.get(s);
    if (!cur || isl.area > cur.area) mainOf.set(s, isl);
  }
  const out = labels.slice();
  for (const isl of bases) {
    if (mainOf.get(comp[isl.faces[0]]) === isl) continue;
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

/**
 * Quantos triângulos de uma tampa atravessam a superfície do sólido ou a própria tampa (contorno
 * muito ondulado). Só as faces perto da tampa entram no teste.
 */
function capCrossings(rm: IndexedMesh, positions: number[], tris: number[], extraVerts: Vec3[]): number {
  if (!tris.length) return 0;
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
  const pairs = findSelfIntersections(mesh, 1000, eps, undefined, { faces: capFaces, bvh: buildBVH(mesh) });
  const faces = new Set<number>();
  for (const [i] of pairs) faces.add(i);
  return faces.size;
}

/**
 * Fração da área de uma tampa que ficou fora do material (no ar). Uma tampa válida divide o sólido
 * por dentro; quando o contorno pintado contorna uma abertura (a boca de um chapéu, o vão entre
 * braço e corpo), a tampa fecha o vão pelo lado de fora e as duas peças se sobrepõem.
 */
function capOutsideFraction(solid: MeshBVH, positions: number[], tris: number[], extraVerts: Vec3[]): number {
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

/**
 * Tampa curva (contorno que deu a volta num relevo): ajusta o plano só à parte mais plana da tampa,
 * para que os encaixes fiquem onde as duas peças realmente se apoiam.
 */
function seamFrame(g: PartGeometry, tag: number, frame: PlaneFrame): PlaneFrame {
  const p = g.mesh.positions;
  const idx = g.mesh.indices;
  let current = frame;
  for (let pass = 0; pass < 2; pass++) {
    const pts: number[] = [];
    for (let t = 0; t < g.cut.length; t++) {
      if (g.cut[t] !== tag) continue;
      const a: Vec3 = [p[idx[t * 3] * 3], p[idx[t * 3] * 3 + 1], p[idx[t * 3] * 3 + 2]];
      const b: Vec3 = [p[idx[t * 3 + 1] * 3], p[idx[t * 3 + 1] * 3 + 1], p[idx[t * 3 + 1] * 3 + 2]];
      const c: Vec3 = [p[idx[t * 3 + 2] * 3], p[idx[t * 3 + 2] * 3 + 1], p[idx[t * 3 + 2] * 3 + 2]];
      const nrm = cross(sub(b, a), sub(c, a));
      const len = length(nrm);
      if (len < 1e-12 || Math.abs(dot(nrm, current.normal)) / len < Math.cos(Math.PI / 6)) continue;
      pts.push(...a, ...b, ...c);
    }
    if (pts.length < 9) return current;
    const fit = fitPlane(pts, pts.length / 3);
    current = frameFromNormal(fit.centroid, dot(fit.normal, current.normal) < 0 ? scale(fit.normal, -1) : fit.normal);
  }
  return current;
}

function capSection(
  w: Wasm,
  g: PartGeometry,
  tag: number,
  frame: PlaneFrame,
  maxDeviation = Infinity,
): { cs: CrossSection; deviation: number } {
  const polys: Vec2[][] = [];
  let deviation = 0;
  const p = g.mesh.positions;
  const idx = g.mesh.indices;
  for (let t = 0; t < g.cut.length; t++) {
    if (g.cut[t] !== tag) continue;
    const tri: Vec2[] = [];
    let dev = 0;
    for (let k = 0; k < 3; k++) {
      const v = idx[t * 3 + k] * 3;
      const l = toLocal(frame, [p[v], p[v + 1], p[v + 2]]);
      dev = Math.max(dev, Math.abs(l[2]));
      tri.push([l[0], l[1]]);
    }
    if (dev > maxDeviation) continue;
    deviation = Math.max(deviation, dev);
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
        const contactAt = (frame: PlaneFrame, maxDev: number) => {
          const a = capSection(w, f.geometry, cutTag(cut.id, 0), frame, maxDev);
          const c = capSection(w, b.geometry, cutTag(cut.id, 1), frame, maxDev);
          const contact = a.cs.intersect(c.cs);
          const simple = contact.simplify(0.01);
          const result = {
            frame,
            area: simple.area(),
            polygons: simple.toPolygons() as Vec2[][],
            deviation: Math.max(a.deviation, c.deviation),
          };
          a.cs.delete();
          c.cs.delete();
          contact.delete();
          simple.delete();
          return result;
        };
        // Em costuras, os encaixes vão para a parte quase plana da tampa (até 1 mm do plano ajustado);
        // se ela não existir, usa a tampa inteira projetada no plano do corte.
        let best = cut.kind === "seam" ? contactAt(seamFrame(f.geometry, cutTag(cut.id, 0), cut.frame), 1) : null;
        if (!best || best.area < minArea) best = contactAt(cut.frame, Infinity);
        if (best.area >= minArea)
          out.push({
            id: `${cut.id}:${f.id}:${b.id}`,
            cutId: cut.id,
            kind: cut.kind,
            frame: best.frame,
            front: f.id,
            back: b.id,
            polygons: best.polygons,
            area: best.area,
            deviation: best.deviation,
          });
      }
  }
  return out;
}
