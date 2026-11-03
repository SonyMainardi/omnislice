import type { CrossSection, Manifold } from "manifold-3d";
import type { MeshBVH } from "three-mesh-bvh";
import { boundaryLoops } from "./analysis";
import { capDefects, capOutsideFraction } from "./capcheck";
import {
  type BoundaryLoop,
  centroidOfFaces,
  cleanLabels,
  growFaces,
  isMainIsland,
  islandLoops,
  labelIslands,
  largestByLabel,
  sideOfLoop,
} from "./labels";
import { Arena, GeometryError, RunRegistry, type Wasm, halfSpaceSize } from "./manifoldBridge";
import { type PlaneFrame, type Vec2, type Vec3, add, cross, dot, fitPlane, frameFromNormal, length, scale, sub, symmetricEigen3, toLocal } from "./math";
import { type IndexedMesh, buildEdgeTable, faceCentroids, faceNeighbors, faceNormalsAndAreas, halfEdgeFrom, halfEdgeTo, triCount } from "./mesh";
import { type PartGeometry, cutTag, tagCutId, tagSide } from "./part";
import { type Triangulator, capLoop, membraneCap } from "./repair";
import { FDM_MIN_WALL, FLAP_WIDTH, capFlap } from "./flaps";
import { decomposeSolids, solidComponents, subsetGeometry } from "./solids";
import { fillPockets } from "./pockets";
import { inlayCap } from "./inlay";
import { MIXED_SOLID, attachLooseAccessories } from "./accessories";
import { buildBVH, roundingTolerance } from "./bvh";

/** Espessura máxima e mínima (mm) de uma peça embutida (olho, emblema). */
const INLAY_DEPTH = 1.5;
const INLAY_MIN_DEPTH = 0.6;
/** Área mínima (mm²) de um detalhe pintado para virar peça própria. */
const MIN_DETAIL_AREA = 1;

export interface CutRecord {
  id: number;
  kind: "plane" | "seam";
  frame: PlaneFrame;
  /**
   * Corte embutido (olho, emblema): a peça é a superfície pintada com esta espessura (mm) para dentro
   * do modelo e assenta num rebaixo do mesmo formato.
   */
  inlay?: number;
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
  /**
   * Pintura feita à mão (pincel, lupa): a fronteira pintada é a que a pessoa quer. Um plano só é
   * aceito direto se reproduzir essa fronteira; senão o corte segue o contorno. Na segmentação
   * automática a fronteira é aproximada e o plano de junção continua preferido.
   */
  precise?: boolean;
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
  /**
   * Rótulos novos dados a trechos sem pintura que a pintura deixou soltos do corpo (a bota abaixo de
   * uma canela pintada): cada um vira uma peça própria, em vez de ir junto com a região pintada.
   */
  detached: number[];
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
  const { areas, normals: faceNormals } = faceNormalsAndAreas(mesh);
  let totalArea = 0;
  for (let f = 0; f < n; f++) totalArea += areas[f];

  const separate = new Set(input.separate.filter((l) => l !== baseLabel));
  let labels: Uint16Array = new Uint16Array(n);
  for (let f = 0; f < n; f++) labels[f] = separate.has(input.labels[f]) ? input.labels[f] : baseLabel;
  const clean = (l: Uint16Array) =>
    input.cleanup === false
      ? l
      : cleanLabels(l, neighbors, areas, {
          minIslandArea: totalArea * 0.001,
          minIslandFaces: 8,
          smoothIterations: 3,
        });
  labels = clean(labels);
  const reports: IslandReport[] = [];
  // Lado de dentro sem pintura de uma região pintada (o funil de uma bota onde a perna entra): é
  // dela, senão o corte não fecha por dentro do material e sobra um pedaço dela na peça vizinha.
  // Só com pintura à mão: na segmentação automática todas as faces têm região e a fronteira é aproximada.
  const pockets = input.precise
    ? fillPockets(mesh, labels, { edges, neighbors, areas, normals: faceNormals, centroids: faceCentroids(mesh) }, baseLabel, triangulate)
    : { labels, filled: new Map<number, number>() };
  if (pockets.filled.size) {
    labels = clean(pockets.labels);
    for (const [label, area] of pockets.filled)
      if (area >= 1)
        reports.push({
          label,
          method: "componente",
          purity: 1,
          completeness: 1,
          message: `O lado de dentro sem pintura (${area.toFixed(0)} mm², escondido dentro da região) foi junto com a peça pintada, para o corte fechar por dentro do material.`,
        });
  }
  // Sólidos independentes e a região de cada um (cavidades não contam: ninguém pinta o lado de dentro).
  const { count, comp, shells } = solidComponents(mesh, neighbors);
  let nextLabel = baseLabel + 1;
  for (let f = 0; f < n; f++) if (labels[f] >= nextLabel) nextLabel = labels[f] + 1;
  for (const l of input.labels) if (l >= nextLabel) nextLabel = l + 1;
  const loose = attachDetachedBase(labels, neighbors, areas, baseLabel, comp, input.precise ?? false, nextLabel);
  labels = loose.labels;
  for (const label of loose.detached)
    reports.push({
      label,
      method: "componente",
      purity: 1,
      completeness: 1,
      message: "Trecho sem pintura que ficou solto do corpo por causa da pintura: virou uma peça própria (junte com outra peça se quiser).",
    });
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
        precise: input.precise ?? false,
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
  return { parts, cuts, islands: reports, nextCutId, cleanedLabels: labels, detached: loose.detached };
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
  /** Ver `RegionSplitInput.precise`. */
  precise: boolean;
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
  // Ilhas desprezíveis (faces degeneradas, pontinhos de pintura) ficam com o corpo principal; um
  // detalhe pequeno pintado de propósito (a ilha principal da região, como um olho) vira peça.
  const largest = largestByLabel(islands);
  // Um detalhe pintado de propósito vira peça mesmo pequeno, mas não abaixo de MIN_DETAIL_AREA: uma
  // mancha de tinta de décimos de mm² não é peça que se imprima nem que se encaixe.
  const tiny = islands.filter(
    (i) => i.id !== baseIsland && i.label !== baseLabel && i.area < opts.minIslandArea && isMainIsland(i, largest) && i.area < MIN_DETAIL_AREA,
  );
  const pending = islands.filter(
    (i) =>
      i.id !== baseIsland &&
      i.faces.length >= 3 &&
      (i.area >= opts.minIslandArea || (i.label !== baseLabel && isMainIsland(i, largest) && i.area >= MIN_DETAIL_AREA)),
  );
  const tinyReports: IslandReport[] = tiny.map((i) => ({
    label: i.label,
    method: "falhou",
    purity: 0,
    completeness: 0,
    message: `Região pintada pequena demais para virar peça (${i.area.toFixed(1).replace(".", ",")} mm²): ficou na peça vizinha.`,
  }));
  // Nada a destacar: o sólido segue inteiro, sem passar pelo Manifold.
  if (!pending.length) return { parts: [{ label: restLabel, geometry }], cuts: [], islands: tinyReports, nextCutId: opts.firstCutId };

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
  const reports: IslandReport[] = [...tinyReports];
  let nextCutId = opts.firstCutId;
  const resultsByLabel = new Map<number, Manifold[]>();
  const peeled = new Set<number>();
  // Ilhas que já saíram como peça: lascas de triângulos delas cortados ao meio que ficaram no resto
  // (do lado de cá do corte anterior) não são delas, e passam para a vizinha dominante.
  const separated = new Set<number>();

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

  /**
   * A ilha na malha atual do resto (as tampas de cortes anteriores herdam a ilha vizinha
   * dominante), com os contornos dela. Guardada enquanto o resto não muda: a tampa pelo contorno e
   * o embutido da mesma ilha usam a mesma malha.
   */
  interface SeamContext {
    R: PartGeometry;
    nt: number;
    inSet: Uint8Array;
    faces: number[];
    loops: BoundaryLoop[];
    positions: number[];
    bvh: MeshBVH | null;
  }
  let seamCache: { rest: Manifold; island: number; ctx: SeamContext | null } | null = null;
  const dropSeamCache = () => {
    seamCache?.ctx?.bvh?.geometry.dispose();
    seamCache = null;
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

    /**
     * Quanto o plano se afasta da fronteira pintada, em mm: a maior espessura de região pintada que
     * ficou do outro lado (`left`, ex.: o peito do pé que entra na barra da calça) e de material de
     * fora que veio junto com a peça (`taken`). `size` é o raio do maior contorno da ilha.
     */
    const planeSpill = (attempt: { part: Manifold; cuts: CutRecord[] }, island: number, loops: BoundaryLoop[]) => {
      const inPart = new Uint8Array(n);
      for (const s of reg.toGeometry(attempt.part).src) if (s >= 0) inPart[s] = 1;
      const planes = attempt.cuts.map((c) => c.frame);
      const dist = (f: number, p: PlaneFrame) =>
        (centroids[f * 3] - p.origin[0]) * p.normal[0] + (centroids[f * 3 + 1] - p.origin[1]) * p.normal[1] + (centroids[f * 3 + 2] - p.origin[2]) * p.normal[2];
      // Material "levado" é o das ilhas do outro lado destes contornos; lascas de cortes anteriores
      // (de ilhas que já saíram) não contam.
      const across = new Set<number>();
      for (const l of loops) for (const j of l.neighborIslands) if (!separated.has(j)) across.add(j);
      let left = 0;
      let taken = 0;
      for (let f = 0; f < n; f++) {
        const mine = islandOf[f] === island;
        if (mine && !inPart[f]) {
          let d = 0;
          for (const p of planes) d = Math.max(d, -dist(f, p));
          left = Math.max(left, d);
        } else if (!mine && inPart[f] && across.has(islandOf[f])) {
          let d = Infinity;
          for (const p of planes) d = Math.min(d, dist(f, p));
          if (Number.isFinite(d)) taken = Math.max(taken, d);
        }
      }
      const size = Math.max(...loops.map((l) => loopFrame(island, l).fit.radius));
      // Tamanho médio das arestas do contorno: o pincel pinta triângulos inteiros.
      let edgeSum = 0;
      let edgeCount = 0;
      for (const l of loops)
        for (const h of l.halfEdges) {
          const a = halfEdgeFrom(mesh, h) * 3;
          const b = halfEdgeTo(mesh, h) * 3;
          edgeSum += Math.hypot(mesh.positions[a] - mesh.positions[b], mesh.positions[a + 1] - mesh.positions[b + 1], mesh.positions[a + 2] - mesh.positions[b + 2]);
          edgeCount++;
        }
      return { left, taken, size, edge: edgeCount ? edgeSum / edgeCount : 0 };
    };

    const seamContext = (island: number): SeamContext | null => {
      if (seamCache && seamCache.rest === rest && seamCache.island === island) return seamCache.ctx;
      dropSeamCache();
      const R = reg.toGeometry(rest);
      const rm = R.mesh;
      const nt = triCount(rm);
      const rEdges = buildEdgeTable(rm);
      const rNeighbors = faceNeighbors(rm, rEdges);
      const own = new Int32Array(nt).fill(-1);
      for (let t = 0; t < nt; t++) if (R.src[t] >= 0 && !separated.has(islandOf[R.src[t]])) own[t] = islandOf[R.src[t]];
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
      let ctx: SeamContext | null = null;
      if (faces.length) {
        const inSet = new Uint8Array(nt);
        for (const f of faces) inSet[f] = 1;
        const loops = islandLoops(rm, rEdges, (f) => inSet[f] === 1, faces);
        if (!loops.length || loops.some((l) => !l.closed))
          throw new GeometryError("O contorno da região não forma um laço fechado.", "contorno-aberto");
        ctx = { R, nt, inSet, faces, loops, positions: Array.from(rm.positions), bvh: null };
      }
      seamCache = { rest, island, ctx };
      return ctx;
    };
    const solidBVHOf = (ctx: SeamContext) => (ctx.bvh ??= buildBVH(ctx.R.mesh));

    /**
     * Peça (faces da ilha + tampas, lado 0 do corte) e resto (demais faces + tampas invertidas, lado
     * 1), montados sem booleanas.
     */
    const assemble = (ctx: SeamContext, positions: number[], caps: number[], capTags: number[]) => {
      const { R, nt, inSet } = ctx;
      const rm = R.mesh;
      const pos32 = new Float32Array(positions);
      const build = (keep: (t: number) => boolean, flip: boolean): PartGeometry => {
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
          indices[o * 3 + 1] = caps[i * 3 + (flip ? 2 : 1)];
          indices[o * 3 + 2] = caps[i * 3 + (flip ? 1 : 2)];
          src[o] = -1;
          cut[o] = capTags[i] + (flip ? 1 : 0);
        }
        return compactGeometry({ mesh: { positions: pos32, indices }, src, cut });
      };
      const part = arena.track(reg.fromGeometry(build((t) => inSet[t] === 1, false)));
      try {
        return { part, rest: arena.track(reg.fromGeometry(build((t) => inSet[t] === 0, true))) };
      } catch (e) {
        free(part);
        throw e;
      }
    };

    const seamPeel = (island: number) => {
      const ctx = seamContext(island);
      if (!ctx) return null;
      const rm = ctx.R.mesh;
      const positions = ctx.positions.slice();
      const caps: number[] = [];
      const capTags: number[] = [];
      const seamCuts: CutRecord[] = [];
      let irregular = false;
      // Triângulos de tampa que ainda atravessam a superfície (a peça sai com autointerseção) e a
      // maior fração da área de uma tampa fora do material ou dobrada sobre si mesma.
      let crossings = 0;
      let crossingArea = 0;
      // Maior fração de uma tampa fora do material (tampa fechando um vão pelo lado de fora).
      let outside = 0;
      let rNormals: ReturnType<typeof faceNormalsAndAreas> | null = null;
      let cutId = nextCutId;
      for (const loop of ctx.loops) {
        const verts = loop.halfEdges.map((h) => halfEdgeFrom(rm, h));
        const pts = new Float64Array(verts.length * 3);
        verts.forEach((v, i) => {
          pts[i * 3] = rm.positions[v * 3];
          pts[i * 3 + 1] = rm.positions[v * 3 + 1];
          pts[i * 3 + 2] = rm.positions[v * 3 + 2];
        });
        const fit = fitPlane(pts, verts.length);
        if (fit.maxDeviation > 0.35 * Math.max(fit.radius, 1e-6)) irregular = true;
        // A tampa da peça percorre a borda no sentido oposto ao das faces da ilha. Ela é plana
        // (triangulada na projeção do laço); se a projeção se cruzar, tenta a direção da superfície ao
        // redor (de onde se vê um relevo) e a da própria região.
        rNormals ??= faceNormalsAndAreas(rm);
        const bvh = solidBVHOf(ctx);
        const directions = [averageNormal(rNormals, loop.outerFaces), averageNormal(rNormals, loop.innerFaces), fit.normal];
        const judge = (c: { tris: number[]; extraVerts: Vec3[] }) => capDefects(rm, bvh, positions, c.tris, c.extraVerts);
        let cap = capLoop(verts.slice().reverse(), positions, triangulate, true, directions);
        let defects = cap ? judge(cap) : null;
        // Contorno que se cruza em toda projeção (ex.: dá a volta num relevo), ou tampa plana que
        // atravessa a superfície: tenta a tampa curva em membrana e fica com a de menor defeito.
        if (!cap || !defects || defects.faces > 0) {
          const membrane = membraneCap(verts.slice().reverse(), positions);
          const membraneDefects = judge(membrane);
          if (!cap || !defects || membraneDefects.out + membraneDefects.self < defects.out + defects.self) {
            cap = membrane;
            defects = membraneDefects;
            irregular = true;
          }
        }
        crossings += defects.faces;
        crossingArea = Math.max(crossingArea, defects.out + defects.self);
        outside = Math.max(outside, capOutsideFraction(bvh, positions, cap.tris, cap.extraVerts));
        const { tris, extraVerts } = cap;
        for (const v of extraVerts) positions.push(v[0], v[1], v[2]);
        // A frente do corte aponta para dentro da ilha (mesma convenção do corte plano).
        const capNormal = triangleNormalSum(tris, positions);
        const normal = dot(fit.normal, capNormal) > 0 ? scale(fit.normal, -1) : fit.normal;
        seamCuts.push({ id: cutId, kind: "seam", frame: frameFromNormal(fit.centroid, normal) });
        for (let i = 0; i < tris.length; i += 3) {
          caps.push(tris[i], tris[i + 1], tris[i + 2]);
          capTags.push(cutTag(cutId, 0));
        }
        cutId++;
      }
      const { part, rest: restSolid } = assemble(ctx, positions, caps, capTags);
      // Espessura média da peça (2V/A): uma tampa rente à pintura deixa só uma lâmina.
      const thickness = (2 * Math.abs(part.volume())) / Math.max(part.surfaceArea(), 1e-12);
      return { part, rest: restSolid, cuts: seamCuts, irregular, crossings, crossingArea, outside, thickness };
    };

    /** Peça embutida (ver `inlayCap`): o contorno é o pintado e a peça tem espessura para dentro. */
    const inlayPeel = (island: number) => {
      const ctx = seamContext(island);
      if (!ctx) return null;
      const positions = ctx.positions.slice();
      const cap = inlayCap(ctx.R.mesh, ctx.faces, ctx.loops, solidBVHOf(ctx), positions, {
        maxDepth: INLAY_DEPTH,
        minDepth: INLAY_MIN_DEPTH,
        minWall: FDM_MIN_WALL,
      });
      if (!cap) return null;
      for (const v of cap.extraVerts) positions.push(v[0], v[1], v[2]);
      const cutId = nextCutId;
      const tags = new Array<number>(cap.tris.length / 3).fill(cutTag(cutId, 0));
      try {
        const { part, rest: restSolid } = assemble(ctx, positions, cap.tris, tags);
        // Uma peça embutida tem o volume da área pintada vezes a espessura; bem menos que isso é uma
        // casca degenerada (o fundo deslocado cruzou o topo): não serve.
        if (Math.abs(part.volume()) < 0.5 * cap.projected * cap.depth) {
          free(part, restSolid);
          return null;
        }
        // A frente do corte aponta para dentro da peça: para fora da superfície pintada.
        const depth = Math.round(cap.depth * 100) / 100;
        const cuts: CutRecord[] = [{ id: cutId, kind: "seam", frame: frameFromNormal(cap.centroid, cap.normal), inlay: depth }];
        return { part, rest: restSolid, cuts, depth };
      } catch (e) {
        if (e instanceof GeometryError) return null;
        throw e;
      }
    };

    /**
     * Região "remendo" (olho, emblema, relevo): olha para um lado só (a normal média ponderada pela
     * área é forte; numa faixa em volta de um membro ela se anula) e a área que fecha os contornos é
     * uma boa parte da área pintada (num membro ou numa bota a tampa é bem menor que a peça).
     */
    const patchLike = (island: number) => {
      const isl = islands[island];
      const facing: Vec3 = [0, 0, 0];
      for (let i = 0; i < isl.faces.length; i++) {
        const f = isl.faces[i];
        for (let k = 0; k < 3; k++) facing[k] += normalsArr[f * 3 + k] * areas[f];
      }
      if (length(facing) < 0.5 * isl.area) return false;
      let capArea = 0;
      for (const loop of loopsByIsland.get(island) ?? []) {
        const { fit } = loopFrame(island, loop);
        const frame = frameFromNormal(fit.centroid, fit.normal);
        const pts = loop.vertices.map((v) => toLocal(frame, [mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]]));
        let a = 0;
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
        capArea += Math.abs(a) / 2;
      }
      return capArea >= 0.25 * islands[island].area;
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
      // Plano de reserva (não reproduz a fronteira pintada). Na segmentação automática a fronteira é
      // aproximada e um plano imperfeito, com aviso, vale mais que deixar a região sem separar. Com
      // pintura à mão ele cortaria fora do que a pessoa pintou (o funil da bota preso na perna, só a
      // íris em vez do olho): não vale.
      const fallbackUsable = () => fallback !== null && !opts.precise && (fallbackGood || fallback.purity >= 0.6);

      if (!accepted && loops.length > 0 && mode !== "seam") {
        const attempt = planarPeel(island.id, loops);
        if (attempt) {
          // Pureza: nada de outra parte do modelo dentro da peça. Completude mais tolerante: um plano
          // sempre desvia um pouco da fronteira pintada e deixa um pequeno toco do outro lado.
          const good = attempt.purity >= purityThreshold && attempt.completeness >= 0.75;
          // Mas um plano que deixa um pedaço visível da região na peça vizinha (o calcanhar de um
          // sapato que entra na barra da calça, por exemplo) não é o corte que o usuário pintou: no
          // modo automático o contorno pintado é tentado antes, e o plano fica de reserva.
          let complete = attempt.completeness >= 0.95;
          // Pintura feita à mão marca a fronteira que a pessoa quer: além da área, o plano não pode se
          // afastar dela (nem deixar o peito do pé na calça, nem levar pele junto com um relevo) mais
          // que 10% do raio do corte, com no mínimo 0,2 mm (abaixo do que uma impressora mostra) e um
          // triângulo da malha (o pincel pinta triângulos inteiros: a borda é serrilhada).
          if (complete && opts.precise) {
            const spill = planeSpill(attempt, island.id, loops);
            const tol = Math.max(0.1 * spill.size, 0.2, spill.edge);
            complete = spill.left <= tol && spill.taken <= tol;
          }
          if ((good && complete) || mode === "plane") acceptPlanar(attempt, good);
          else {
            fallback = attempt;
            fallbackGood = good;
          }
        }
      }

      if (!accepted && loops.length > 0 && mode !== "plane") {
        try {
          const acceptSeam = (seam: NonNullable<ReturnType<typeof seamPeel>>) => {
            push(island.label, seam.part);
            free(rest);
            rest = seam.rest;
            cuts.push(...seam.cuts);
            nextCutId += seam.cuts.length;
            report.method = "contorno";
            report.purity = 1;
            report.completeness = 1;
            if (seam.irregular) report.message = "O contorno pintado é bem irregular; a tampa do corte pode ficar inclinada.";
            if (seam.crossingArea > 0.002)
              report.message = `A tampa do corte raspa a superfície do modelo em ${seam.crossings} ponto(s) (contorno pintado irregular). Confira a peça; se precisar, suavize a pintura nessa fronteira ou use o corte por plano.`;
            accepted = true;
          };
          const acceptInlay = (inlay: NonNullable<ReturnType<typeof inlayPeel>>) => {
            push(island.label, inlay.part);
            free(rest);
            rest = inlay.rest;
            cuts.push(...inlay.cuts);
            nextCutId += inlay.cuts.length;
            report.method = "contorno";
            report.purity = 1;
            report.completeness = 1;
            report.message = `Peça embutida: o contorno pintado vira o topo de uma peça de ${inlay.depth.toFixed(1).replace(".", ",")} mm de espessura, que assenta num rebaixo do mesmo formato.`;
            accepted = true;
          };
          const seam = seamPeel(island.id);
          // Tampa no ar (fechando um vão por fora) ou com uma parte relevante da área atravessando a
          // superfície: as peças se sobrepõem e não servem. Triângulos minúsculos que raspam no pé de
          // um relevo (a borda pintada em zigue-zague junto de uma parede) não contam.
          const offMaterial = seam !== null && seam.outside > 0.2;
          const tangled = seam !== null && seam.crossingArea > 0.01;
          // Detalhe de superfície (olho, emblema, relevo raso): sem tampa possível, ou com uma peça
          // fina demais para imprimir, vira peça embutida, com o contorno exato da pintura.
          const patch = patchLike(island.id);
          if (seam && !offMaterial && !tangled) {
            const inlay = patch && seam.thickness < FDM_MIN_WALL ? inlayPeel(island.id) : null;
            if (inlay) {
              free(seam.part, seam.rest);
              acceptInlay(inlay);
            } else acceptSeam(seam);
          } else if (seam) {
            free(seam.part, seam.rest);
            const inlay = patch ? inlayPeel(island.id) : null;
            if (inlay) {
              if (fallback) free(fallback.part, fallback.rest);
              fallback = null;
              acceptInlay(inlay);
            } else if (fallbackUsable()) {
              // Um plano imperfeito, mas que gera sólidos válidos, é melhor que uma tampa com defeito
              // grave (só na segmentação automática, ver `fallbackUsable`).
              const f = fallback!;
              fallback = null;
              acceptPlanar(f, fallbackGood);
              report.message = fallbackGood
                ? `${report.message ?? ""} O contorno não permitiu uma tampa limpa; a peça foi separada pelo plano de junção.`.trim()
                : "O contorno é irregular demais para uma tampa que o siga; a peça foi separada por um plano. Confira a peça.";
            } else
              report.message = offMaterial
                ? "A fronteira pintada passa pela borda de uma abertura (a boca de um cano, de uma manga ou de um chapéu) e não dá para fechar o corte por dentro do material. Pinte também o lado de dentro da abertura até onde ela encontra a parte vizinha, ou use o modo Plano."
                : "A fronteira pintada é irregular demais: a tampa do corte atravessaria a superfície e as peças ficariam sobrepostas. Suavize a pintura nessa fronteira ou use o modo Plano.";
          }
        } catch (e) {
          report.message = (e as Error).message;
        }
      }

      if (!accepted && fallback) {
        if (fallbackUsable()) acceptPlanar(fallback, fallbackGood);
        else {
          free(fallback.part, fallback.rest);
          // Com pintura à mão, nenhum corte fora do que foi pintado: a região fica no corpo e a
          // mensagem diz o que ajustar.
          if (opts.precise)
            report.message ??=
              "Nenhum corte segue esta fronteira pintada (um plano deixaria parte da região na peça vizinha ou levaria material sem pintura). Ajuste a pintura nessa fronteira ou use o modo Plano.";
        }
      }
      if (!accepted)
        report.message ??= "Não foi possível destacar esta região. Ajuste a pintura ou use o corte por plano.";
      peeled.add(island.id);
      if (accepted) separated.add(island.id);
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
    dropSeamCache();
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
 * Trechos do corpo principal que não tocam a maior ilha dele. O corpo principal é escolhido em cada
 * sólido (`comp`): num arquivo com várias cascas, a parte não pintada de uma casca continua sendo o
 * corpo dela, mesmo que outra casca do arquivo seja maior.
 *
 * - Um furo na pintura (a íris que o pincel não cobriu dentro do olho pintado, bem menor que a região
 *   em volta) fica com a região que o cerca.
 * - Na segmentação automática, um trecho não marcado preso só a uma parte (o pescoço, um chapéu)
 *   acompanha a vizinha com a maior fronteira.
 * - Com pintura à mão, um trecho grande que a pintura deixou solto (a bota abaixo de uma canela
 *   pintada) não foi pintado: ele vira uma peça própria, com um rótulo novo, em vez de ser
 *   "pintado" junto com a região vizinha.
 */
const HOLE_FRACTION = 0.3;

function attachDetachedBase(
  labels: Uint16Array,
  neighbors: Int32Array,
  areas: Float32Array,
  baseLabel: number,
  comp: Int32Array,
  precise: boolean,
  firstNewLabel: number,
): { labels: Uint16Array; detached: number[] } {
  const { islands, islandOf } = labelIslands(labels, neighbors, areas);
  const bases = islands.filter((i) => i.label === baseLabel);
  if (bases.length < 2) return { labels, detached: [] };
  const mainOf = new Map<number, (typeof bases)[number]>();
  for (const isl of bases) {
    const s = comp[isl.faces[0]];
    const cur = mainOf.get(s);
    if (!cur || isl.area > cur.area) mainOf.set(s, isl);
  }
  const out = labels.slice();
  const detached: number[] = [];
  let next = firstNewLabel;
  for (const isl of bases) {
    if (mainOf.get(comp[isl.faces[0]]) === isl) continue;
    const border = new Map<number, number>();
    const around = new Set<number>();
    for (const f of isl.faces)
      for (let k = 0; k < 3; k++) {
        const g = neighbors[f * 3 + k];
        if (g >= 0 && islandOf[g] !== isl.id && labels[g] !== baseLabel) {
          border.set(labels[g], (border.get(labels[g]) ?? 0) + 1);
          around.add(islandOf[g]);
        }
      }
    let best = -1;
    let count = 0;
    for (const [l, c] of border)
      if (c > count) {
        best = l;
        count = c;
      }
    if (best < 0) continue;
    let surrounding = 0;
    for (const j of around) surrounding += islands[j].area;
    if (precise && isl.area >= HOLE_FRACTION * surrounding && next <= 0xffff) {
      for (const f of isl.faces) out[f] = next;
      detached.push(next++);
    } else for (const f of isl.faces) out[f] = best;
  }
  return { labels: out, detached };
}

/** Normal média (ponderada pela área) de um conjunto de faces. */
function averageNormal(na: { normals: ArrayLike<number>; areas: ArrayLike<number> }, faces: number[]): Vec3 {
  const s: Vec3 = [0, 0, 0];
  for (const f of faces) for (let k = 0; k < 3; k++) s[k] += na.normals[f * 3 + k] * na.areas[f];
  const l = Math.hypot(s[0], s[1], s[2]);
  return l > 1e-12 ? scale(s, 1 / l) : [0, 0, 0];
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
  /** "contact": peças que já eram cascas separadas no arquivo e se encostam (figura sobre a base). */
  kind: "plane" | "seam" | "contact";
  frame: PlaneFrame;
  /** Peça do lado da frente do corte (para onde a normal aponta). */
  front: string;
  back: string;
  /** Região de contato no plano do corte (contornos externos CCW e furos CW). */
  polygons: Vec2[][];
  area: number;
  /** Afastamento máximo da tampa em relação ao plano (0 para cortes planos). */
  deviation: number;
  /** Corte embutido (ver `CutRecord.inlay`): espessura da peça embutida, que fica na frente. */
  inlay?: number;
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
  let deviation = 0;
  const p = g.mesh.positions;
  const idx = g.mesh.indices;
  const local = new Map<number, Vec3>();
  const at = (v: number) => {
    let l = local.get(v);
    if (!l) {
      l = toLocal(frame, [p[v * 3], p[v * 3 + 1], p[v * 3 + 2]]);
      local.set(v, l);
    }
    return l;
  };
  const tris: number[] = [];
  let pos = 0;
  let neg = 0;
  for (let t = 0; t < g.cut.length; t++) {
    if (g.cut[t] !== tag) continue;
    const a = idx[t * 3];
    const b = idx[t * 3 + 1];
    const c = idx[t * 3 + 2];
    const la = at(a);
    const lb = at(b);
    const lc = at(c);
    const dev = Math.max(Math.abs(la[2]), Math.abs(lb[2]), Math.abs(lc[2]));
    if (dev > maxDeviation) continue;
    deviation = Math.max(deviation, dev);
    const area = (lb[0] - la[0]) * (lc[1] - la[1]) - (lc[0] - la[0]) * (lb[1] - la[1]);
    if (Math.abs(area) < 1e-12) continue;
    if (area > 0) pos++;
    else neg++;
    tris.push(a, b, c);
  }
  // A região é a tampa vista de frente. Sem dobras na projeção, ela é o interior da borda da tampa
  // (arestas usadas por um triângulo só): poucos pontos, em vez de unir milhares de triângulos de uma
  // tampa em membrana (segundos por corte).
  const boundary = Math.min(pos, neg) <= 0.02 * (pos + neg) ? capBoundary(tris) : null;
  if (boundary) {
    const polys = boundary.map((loop) => loop.map((v) => [at(v)[0], at(v)[1]] as Vec2));
    return { cs: new w.CrossSection(polys, "NonZero"), deviation };
  }
  const polys: Vec2[][] = [];
  for (let i = 0; i < tris.length; i += 3) {
    const tri = [at(tris[i]), at(tris[i + 1]), at(tris[i + 2])].map((l) => [l[0], l[1]] as Vec2);
    const area = (tri[1][0] - tri[0][0]) * (tri[2][1] - tri[0][1]) - (tri[2][0] - tri[0][0]) * (tri[1][1] - tri[0][1]);
    polys.push(area > 0 ? tri : [tri[0], tri[2], tri[1]]);
  }
  return { cs: new w.CrossSection(polys, "Positive"), deviation };
}

/** Laços da borda de um conjunto de triângulos (arestas sem a gêmea), ou null se a borda se tocar. */
function capBoundary(tris: number[]): number[][] | null {
  const key = (a: number, b: number) => `${a},${b}`;
  const directed = new Set<string>();
  for (let i = 0; i < tris.length; i += 3)
    for (let k = 0; k < 3; k++) directed.add(key(tris[i + k], tris[i + ((k + 1) % 3)]));
  const next = new Map<number, number>();
  for (let i = 0; i < tris.length; i += 3)
    for (let k = 0; k < 3; k++) {
      const a = tris[i + k];
      const b = tris[i + ((k + 1) % 3)];
      if (directed.has(key(b, a))) continue;
      if (next.has(a)) return null;
      next.set(a, b);
    }
  const loops: number[][] = [];
  const used = new Set<number>();
  for (const start of next.keys()) {
    if (used.has(start)) continue;
    const loop: number[] = [];
    let v = start;
    while (!used.has(v)) {
      used.add(v);
      loop.push(v);
      const n = next.get(v);
      if (n === undefined) return null;
      v = n;
    }
    if (v !== start || loop.length < 3) return null;
    loops.push(loop);
  }
  return loops.length ? loops : null;
}

/**
 * Eixo do membro em que está a tampa `tag` (orientado como `normal`), ou null se a superfície em
 * volta da tampa não for um tubo: as faces da peça perto da tampa (até 1,5 raio dela) têm normais
 * perpendiculares a uma direção só.
 */
function limbAxis(g: PartGeometry, tag: number, normal: Vec3): Vec3 | null {
  const p = g.mesh.positions;
  const idx = g.mesh.indices;
  const center: Vec3 = [0, 0, 0];
  let nv = 0;
  for (let t = 0; t < g.cut.length; t++) {
    if (g.cut[t] !== tag) continue;
    for (let k = 0; k < 3; k++) {
      const v = idx[t * 3 + k] * 3;
      center[0] += p[v];
      center[1] += p[v + 1];
      center[2] += p[v + 2];
      nv++;
    }
  }
  if (!nv) return null;
  for (let k = 0; k < 3; k++) center[k] /= nv;
  let radius = 0;
  let capArea = 0;
  for (let t = 0; t < g.cut.length; t++) {
    if (g.cut[t] !== tag) continue;
    for (let k = 0; k < 3; k++) {
      const v = idx[t * 3 + k] * 3;
      radius = Math.max(radius, Math.hypot(p[v] - center[0], p[v + 1] - center[1], p[v + 2] - center[2]));
    }
    const a = idx[t * 3] * 3;
    const b = idx[t * 3 + 1] * 3;
    const c = idx[t * 3 + 2] * 3;
    capArea += length(cross([p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]], [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]])) / 2;
  }
  const reach = 1.5 * radius;
  const cov = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  let side = 0;
  for (let t = 0; t < g.cut.length; t++) {
    if (g.cut[t] === tag) continue;
    let near = true;
    for (let k = 0; k < 3 && near; k++) {
      const v = idx[t * 3 + k] * 3;
      near = Math.hypot(p[v] - center[0], p[v + 1] - center[1], p[v + 2] - center[2]) <= reach;
    }
    if (!near) continue;
    const a = idx[t * 3] * 3;
    const b = idx[t * 3 + 1] * 3;
    const c = idx[t * 3 + 2] * 3;
    const n = cross([p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]], [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]]);
    const l = length(n);
    if (!(l > 0)) continue;
    // Peso = área (|n|/2); n·nᵀ/|n| = área × 2 × (normal unitária)².
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cov[i * 3 + j] += (n[i] * n[j]) / l;
    side += l / 2;
  }
  if (side < 0.5 * capArea) return null;
  const { values, vectors } = symmetricEigen3(cov);
  // Tubo: as normais giram em volta do eixo (dois autovalores grandes e um quase nulo). Uma superfície
  // quase plana (normais todas iguais) não é tubo.
  const total = values[0] + values[1] + values[2];
  if (!(values[0] < 0.25 * values[1]) || !(values[1] > 0.2 * total)) return null;
  const axis = vectors[0];
  return dot(axis, normal) < 0 ? scale(axis, -1) : axis;
}

/** Raio inscrito (mm) abaixo do qual uma seção não comporta um pino de 2 mm com parede. */
const NARROW_SECTION = 2.2;

/** Raio do maior círculo inscrito numa seção (bissecção de offsets negativos). */
function sectionRadius(w: Wasm, polygons: Vec2[][]): number {
  if (!polygons.length) return 0;
  const cs = new w.CrossSection(polygons, "Positive");
  try {
    let lo = 0;
    let hi = Math.sqrt(Math.max(cs.area(), 1e-9));
    for (let i = 0; i < 14; i++) {
      const mid = (lo + hi) / 2;
      const inset = cs.offset(-mid, "Round");
      const empty = inset.isEmpty();
      inset.delete();
      if (empty) hi = mid;
      else lo = mid;
    }
    return lo;
  } finally {
    cs.delete();
  }
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
        // Em costuras, os encaixes vão para a parte quase plana da tampa (até 1 mm do plano ajustado),
        // se ela for a maior parte da tampa; numa tampa só um pouco torta (contorno serrilhado) essa
        // janela recortaria a seção e o pino não caberia, então vale a tampa inteira projetada. Num
        // embutido a seção é o contorno inteiro da peça, no plano do fundo.
        // Em costuras, os encaixes vão para a parte quase plana da tampa (até 1 mm do plano ajustado);
        // se ela não existir, usa a tampa inteira projetada no plano do corte.
        const seam = cut.kind === "seam" && !cut.inlay;
        let best = seam ? contactAt(seamFrame(f.geometry, cutTag(cut.id, 0), cut.frame), 1) : null;
        if (!best || best.area < minArea) best = contactAt(cut.frame, Infinity);
        // Corte por contorno num membro (a perna dentro do cano de uma bota) com a tampa inclinada em
        // relação a ele: o pino perpendicular à tampa atravessa a perna de lado e sai pela parede, ou
        // a parte plana da tampa fica estreita demais para ele. Aí vale a seção vista ao longo do
        // membro (o encaixe segue o eixo dele), desde que ela seja a do membro: bem maior que a parte
        // plana, ela estaria pegando sobras de uma tampa irregular (um ombro); bem menor, o "membro"
        // não é o do corte. Nos dois casos a parte plana fica.
        if (seam) {
          const axis = limbAxis(f.geometry, cutTag(cut.id, 0), best.frame.normal) ?? limbAxis(b.geometry, cutTag(cut.id, 1), best.frame.normal);
          const cos = axis ? dot(axis, best.frame.normal) : 1;
          if (axis && cos < Math.cos((12 * Math.PI) / 180)) {
            const narrow = sectionRadius(w, best.polygons) < NARROW_SECTION;
            const tilted = cos < Math.cos((25 * Math.PI) / 180);
            if (narrow || tilted) {
              const along = contactAt(frameFromNormal(best.frame.origin, axis), Infinity);
              const plausible = along.area >= Math.max(minArea, 0.5 * best.area) && along.area <= 2 * best.area;
              if (plausible && (tilted || sectionRadius(w, along.polygons) > sectionRadius(w, best.polygons))) best = along;
            }
          }
        }
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
            ...(cut.inlay ? { inlay: cut.inlay } : {}),
          });
      }
  }
  return out;
}
