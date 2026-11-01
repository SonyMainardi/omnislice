import type { Manifold } from "manifold-3d";
import { DoubleSide, Ray, Vector3 } from "three";
import type { MeshBVH } from "three-mesh-bvh";
import { analyzeMesh } from "./analysis";
import { FDM_MIN_WALL, FLAP_WIDTH, capFlap } from "./flaps";
import { buildBVH, countSelfIntersections } from "./bvh";
import type { ConnectorPlan } from "./connectors";
import { Arena, GeometryError, RunRegistry, type Wasm } from "./manifoldBridge";
import { type PlaneFrame, type Vec2, type Vec3, toLocal } from "./math";
import { type IndexedMesh, boundsDiagonal, computeBounds, faceCentroids, faceNormalsAndAreas, triCount } from "./mesh";
import { CONNECTOR_TAG, type PartGeometry, cutTag, tagCutId, tagSide } from "./part";
import { decomposeSolids } from "./solids";
import type { CutRecord, Interface } from "./split";

/**
 * Verificação independente do resultado de um corte e dos encaixes. Nada aqui reaproveita a
 * construção que está sendo verificada: as medidas saem das malhas finais, do modelo de antes e de
 * booleanas e raios próprios.
 */

export type CheckSeverity = "erro" | "aviso";

export interface Check {
  /** Critério (identificador estável). */
  id: string;
  /** Critério em linguagem do usuário. */
  label: string;
  ok: boolean;
  severity: CheckSeverity;
  /** O que foi medido, com o limite. */
  detail: string;
  /** Peça, corte ou encaixe a que se refere. */
  subject?: string;
}

export interface VerifyReport {
  ok: boolean;
  checks: Check[];
}

export interface VerifyTolerances {
  /** Distância (mm) tratada como zero: arredondamento das coordenadas em float32. */
  length: number;
  /** Volume (mm³) tratado como zero. */
  volume: number;
  /** Erro relativo aceito em somas de área e volume. */
  relative: number;
  /** Parede mínima imprimível em FDM (mm). */
  minWall: number;
  /** Largura (mm) a partir da qual uma região mais fina que `minWall` é uma aba. */
  flapWidth: number;
  /** Volume (mm³) abaixo do qual uma peça é um fragmento. */
  minPartVolume: number;
  /** Espessura média (2V/A) do modelo de antes: referência para chamar uma peça de lâmina. */
  originalThickness: number;
  /**
   * Gravidade de abas e fragmentos. Num corte escolhido pelo usuário o plano é dele (aviso); na
   * divisão automática quem escolhe é o algoritmo (erro).
   */
  choiceSeverity: CheckSeverity;
}

function tolerancesFor(mesh: IndexedMesh, volume: number, area: number, over?: Partial<VerifyTolerances>): VerifyTolerances {
  const b = computeBounds(mesh.positions);
  const diag = boundsDiagonal(b);
  // Coordenadas em float32: o passo de arredondamento cresce com a distância da origem.
  const reach = Math.max(...b.min.map(Math.abs), ...b.max.map(Math.abs));
  return {
    length: Math.max(1e-4, diag * 2e-6, reach * 5e-7),
    volume: Math.max(1e-3, Math.abs(volume) * 1e-7),
    relative: 1e-5,
    minWall: FDM_MIN_WALL,
    flapWidth: FLAP_WIDTH,
    minPartVolume: Math.max(1, Math.abs(volume) * 1e-3),
    originalThickness: (2 * Math.abs(volume)) / Math.max(area, 1e-12),
    choiceSeverity: "erro",
    ...over,
  };
}

const fmt = (x: number, digits = 4) => (Math.abs(x) >= 1e-3 || x === 0 ? x.toFixed(digits) : x.toExponential(2));

class Checklist {
  readonly checks: Check[] = [];
  add(id: string, label: string, ok: boolean, detail: string, subject?: string, severity: CheckSeverity = "erro") {
    this.checks.push({ id, label, ok, severity, detail, subject });
  }
  report(): VerifyReport {
    return { ok: this.checks.every((c) => c.ok || c.severity === "aviso"), checks: this.checks };
  }
}

// ---------------------------------------------------------------------------------------------
// Medidas
// ---------------------------------------------------------------------------------------------

function solidOrNull(reg: RunRegistry, g: PartGeometry): Manifold | null {
  try {
    return reg.fromGeometry(g);
  } catch (e) {
    if (e instanceof GeometryError) return null;
    throw e;
  }
}

/** Distância máxima dos vértices das faces escolhidas até a superfície de referência. */
function maxDistanceToSurface(bvh: MeshBVH, mesh: IndexedMesh, keep: (t: number) => boolean): number {
  const seen = new Uint8Array(mesh.positions.length / 3);
  const p = new Vector3();
  const hit = { point: new Vector3(), distance: 0, faceIndex: 0 };
  let worst = 0;
  for (let t = 0; t < triCount(mesh); t++) {
    if (!keep(t)) continue;
    for (let k = 0; k < 3; k++) {
      const v = mesh.indices[t * 3 + k];
      if (seen[v]) continue;
      seen[v] = 1;
      p.set(mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]);
      const r = bvh.closestPointToPoint(p, hit);
      if (r) worst = Math.max(worst, r.distance);
    }
  }
  return worst;
}

function longestEdge(m: IndexedMesh, t: number): number {
  const p = m.positions;
  const v = [m.indices[t * 3] * 3, m.indices[t * 3 + 1] * 3, m.indices[t * 3 + 2] * 3];
  let best = 0;
  for (let k = 0; k < 3; k++) {
    const a = v[k];
    const b = v[(k + 1) % 3];
    best = Math.max(best, Math.hypot(p[a] - p[b], p[a + 1] - p[b + 1], p[a + 2] - p[b + 2]));
  }
  return best;
}

function tagsOf(g: PartGeometry): Set<number> {
  const s = new Set<number>();
  for (let t = 0; t < g.cut.length; t++) if (g.cut[t] >= 0) s.add(g.cut[t]);
  return s;
}

function areaWhere(areas: Float32Array, keep: (t: number) => boolean): number {
  let a = 0;
  for (let t = 0; t < areas.length; t++) if (keep(t)) a += areas[t];
  return a;
}

// ---------------------------------------------------------------------------------------------
// Peças isoladas
// ---------------------------------------------------------------------------------------------

function partChecks(
  list: Checklist,
  reg: RunRegistry,
  arena: Arena,
  name: string,
  g: PartGeometry,
  tol: VerifyTolerances,
  allowMultipleSolids: boolean,
  isNew: (face: number) => boolean,
): Manifold | null {
  const r = analyzeMesh(g.mesh);
  list.add(
    "fechada",
    "Malha fechada (todas as superfícies abertas foram fechadas)",
    r.boundaryEdges === 0 && r.nonManifoldEdges === 0,
    `${r.boundaryEdges} aresta(s) aberta(s), ${r.nonManifoldEdges} não-manifold`,
    name,
  );
  list.add(
    "orientada",
    "Normais coerentes e para fora",
    r.inconsistentEdges === 0 && r.invertedComponents === 0,
    `${r.inconsistentEdges} aresta(s) incoerente(s), ${r.invertedComponents} casca(s) do avesso`,
    name,
  );
  list.add(
    "sem-degeneradas",
    "Sem faces degeneradas ou duplicadas",
    r.degenerateFaces === 0 && r.duplicateFaces === 0,
    `${r.degenerateFaces} degenerada(s), ${r.duplicateFaces} duplicada(s)`,
    name,
  );
  // Cruzamentos que envolvem uma face nova (tampa, encaixe) foram criados pela operação; os demais
  // já existiam no modelo e são só informados.
  const created = countSelfIntersections(g.mesh, 20, undefined, (i, j) => isNew(i) || isNew(j));
  const inherited = countSelfIntersections(g.mesh, 1000, undefined, (i, j) => !isNew(i) && !isNew(j));
  list.add(
    "sem-autointersecao",
    "Sem autointerseções criadas pelo corte",
    created === 0,
    `${created}${created >= 20 ? "+" : ""} par(es) novo(s) se cruzando${inherited ? `; ${inherited}${inherited >= 1000 ? "+" : ""} herdado(s) do modelo` : ""}`,
    name,
  );
  const solid = solidOrNull(reg, g);
  list.add("solido-valido", "Sólido válido para operações booleanas", solid !== null, solid ? "aceito pelo Manifold" : "rejeitado", name);
  if (!solid) return null;
  arena.track(solid);
  const pieces = arena.trackAll(decomposeSolids(solid));
  if (!allowMultipleSolids)
    list.add("peca-unica", "Uma peça física (sem pedaços soltos)", pieces.length === 1, `${pieces.length} sólido(s)`, name);
  const volume = solid.volume();
  const meanThickness = (2 * volume) / Math.max(solid.surfaceArea(), 1e-12);
  // Lâmina: mais fina que a parede mínima e bem mais fina que o próprio modelo (um decalque de
  // 0,5 mm cortado ao meio continua sendo um decalque, não um fragmento).
  const lamina = meanThickness < Math.min(tol.minWall, tol.originalThickness * 0.5);
  list.add(
    "sem-fragmento",
    "Não é fragmento pequeno nem lâmina",
    volume >= tol.minPartVolume && !lamina,
    `volume ${fmt(volume, 2)} mm³ (mín. ${fmt(tol.minPartVolume, 2)}), espessura média ${fmt(meanThickness, 2)} mm (modelo: ${fmt(tol.originalThickness, 2)})`,
    name,
    tol.choiceSeverity,
  );
  return solid;
}

// ---------------------------------------------------------------------------------------------
// Corte
// ---------------------------------------------------------------------------------------------

export interface CutVerifyInput {
  /** Peça antes do corte (ou o modelo inteiro). */
  original: PartGeometry;
  parts: { name: string; geometry: PartGeometry }[];
  /** Cortes feitos nesta operação: as tampas deles são as únicas faces novas permitidas. */
  cuts: CutRecord[];
  /** O usuário pediu cada pedaço solto como peça própria, ou a peça já tinha várias cascas. */
  allowMultipleSolids?: boolean;
}

/** Verifica um corte (por plano, por regiões ou sucessivos) contra a peça de antes. */
export function verifyCut(w: Wasm, input: CutVerifyInput, over?: Partial<VerifyTolerances>): VerifyReport {
  const list = new Checklist();
  const reg = new RunRegistry(w);
  const arena = new Arena();
  try {
    const original = solidOrNull(reg, input.original);
    if (!original) {
      list.add("original-valido", "Peça de antes é um sólido válido", false, "rejeitada pelo Manifold");
      return list.report();
    }
    arena.track(original);
    const vOrig = original.volume();
    const tol = tolerancesFor(input.original.mesh, vOrig, original.surfaceArea(), over);
    const newCuts = new Set(input.cuts.map((c) => c.id));
    const isNewCap = (tag: number) => tag >= 0 && newCuts.has(tagCutId(tag));
    const oldTags = tagsOf(input.original);
    const hadConnectors = input.original.cut.some((c) => c === CONNECTOR_TAG);

    const solids: (Manifold | null)[] = input.parts.map((p) =>
      partChecks(list, reg, arena, p.name, p.geometry, tol, input.allowMultipleSolids ?? false, (t) => isNewCap(p.geometry.cut[t])),
    );

    // Identidade: toda face nova é tampa de um corte desta operação; o resto vem da peça de antes.
    for (const p of input.parts) {
      let orphan = 0;
      for (let t = 0; t < p.geometry.cut.length; t++) {
        const tag = p.geometry.cut[t];
        const fromBefore = p.geometry.src[t] >= 0 || oldTags.has(tag) || (tag === CONNECTOR_TAG && hadConnectors);
        if (!fromBefore && !isNewCap(tag)) orphan++;
      }
      list.add("rastreavel", "Toda face rastreável (cor, material e corte de origem)", orphan === 0, `${orphan} face(s) sem origem`, p.name);
    }

    // Partição: as peças somam o volume de antes, não se sobrepõem e, juntas, são a peça de antes.
    // Cascas que se cruzam dentro de uma mesma malha (logotipo cravado num chapéu, peças de um 3MF
    // multipartes) não são uma entrada válida para booleanas: cada sólido é unido antes de comparar.
    const flat = (m: Manifold): Manifold => {
      const pieces = decomposeSolids(m);
      if (pieces.length < 2) return m;
      arena.trackAll(pieces);
      return arena.track(w.Manifold.union(pieces));
    };
    const valid = solids.filter((s): s is Manifold => s !== null).map(flat);
    const flatOriginal = flat(original);
    if (valid.length === solids.length) {
      const vSum = solids.reduce((s, m) => s + (m?.volume() ?? 0), 0);
      const dv = Math.abs(vSum - vOrig);
      list.add(
        "volume-conservado",
        "Volume conservado (nada perdido nem duplicado)",
        dv <= Math.max(tol.volume, vOrig * tol.relative),
        `soma ${fmt(vSum, 3)} mm³ × antes ${fmt(vOrig, 3)} mm³ (diferença ${fmt(dv)})`,
      );
      let worstOverlap = 0;
      let pair = "";
      for (let i = 0; i < valid.length; i++)
        for (let j = i + 1; j < valid.length; j++) {
          const a = valid[i].boundingBox();
          const b = valid[j].boundingBox();
          if (a.max.some((v, k) => v < b.min[k]) || b.max.some((v, k) => v < a.min[k])) continue;
          const v = Math.abs(arena.track(valid[i].intersect(valid[j])).volume());
          if (v > worstOverlap) {
            worstOverlap = v;
            pair = `${input.parts[i].name} × ${input.parts[j].name}`;
          }
        }
      list.add(
        "sem-sobreposicao",
        "Peças não se sobrepõem",
        worstOverlap <= tol.volume,
        `maior sobreposição ${fmt(worstOverlap)} mm³${pair ? ` (${pair})` : ""}`,
      );
      const union = arena.track(w.Manifold.union(valid));
      const missing = Math.abs(arena.track(flatOriginal.subtract(union)).volume());
      const extra = Math.abs(arena.track(union.subtract(flatOriginal)).volume());
      list.add(
        "posicao-original",
        "Montadas, as peças voltam exatamente à forma e à posição de antes",
        missing <= tol.volume * 10 && extra <= tol.volume * 10,
        `faltando ${fmt(missing)} mm³, sobrando ${fmt(extra)} mm³`,
      );
    }

    // Superfície externa: cada face que não é tampa nova está sobre a superfície de antes, e a área
    // de antes aparece inteira (nem buraco, nem face repetida).
    const bvh = buildBVH(input.original.mesh);
    const origArea = areaWhere(faceNormalsAndAreas(input.original.mesh).areas, () => true);
    let keptArea = 0;
    let worstDev = 0;
    for (const p of input.parts) {
      const { areas } = faceNormalsAndAreas(p.geometry.mesh);
      const keep = (t: number) => !isNewCap(p.geometry.cut[t]);
      keptArea += areaWhere(areas, keep);
      worstDev = Math.max(worstDev, maxDistanceToSurface(bvh, p.geometry.mesh, keep));
    }
    bvh.geometry.dispose();
    list.add(
      "detalhes-preservados",
      "Detalhes externos preservados (nenhum vértice fora da superfície original)",
      worstDev <= tol.length,
      `desvio máximo ${fmt(worstDev, 6)} mm (limite ${fmt(tol.length, 6)})`,
    );
    const dArea = Math.abs(keptArea - origArea) / Math.max(origArea, 1e-12);
    list.add(
      "superficie-completa",
      "Superfície original completa (sem trecho perdido ou duplicado)",
      dArea <= tol.relative,
      `área ${fmt(keptArea, 3)} × ${fmt(origArea, 3)} mm² (erro relativo ${fmt(dArea)})`,
    );

    // Tampas: existem dos dois lados, ficam no plano, casam e apontam para fora de cada peça.
    for (const cut of input.cuts) {
      const subject = `corte ${cut.id}`;
      let front = 0;
      let back = 0;
      let worstPlane = 0;
      let misoriented = 0;
      let bothSides = 0;
      const tagFront = cutTag(cut.id, 0);
      const tagBack = cutTag(cut.id, 1);
      for (const p of input.parts) {
        const g = p.geometry;
        const { areas, normals } = faceNormalsAndAreas(g.mesh);
        let hasFront = false;
        let hasBack = false;
        for (let t = 0; t < g.cut.length; t++) {
          const tag = g.cut[t];
          if (tag !== tagFront && tag !== tagBack) continue;
          const side = tagSide(tag);
          if (side === 0) {
            front += areas[t];
            hasFront = true;
          } else {
            back += areas[t];
            hasBack = true;
          }
          const c = normals[t * 3] * cut.frame.normal[0] + normals[t * 3 + 1] * cut.frame.normal[1] + normals[t * 3 + 2] * cut.frame.normal[2];
          if (cut.kind === "plane") {
            // A tampa da frente olha para o verso (−normal) e vice-versa. Em triângulos-agulha o
            // arredondamento dos vértices (tol.length) já inclina a normal: o desvio aceito é o que a
            // menor altura do triângulo explica, nunca mais que 90° (uma face virada sempre falha).
            const h = (2 * areas[t]) / Math.max(longestEdge(g.mesh, t), 1e-12);
            const allowed = Math.max(Math.acos(0.999), Math.atan((2 * tol.length) / Math.max(h, 1e-12)));
            if ((side === 0 ? -c : c) < Math.cos(allowed)) misoriented++;
            for (let k = 0; k < 3; k++) {
              const v = g.mesh.indices[t * 3 + k] * 3;
              const l = toLocal(cut.frame, [g.mesh.positions[v], g.mesh.positions[v + 1], g.mesh.positions[v + 2]]);
              worstPlane = Math.max(worstPlane, Math.abs(l[2]));
            }
          }
        }
        if (hasFront && hasBack) bothSides++;
      }
      list.add("tampa-gerada", "Superfície de corte gerada dos dois lados", front > 0 && back > 0, `frente ${fmt(front, 2)} mm², verso ${fmt(back, 2)} mm²`, subject);
      const mismatch = Math.abs(front - back) / Math.max(front, back, 1e-12);
      list.add("tampa-casada", "As duas faces do corte se encaixam (mesma área)", mismatch <= tol.relative * 10, `diferença relativa ${fmt(mismatch)}`, subject);
      list.add("lados-independentes", "Cada lado do corte é uma peça independente", bothSides === 0, `${bothSides} peça(s) com os dois lados`, subject);
      if (cut.kind === "plane") {
        list.add("tampa-plana", "Face de corte plana, sobre o plano do corte", worstPlane <= tol.length, `afastamento máximo ${fmt(worstPlane, 6)} mm`, subject);
        list.add("tampa-orientada", "Faces de corte voltadas para fora da peça", misoriented === 0, `${misoriented} triângulo(s) fora da direção`, subject);
      }
      // Abas: lâminas mais finas que a parede mínima e largas o bastante para não serem uma borda.
      for (const p of input.parts) {
        for (const side of [0, 1] as const) {
          const tag = cutTag(cut.id, side);
          if (!p.geometry.cut.includes(tag)) continue;
          const flap = capFlap(p.geometry, tag, cut.frame, side, tol.minWall);
          list.add(
            "sem-aba",
            "Sem abas finas junto ao corte",
            flap.width < tol.flapWidth,
            `região com menos de ${tol.minWall} mm: ${fmt(flap.width, 2)} mm de largura (limite ${tol.flapWidth}); espessura mínima ${Number.isFinite(flap.minThickness) ? fmt(flap.minThickness, 2) : "-"} mm`,
            `${p.name}, ${subject}`,
            tol.choiceSeverity,
          );
        }
      }
    }
    return list.report();
  } finally {
    arena.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// Encaixes
// ---------------------------------------------------------------------------------------------

export interface ConnectorVerifyInput {
  /** Modelo (ou peça) antes da divisão, para comparar a montagem. */
  original: PartGeometry;
  /** Peças cortadas, antes dos encaixes. */
  before: { id: string; name: string; geometry: PartGeometry }[];
  /** As mesmas peças com pinos e furos aplicados. */
  after: Map<string, PartGeometry>;
  extras: { name: string; geometry: PartGeometry; interfaceId: string }[];
  interfaces: Interface[];
  plans: ConnectorPlan[];
  /** Parede mínima pedida entre o encaixe e a superfície externa (mm). */
  edgeMargin: number;
}

/** Fundo mínimo esperado sob um furo e folga de profundidade (os mesmos valores do planejamento). */
const FLOOR = 1.0;
const DEPTH_GAP = 0.4;

// Direções "tortas" para o teste de ponto dentro do sólido não passar por arestas.
const PROBE_DIRS: Vec3[] = [
  [0.5773, 0.5774, 0.5775],
  [-0.6123, 0.2117, 0.7616],
  [0.1371, -0.8492, 0.5099],
];

/** Ponto dentro do sólido: paridade dos cruzamentos de raios, voto em 3 direções. */
function insideSolid(bvh: MeshBVH, point: Vec3): boolean {
  const ray = new Ray();
  let votes = 0;
  for (const d of PROBE_DIRS) {
    ray.origin.set(point[0], point[1], point[2]);
    ray.direction.set(d[0], d[1], d[2]);
    const hits = bvh.raycast(ray, DoubleSide).filter((h) => h.distance > 1e-9);
    if (hits.length % 2 === 1) votes++;
  }
  return votes >= 2;
}

interface ConnectorSurface {
  faces: number[];
  area: number;
  /** Centro (área ponderada) das faces no plano do corte. */
  center: Vec2;
  /** Vértices (índices) e a profundidade de cada um no sentido da peça fêmea. */
  vertices: Map<number, number>;
  deepest: number;
}

/**
 * Faces de encaixe de uma peça em volta de um ponto do corte, entre as profundidades `from` e `to`
 * (medidas no sentido `sign` da normal do corte). Faces de outros encaixes ficam de fora pelo raio.
 */
function connectorSurface(g: PartGeometry, frame: PlaneFrame, pt: Vec2, radius: number, sign: 1 | -1, from: number, to: number): ConnectorSurface {
  const { areas } = faceNormalsAndAreas(g.mesh);
  const p = g.mesh.positions;
  const out: ConnectorSurface = { faces: [], area: 0, center: [0, 0], vertices: new Map(), deepest: -Infinity };
  let sx = 0;
  let sy = 0;
  for (let t = 0; t < g.cut.length; t++) {
    if (g.cut[t] !== CONNECTOR_TAG) continue;
    const loc = [0, 1, 2].map((k) => {
      const v = g.mesh.indices[t * 3 + k] * 3;
      return toLocal(frame, [p[v], p[v + 1], p[v + 2]]);
    });
    const cx = (loc[0][0] + loc[1][0] + loc[2][0]) / 3;
    const cy = (loc[0][1] + loc[1][1] + loc[2][1]) / 3;
    const cz = (sign * (loc[0][2] + loc[1][2] + loc[2][2])) / 3;
    if (Math.hypot(cx - pt[0], cy - pt[1]) > radius || cz < from || cz > to) continue;
    out.faces.push(t);
    out.area += areas[t];
    sx += cx * areas[t];
    sy += cy * areas[t];
    for (let k = 0; k < 3; k++) {
      const depth = sign * loc[k][2];
      out.vertices.set(g.mesh.indices[t * 3 + k], depth);
      out.deepest = Math.max(out.deepest, depth);
    }
  }
  out.center = out.area > 0 ? [sx / out.area, sy / out.area] : [Number.NaN, Number.NaN];
  return out;
}

/** Espessura de material atrás das faces escolhidas (raio para dentro do material). */
function wallBehind(g: PartGeometry, faces: number[]): number[] {
  const bvh = buildBVH(g.mesh);
  const { normals, areas } = faceNormalsAndAreas(g.mesh);
  const centroids = faceCentroids(g.mesh);
  const ray = new Ray();
  const out: number[] = [];
  for (const t of faces) {
    if (areas[t] <= 1e-9) continue;
    ray.direction.set(-normals[t * 3], -normals[t * 3 + 1], -normals[t * 3 + 2]);
    ray.origin.set(centroids[t * 3], centroids[t * 3 + 1], centroids[t * 3 + 2]).addScaledVector(ray.direction, 1e-4);
    const hit = bvh.raycastFirst(ray, DoubleSide);
    if (hit) out.push(hit.distance);
  }
  bvh.geometry.dispose();
  return out;
}

/** Menor distância dos vértices escolhidos de `from` até a superfície de `to`. */
function gapTo(toBvh: MeshBVH, from: PartGeometry, vertices: Iterable<number>): number {
  const q = new Vector3();
  const hit = { point: new Vector3(), distance: 0, faceIndex: 0 };
  let gap = Infinity;
  for (const v of vertices) {
    q.set(from.mesh.positions[v * 3], from.mesh.positions[v * 3 + 1], from.mesh.positions[v * 3 + 2]);
    const r = toBvh.closestPointToPoint(q, hit);
    if (r) gap = Math.min(gap, r.distance);
  }
  return gap;
}

export function verifyConnectors(w: Wasm, input: ConnectorVerifyInput, over?: Partial<VerifyTolerances>): VerifyReport {
  const list = new Checklist();
  const reg = new RunRegistry(w);
  const arena = new Arena();
  const bvhs = new Map<PartGeometry, MeshBVH>();
  const bvhOf = (g: PartGeometry) => {
    let b = bvhs.get(g);
    if (!b) bvhs.set(g, (b = buildBVH(g.mesh)));
    return b;
  };
  try {
    const original = arena.track(reg.fromGeometry(input.original));
    const tol = tolerancesFor(input.original.mesh, original.volume(), original.surfaceArea(), over);
    const after = new Map<string, Manifold>();
    const names = new Map(input.before.map((p) => [p.id, p.name]));
    for (const p of input.before) {
      const g = input.after.get(p.id);
      if (!g) continue;
      const s = partChecks(list, reg, arena, p.name, g, tol, false, (t) => g.cut[t] === CONNECTOR_TAG);
      if (s) after.set(p.id, s);
    }
    const extras = input.extras.map((e) => {
      const s = partChecks(list, reg, arena, e.name, e.geometry, { ...tol, minPartVolume: 0 }, false, () => true);
      return { ...e, solid: s };
    });

    // Nenhuma peça (nem cavilha) invade outra depois dos encaixes.
    const all: { name: string; solid: Manifold }[] = [
      ...[...after].map(([id, solid]) => ({ name: names.get(id) ?? id, solid })),
      ...extras.flatMap((e) => (e.solid ? [{ name: e.name, solid: e.solid }] : [])),
    ];
    let worst = 0;
    let pair = "";
    for (let i = 0; i < all.length; i++)
      for (let j = i + 1; j < all.length; j++) {
        const v = Math.abs(arena.track(all[i].solid.intersect(all[j].solid)).volume());
        if (v > worst) {
          worst = v;
          pair = `${all[i].name} × ${all[j].name}`;
        }
      }
    list.add("sem-colisao", "Sem interseções entre as peças montadas", worst <= 0.01, `maior interseção ${fmt(worst)} mm³${pair ? ` (${pair})` : ""}`);

    // Montagem: nada sai da forma original e a superfície externa não muda (nenhum furo vaza).
    const union = arena.track(w.Manifold.union(all.map((a) => a.solid)));
    const protruding = Math.abs(arena.track(union.subtract(original)).volume());
    list.add("sem-protrusao", "Nada sai da superfície externa do modelo", protruding <= 0.01, `${fmt(protruding)} mm³ fora do modelo`);
    const bvh = buildBVH(input.original.mesh);
    let worstDev = 0;
    let keptArea = 0;
    let beforeArea = 0;
    for (const p of input.before) {
      const g = input.after.get(p.id);
      if (!g) continue;
      const external = (gg: PartGeometry) => (t: number) => gg.cut[t] < 0 && gg.cut[t] !== CONNECTOR_TAG;
      keptArea += areaWhere(faceNormalsAndAreas(g.mesh).areas, external(g));
      beforeArea += areaWhere(faceNormalsAndAreas(p.geometry.mesh).areas, external(p.geometry));
      worstDev = Math.max(worstDev, maxDistanceToSurface(bvh, g.mesh, external(g)));
    }
    bvh.geometry.dispose();
    const dArea = Math.abs(keptArea - beforeArea);
    list.add(
      "externo-intacto",
      "Encaixes não tocam a superfície externa (nenhum furo vaza)",
      dArea <= Math.max(beforeArea * 1e-7, 1e-4) && worstDev <= tol.length,
      `área externa ${fmt(keptArea, 4)} × ${fmt(beforeArea, 4)} mm² (diferença ${fmt(dArea)}), desvio ${fmt(worstDev, 6)} mm`,
    );

    for (const plan of input.plans) {
      if (!plan.points.length || plan.kind === "none") continue;
      const iface = input.interfaces.find((i) => i.id === plan.interfaceId);
      if (!iface) continue;
      const ga = input.after.get(iface.front);
      const gb = input.after.get(iface.back);
      if (!ga || !gb) continue;
      const subject = `${names.get(iface.front) ?? iface.front} ↔ ${names.get(iface.back) ?? iface.back}`;
      const r = plan.size / 2 + plan.clearance;
      const isFixed = plan.kind !== "dowel" && plan.kind !== "magnet";
      const span = Math.max(plan.length, ...(plan.dowelDepths ?? [0])) + DEPTH_GAP + 1 + plan.deviation;
      plan.points.forEach((pt, k) => {
        const at = `${subject}, encaixe ${k + 1}`;
        if (isFixed) {
          // O lado da frente fica para onde a normal aponta; o pino vai da peça macho para a fêmea.
          const towardFemale: 1 | -1 = plan.maleSide === "front" ? -1 : 1;
          const male = plan.maleSide === "front" ? ga : gb;
          const female = plan.maleSide === "front" ? gb : ga;
          const pin = connectorSurface(male, iface.frame, pt, r + 0.3, towardFemale, 0.02, span);
          const hole = connectorSurface(female, iface.frame, pt, r + 0.3, towardFemale, -0.02, span);
          list.add("macho-femea", "Pino macho numa peça e cavidade fêmea na outra", pin.area > 0 && hole.area > 0, `pino ${fmt(pin.area, 2)} mm², cavidade ${fmt(hole.area, 2)} mm² de superfície`, at);
          if (!pin.area || !hole.area) return;
          const off = Math.hypot(pin.center[0] - hole.center[0], pin.center[1] - hole.center[1]);
          const offPlan = Math.hypot(pin.center[0] - pt[0], pin.center[1] - pt[1]);
          list.add("alinhado", "Pino e cavidade alinhados pela mesma referência", off <= 0.01 && offPlan <= 0.01, `eixo do pino a ${fmt(off)} mm do eixo da cavidade e a ${fmt(offPlan)} mm do ponto planejado`, at);
          // O pino não pode ter ponto dentro do material da fêmea, e o encaixe precisa assentar.
          const fBvh = bvhOf(female);
          let inside = 0;
          for (const v of pin.vertices.keys()) {
            const q: Vec3 = [male.mesh.positions[v * 3], male.mesh.positions[v * 3 + 1], male.mesh.positions[v * 3 + 2]];
            if (insideSolid(fBvh, q)) inside++;
          }
          list.add("pino-entra", "O pino entra inteiro na cavidade correspondente", inside === 0, `${inside} de ${pin.vertices.size} vértice(s) do pino dentro do material da fêmea`, at);
          const seat = hole.deepest - pin.deepest;
          list.add(
            "assenta",
            "As peças fecham na posição original (o pino não bate no fundo)",
            seat >= DEPTH_GAP * 0.5,
            `folga no fundo ${fmt(seat, 3)} mm (pino ${fmt(pin.deepest, 2)} mm, cavidade ${fmt(hole.deepest, 2)} mm)`,
            at,
          );
          const lateral = [...pin.vertices].filter(([, d]) => d > 0.05).map(([v]) => v);
          const gap = gapTo(fBvh, male, lateral);
          list.add(
            "folga",
            "Folga entre macho e fêmea igual à configurada",
            Number.isFinite(gap) && Math.abs(gap - plan.clearance) <= Math.max(0.01, plan.clearance * 0.05),
            `folga medida ${Number.isFinite(gap) ? fmt(gap, 3) : "-"} mm, configurada ${plan.clearance} mm`,
            at,
          );
          // A raiz do pino (0,8 mm + desvio da tampa) fica embutida na peça macho: nenhuma face do
          // pino aparece do lado dela. A janela para na raiz para não pegar outro pino da mesma peça.
          const root = connectorSurface(male, iface.frame, pt, r + 0.3, towardFemale, -(0.8 + plan.deviation + 0.3), -0.05);
          list.add("raiz-embutida", "Raiz do pino embutida na peça macho", root.area === 0, `${fmt(root.area, 3)} mm² do pino aparecendo do lado da peça macho`, at);
          const walls = wallBehind(female, hole.faces);
          const thinnest = walls.length ? Math.min(...walls) : Number.NaN;
          const need = Math.min(FLOOR, input.edgeMargin) * 0.95;
          list.add(
            "parede-encaixe",
            "Espessura suficiente em volta do encaixe",
            walls.length > 0 && thinnest >= need,
            `parede mais fina ${Number.isFinite(thinnest) ? fmt(thinnest, 2) : "-"} mm (mín. ${fmt(need, 2)})`,
            at,
          );
          list.add("pino-imprimivel", "Pino com diâmetro e comprimento imprimíveis em FDM", plan.size >= 2 && plan.length >= 2, `${plan.size} mm × ${plan.length} mm (mín. 2 × 2)`, at);
          return;
        }
        // Cavilha e ímã: alojamentos nos dois lados, alinhados entre si.
        const pf = connectorSurface(ga, iface.frame, pt, r + 0.3, 1, -0.02, span);
        const pb = connectorSurface(gb, iface.frame, pt, r + 0.3, -1, -0.02, span);
        list.add("alojamentos", "Alojamento dos dois lados do corte", pf.area > 0 && pb.area > 0, `frente ${fmt(pf.area, 2)} mm², verso ${fmt(pb.area, 2)} mm² de superfície`, at);
        if (!pf.area || !pb.area) return;
        const off = Math.hypot(pf.center[0] - pb.center[0], pf.center[1] - pb.center[1]);
        list.add("alinhado", "Alojamentos alinhados pela mesma referência", off <= 0.01, `desalinhamento ${fmt(off)} mm`, at);
        for (const [pocket, g] of [
          [pf, ga],
          [pb, gb],
        ] as const) {
          const walls = wallBehind(g, pocket.faces);
          const thinnest = walls.length ? Math.min(...walls) : Number.NaN;
          const need = Math.min(FLOOR, input.edgeMargin) * 0.95;
          list.add("parede-encaixe", "Espessura suficiente em volta do encaixe", walls.length > 0 && thinnest >= need, `parede mais fina ${Number.isFinite(thinnest) ? fmt(thinnest, 2) : "-"} mm (mín. ${fmt(need, 2)})`, `${at}, ${names.get(g === ga ? iface.front : iface.back)}`);
        }
        if (plan.kind === "magnet") {
          const need = plan.length + 0.2 - 0.01;
          list.add("profundidade-ima", "Alojamento comporta o ímã dos dois lados", pf.deepest >= need && pb.deepest >= need, `profundidade ${fmt(pf.deepest, 2)} e ${fmt(pb.deepest, 2)} mm para ímã de ${plan.length} mm`, at);
          return;
        }
        const dowel = extras.find((e) => {
          if (e.interfaceId !== iface.id) return false;
          const b = computeBounds(e.geometry.mesh.positions);
          const c = toLocal(iface.frame, [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2]);
          return Math.hypot(c[0] - pt[0], c[1] - pt[1]) <= r;
        });
        if (!dowel) {
          list.add("pino-entra", "A cavilha entra inteira nos dois alojamentos", false, "cavilha não encontrada", at);
          return;
        }
        let inside = 0;
        const dp = dowel.geometry.mesh.positions;
        const nv = dp.length / 3;
        for (let v = 0; v < nv; v++) {
          const q: Vec3 = [dp[v * 3], dp[v * 3 + 1], dp[v * 3 + 2]];
          if (insideSolid(bvhOf(ga), q) || insideSolid(bvhOf(gb), q)) inside++;
        }
        list.add("pino-entra", "A cavilha entra inteira nos dois alojamentos", inside === 0, `${inside} de ${nv} vértice(s) da cavilha dentro do material`, at);
        const gap = Math.min(gapTo(bvhOf(ga), dowel.geometry, Array.from({ length: nv }, (_, i) => i)), gapTo(bvhOf(gb), dowel.geometry, Array.from({ length: nv }, (_, i) => i)));
        list.add(
          "folga",
          "Folga entre cavilha e alojamento igual à configurada",
          Number.isFinite(gap) && Math.abs(gap - plan.clearance) <= Math.max(0.01, plan.clearance * 0.05),
          `folga medida ${Number.isFinite(gap) ? fmt(gap, 3) : "-"} mm, configurada ${plan.clearance} mm`,
          at,
        );
      });
    }
    return list.report();
  } finally {
    for (const b of bvhs.values()) b.geometry.dispose();
    arena.dispose();
  }
}

/** Resumo legível: uma linha por critério que falhou (ou "tudo certo"). */
export function describeReport(r: VerifyReport): string[] {
  const bad = r.checks.filter((c) => !c.ok);
  if (!bad.length) return [`${r.checks.length} verificações, todas aprovadas.`];
  return bad.map((c) => `${c.severity === "erro" ? "ERRO" : "aviso"} ${c.label}${c.subject ? ` [${c.subject}]` : ""}: ${c.detail}`);
}

