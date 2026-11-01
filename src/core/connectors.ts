import type { CrossSection, Manifold } from "manifold-3d";
import { Arena, RunRegistry, type Wasm } from "./manifoldBridge";
import { type Mat4, type PlaneFrame, type Vec2, type Vec3, clamp, frameToWorldMatrix, multiply, toWorld, translation } from "./math";
import { type PartGeometry, cutTag } from "./part";
import type { Interface, PartRef } from "./split";

export type ConnectorKind = "none" | "cylinder" | "square" | "hex" | "dshape" | "dowel" | "magnet";
export type MaterialKind = "pla" | "petg" | "abs" | "tpu" | "resina";
export type FitKind = "justo" | "normal" | "folgado";
export type MaleSide = "front" | "back";

export const connectorKindNames: Record<ConnectorKind, string> = {
  none: "Sem encaixe",
  cylinder: "Pino cilíndrico",
  square: "Pino quadrado",
  hex: "Pino sextavado",
  dshape: "Pino em D (não gira)",
  dowel: "Pino avulso (cavilha)",
  magnet: "Alojamento para ímã",
};

export const materialNames: Record<MaterialKind, string> = {
  pla: "PLA",
  petg: "PETG",
  abs: "ABS / ASA",
  tpu: "TPU (flexível)",
  resina: "Resina (SLA/MSLA)",
};

export interface ConnectorSettings {
  kind: ConnectorKind;
  /** Diâmetro ou largura do pino em mm (null = automático pela seção do corte). */
  size: number | null;
  /** Comprimento do pino (ou espessura do ímã) em mm (null = automático). */
  length: number | null;
  /** Pinos por interface. */
  count: number;
  /** Folga radial em mm (null = tabela por material e ajuste). */
  clearance: number | null;
  material: MaterialKind;
  fit: FitKind;
  chamfer: boolean;
  maleSide: "auto" | MaleSide;
  /** Parede mínima entre o encaixe e a superfície externa (mm). */
  edgeMargin: number;
}

export const defaultConnectorSettings: ConnectorSettings = {
  kind: "cylinder",
  size: null,
  length: null,
  count: 1,
  clearance: null,
  material: "pla",
  fit: "normal",
  chamfer: true,
  maleSide: "auto",
  edgeMargin: 1.6,
};

/** Folgas radiais de referência (mm). São pontos de partida: imprima um teste de encaixe. */
const clearanceTable: Record<MaterialKind, Record<FitKind, number>> = {
  pla: { justo: 0.1, normal: 0.15, folgado: 0.25 },
  petg: { justo: 0.15, normal: 0.2, folgado: 0.3 },
  abs: { justo: 0.15, normal: 0.2, folgado: 0.3 },
  tpu: { justo: 0.2, normal: 0.3, folgado: 0.4 },
  resina: { justo: 0.05, normal: 0.1, folgado: 0.15 },
};

export function autoClearance(s: Pick<ConnectorSettings, "material" | "fit" | "kind">, size: number): number {
  let c = clearanceTable[s.material][s.fit];
  // Furos pequenos em FDM saem menores que o modelo: compensa um pouco.
  if (s.material !== "resina" && size < 6) c += 0.05;
  if (s.kind === "magnet") c = Math.min(c, 0.15);
  return Math.round(c * 100) / 100;
}

/** Fundo mínimo deixado abaixo de um furo e folga extra de profundidade (mm). */
const FLOOR = 1.0;
const DEPTH_GAP = 0.4;

export interface ConnectorPlan {
  interfaceId: string;
  kind: ConnectorKind;
  frame: PlaneFrame;
  points: Vec2[];
  size: number;
  /** Pino fixo: comprimento que entra na peça fêmea. Cavilha: [frente, verso]. Ímã: espessura. */
  length: number;
  dowelDepths?: [number, number];
  clearance: number;
  maleSide: MaleSide;
  chamfer: boolean;
  deviation: number;
  warnings: string[];
}

function regionFromPolygons(w: Wasm, polygons: Vec2[][]): CrossSection {
  return new w.CrossSection(polygons, "Positive");
}

/** Raio do maior círculo inscrito (por bissecção de offsets negativos). */
function inradius(cs: CrossSection): number {
  let lo = 0;
  let hi = Math.sqrt(Math.max(cs.area(), 1e-9));
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    const inset = cs.offset(-mid, "Round");
    const empty = inset.isEmpty();
    inset.delete();
    if (empty) hi = mid;
    else lo = mid;
  }
  return lo;
}

function pointInPolygons(p: Vec2, polys: Vec2[][]): boolean {
  let inside = false;
  for (const poly of polys)
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i];
      const b = poly[j];
      if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0])
        inside = !inside;
    }
  return inside;
}

function distanceToPolygons(p: Vec2, polys: Vec2[][]): number {
  let best = Infinity;
  for (const poly of polys)
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[j];
      const b = poly[i];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const len2 = dx * dx + dy * dy || 1e-12;
      const t = clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2, 0, 1);
      best = Math.min(best, Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy));
    }
  return best;
}

/** Escolhe posições bem espalhadas dentro da região permitida (amostragem do ponto mais distante). */
export function placePoints(region: Vec2[][], allowed: Vec2[][], count: number, minSpacing: number): Vec2[] {
  if (!allowed.length || count <= 0) return [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const poly of allowed)
    for (const [x, y] of poly) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  const span = Math.max(maxX - minX, maxY - minY);
  const step = Math.max(span / 40, 0.05);
  const candidates: { p: Vec2; depth: number }[] = [];
  for (let x = minX; x <= maxX + 1e-9; x += step)
    for (let y = minY; y <= maxY + 1e-9; y += step) {
      const p: Vec2 = [x, y];
      if (pointInPolygons(p, allowed)) candidates.push({ p, depth: distanceToPolygons(p, region) });
    }
  if (!candidates.length) {
    // Região permitida muito estreita para a grade: usa o primeiro vértice dela.
    const v = allowed[0][0];
    return [[v[0], v[1]]];
  }
  const chosen: Vec2[] = [];
  candidates.sort((a, b) => b.depth - a.depth);
  chosen.push(candidates[0].p);
  while (chosen.length < count) {
    let best: { p: Vec2; score: number } | null = null;
    for (const c of candidates) {
      const d = Math.min(...chosen.map((q) => Math.hypot(q[0] - c.p[0], q[1] - c.p[1])));
      if (d < minSpacing) continue;
      const score = d + c.depth * 0.25;
      if (!best || score > best.score) best = { p: c.p, score };
    }
    if (!best) break;
    chosen.push(best.p);
  }
  return chosen;
}

/** Profundidade disponível dentro de um sólido a partir do plano, seguindo `dir`. */
function depthAlong(solid: Manifold, origin: Vec3, dir: Vec3, maxLength: number): number {
  const start: Vec3 = [origin[0] - dir[0] * 0.01, origin[1] - dir[1] * 0.01, origin[2] - dir[2] * 0.01];
  const end: Vec3 = [origin[0] + dir[0] * maxLength, origin[1] + dir[1] * maxLength, origin[2] + dir[2] * maxLength];
  // `distance` do Manifold é a fração do segmento; a posição do impacto dá a medida em mm.
  const hits = solid.rayCast(start, end);
  for (const h of hits) {
    const exiting = h.normal[0] * dir[0] + h.normal[1] * dir[1] + h.normal[2] * dir[2] > 0;
    if (exiting)
      return Math.max(
        0,
        (h.position[0] - origin[0]) * dir[0] + (h.position[1] - origin[1]) * dir[1] + (h.position[2] - origin[2]) * dir[2],
      );
  }
  return 0;
}

export interface PlanInput {
  iface: Interface;
  front: PartGeometry;
  back: PartGeometry;
  settings: ConnectorSettings;
  /** Posições definidas pelo usuário no editor (substituem o posicionamento automático). */
  manualPoints?: Vec2[];
  /** Lado que deve receber o furo (a peça vai apoiada nesta face de corte na mesa). */
  femaleHint?: MaleSide;
}

/**
 * Planeja os encaixes de uma interface e descarta os que sairiam do volume das duas peças (por
 * exemplo, perto de uma parede inclinada ou quando a tampa foi dividida por outro corte e o pino
 * invadiria uma terceira peça).
 */
export function planConnectors(w: Wasm, input: PlanInput): ConnectorPlan {
  const plan = planConnectorsRaw(w, input);
  if (!plan.points.length) return plan;
  const reg = new RunRegistry(w);
  const arena = new Arena();
  try {
    const front = arena.track(reg.fromGeometry(input.front));
    const back = arena.track(reg.fromGeometry(input.back));
    const keep: Vec2[] = [];
    for (const p of plan.points) {
      const into: ConnectorSolids = { add: new Map(), subtract: new Map(), extras: [] };
      buildConnectorSolids(w, reg, input.iface, { ...plan, points: [p] }, into);
      const solids = [...[...into.add.values()].flat(), ...[...into.subtract.values()].flat(), ...into.extras.map((e) => e.solid)];
      arena.trackAll(solids);
      let total = 0;
      let escaping = 0;
      for (const s of solids) {
        const v = Math.abs(s.volume());
        const inside = Math.abs(arena.track(s.intersect(front)).volume()) + Math.abs(arena.track(s.intersect(back)).volume());
        total += v;
        escaping += Math.max(0, v - inside);
      }
      if (escaping <= Math.max(total * 0.02, 0.05)) keep.push(p);
    }
    const dropped = plan.points.length - keep.length;
    if (dropped && !input.manualPoints?.length)
      plan.warnings.push(`${dropped} encaixe(s) removido(s): atravessariam a parede ou outra peça.`);
    else if (dropped) plan.warnings.push(`${dropped} encaixe(s) posicionado(s) à mão saem das peças e foram ignorados.`);
    plan.points = keep;
    return plan;
  } finally {
    arena.dispose();
  }
}

/** Ímãs de neodímio em disco comuns no mercado (diâmetro × espessura, mm), do padrão ao menor. */
const MAGNET_SIZES: [number, number][] = [
  [6, 3],
  [5, 2],
  [4, 2],
  [3, 2],
  [3, 1],
  [2, 1],
];

/**
 * Com o diâmetro do ímã automático, usa o maior ímã comercial que cabe no corte (seção com parede e
 * espessura das duas peças). Antes o ímã era sempre de 6 mm e, em cortes finos (um tornozelo, um
 * pulso), a face ficava lisa sem alojamento nenhum.
 */
function planConnectorsRaw(w: Wasm, input: PlanInput): ConnectorPlan {
  const { settings } = input;
  if (settings.kind !== "magnet" || settings.size !== null || settings.count <= 0) return planOne(w, input);
  let last: ConnectorPlan | null = null;
  for (const [d, t] of MAGNET_SIZES) {
    const plan = planOne(w, { ...input, settings: { ...settings, size: d, length: settings.length ?? t } });
    if (plan.points.length) {
      if (d !== MAGNET_SIZES[0][0]) plan.warnings.push(`Ímã reduzido para Ø${d} × ${plan.length} mm para caber neste corte.`);
      return plan;
    }
    last = plan;
  }
  const [dMin, tMin] = MAGNET_SIZES[MAGNET_SIZES.length - 1];
  last!.warnings = [
    `Nenhum ímã de Ø${MAGNET_SIZES[0][0]} × ${MAGNET_SIZES[0][1]} mm a Ø${dMin} × ${tMin} mm cabe neste corte com parede de ${settings.edgeMargin} mm: use pino ou cavilha, ou diminua a parede mínima.`,
  ];
  return last!;
}

function planOne(w: Wasm, input: PlanInput): ConnectorPlan {
  const { iface, settings } = input;
  const plan: ConnectorPlan = {
    interfaceId: iface.id,
    kind: settings.kind,
    frame: iface.frame,
    points: [],
    size: 0,
    length: 0,
    clearance: 0,
    maleSide: "front",
    chamfer: settings.chamfer,
    deviation: iface.deviation,
    warnings: [],
  };
  if (settings.kind === "none" || settings.count <= 0) return plan;
  const reg = new RunRegistry(w);
  const arena = new Arena();
  try {
    const region = arena.track(regionFromPolygons(w, iface.polygons));
    const islands = arena.trackAll(region.decompose()).sort((a, b) => b.area() - a.area());
    const radii = islands.map((i) => inradius(i));
    const margin = settings.edgeMargin;
    const isMagnet = settings.kind === "magnet";
    let size = settings.size ?? (isMagnet ? 6 : clamp(Math.round(radii[0] * 0.8 * 2) / 2, 2, 12));
    // Maior encaixe que a região mais larga do corte comporta, com a parede mínima em volta.
    const widest = Math.max(...radii);
    const largest = Math.floor((widest - margin) * 4) / 2;
    if (settings.size === null && !isMagnet && size / 2 + margin > radii[0]) size = Math.floor((radii[0] - margin) * 4) / 2;
    // Um tamanho escolhido à mão vale para todos os cortes (padrão) ou foi pensado para outro corte:
    // onde ele não cabe, o pino é reduzido em vez de sumir (antes, aumentar o pino da cintura tirava
    // os pinos dos tornozelos sem aviso visível). Ímã não: o tamanho é o do ímã que a pessoa comprou.
    if (settings.size !== null && !isMagnet && size / 2 + margin * 0.75 > widest && largest >= 1.5 && largest < size) {
      plan.warnings.push(`O encaixe de ${size} mm não cabe neste corte: reduzido para ${largest} mm.`);
      size = largest;
    }
    if (isMagnet && settings.size !== null && size / 2 + margin * 0.75 > widest) {
      plan.warnings.push(
        `O ímã de Ø${size} mm escolhido não cabe neste corte com parede de ${margin} mm: deixe o diâmetro em automático (usa o maior ímã que cabe) ou use pino.`,
      );
      return plan;
    }
    if (size < 1.5) {
      plan.warnings.push("Seção do corte fina demais para um encaixe: nenhum pino foi criado.");
      return plan;
    }
    const r = size / 2;
    const fitting = islands.map((isl, i) => ({ isl, i })).filter(({ i }) => radii[i] >= r + margin * 0.75);
    if (!fitting.length) {
      plan.warnings.push(`Nenhuma região do corte comporta um encaixe de ${size} mm com parede de ${margin} mm.`);
      return plan;
    }
    // Distribui a quantidade entre as ilhas do corte (ex.: duas pernas no mesmo plano).
    const quota = new Map<number, number>();
    if (input.manualPoints?.length) plan.points = input.manualPoints.map((p) => [p[0], p[1]] as Vec2);
    else {
      const count = Math.max(settings.count, 1);
      fitting.slice(0, count).forEach(({ i }) => quota.set(i, 1));
      let remaining = count - quota.size;
      const totalArea = fitting.reduce((s, f) => s + f.isl.area(), 0);
      for (const { isl, i } of fitting) {
        if (remaining <= 0) break;
        const extra = Math.min(remaining, Math.round((isl.area() / totalArea) * (count - quota.size)));
        quota.set(i, (quota.get(i) ?? 0) + extra);
        remaining -= extra;
      }
      if (remaining > 0) quota.set(fitting[0].i, (quota.get(fitting[0].i) ?? 0) + remaining);
      for (const { isl, i } of fitting) {
        const k = quota.get(i) ?? 0;
        if (!k) continue;
        const inset = arena.track(isl.offset(-(r + margin * 0.75), "Round"));
        if (inset.isEmpty()) continue;
        plan.points.push(...placePoints(isl.toPolygons() as Vec2[][], inset.toPolygons() as Vec2[][], k, size + 2.5));
      }
      if (fitting.length < islands.length)
        plan.warnings.push(`${islands.length - fitting.length} região(ões) do corte são estreitas demais e ficaram sem encaixe.`);
    }

    // Mede quanto material existe de cada lado para dimensionar o comprimento.
    const front = arena.track(reg.fromGeometry(input.front));
    const back = arena.track(reg.fromGeometry(input.back));
    const n = iface.frame.normal;
    const neg: Vec3 = [-n[0], -n[1], -n[2]];
    const probe = (solid: Manifold, dir: Vec3) =>
      Math.min(
        ...plan.points.flatMap((p) =>
          [
            [0, 0],
            [r, 0],
            [-r, 0],
            [0, r],
            [0, -r],
          ].map(([dx, dy]) => depthAlong(solid, toWorld(iface.frame, p[0] + dx, p[1] + dy, 0), dir, 500)),
        ),
      );
    const depthFront = plan.points.length ? probe(front, n) : 0;
    const depthBack = plan.points.length ? probe(back, neg) : 0;
    plan.size = size;
    plan.clearance = settings.clearance ?? autoClearance(settings, size);
    const wanted = settings.length ?? (isMagnet ? 3 : clamp(Math.round(size * 1.6 * 2) / 2, 3, 14));

    if (settings.kind === "dowel") {
      const half = wanted / 2;
      const hf = Math.min(half, depthFront - FLOOR - DEPTH_GAP);
      const hb = Math.min(half, depthBack - FLOOR - DEPTH_GAP);
      if (hf < 2 || hb < 2) {
        plan.warnings.push("Material insuficiente de um dos lados para a cavilha: encaixe omitido.");
        plan.points = [];
        return plan;
      }
      if (hf < half || hb < half) plan.warnings.push("Cavilha encurtada para caber na espessura das peças.");
      plan.dowelDepths = [Math.round(hf * 10) / 10, Math.round(hb * 10) / 10];
      plan.length = plan.dowelDepths[0] + plan.dowelDepths[1];
      return plan;
    }
    if (isMagnet) {
      const need = wanted + 0.2 + FLOOR;
      if (depthFront < need || depthBack < need) {
        plan.warnings.push(`O ímã de ${wanted} mm não cabe na espessura das duas peças.`);
        plan.points = [];
        return plan;
      }
      plan.length = wanted;
      return plan;
    }
    // Pino fixo: o furo vai na peça com mais material, de preferência a maior.
    const frontVol = Math.abs(front.volume());
    const backVol = Math.abs(back.volume());
    const maxIn = (female: MaleSide) => (female === "front" ? depthFront : depthBack) - FLOOR - DEPTH_GAP;
    let female: MaleSide;
    if (settings.maleSide === "front") female = "back";
    else if (settings.maleSide === "back") female = "front";
    else if (input.femaleHint && maxIn(input.femaleHint) >= 2.5) female = input.femaleHint;
    else {
      const preferred: MaleSide = backVol >= frontVol ? "back" : "front";
      const other: MaleSide = preferred === "back" ? "front" : "back";
      female = maxIn(preferred) >= Math.min(wanted, maxIn(other)) * 0.7 ? preferred : other;
    }
    plan.maleSide = female === "back" ? "front" : "back";
    const length = Math.min(wanted, maxIn(female));
    if (length < 2) {
      plan.warnings.push("A peça do furo é fina demais para um pino: encaixe omitido.");
      plan.points = [];
      return plan;
    }
    if (length < wanted) plan.warnings.push(`Pino encurtado para ${length.toFixed(1)} mm para não furar a parede.`);
    plan.length = Math.round(length * 10) / 10;
    return plan;
  } finally {
    arena.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// Geometria dos encaixes
// ---------------------------------------------------------------------------------------------

function profile(w: Wasm, kind: ConnectorKind, size: number): CrossSection {
  const { CrossSection } = w;
  const r = size / 2;
  const segs = clamp(Math.round(size * 6), 24, 64);
  switch (kind) {
    case "square":
      return CrossSection.square([size, size], true);
    case "hex":
      return CrossSection.circle(r, 6);
    case "dshape": {
      const c = CrossSection.circle(r, segs);
      const sq = CrossSection.square([size, size * 0.85], true).translate([0, -size * 0.075]);
      const d = c.intersect(sq);
      c.delete();
      sq.delete();
      return d;
    }
    default:
      return CrossSection.circle(r, segs);
  }
}

/** Prisma do perfil de z=0 até `height`, com chanfro opcional nas pontas. */
function prism(w: Wasm, cs: CrossSection, height: number, chamferBottom: number, chamferTop: number): Manifold {
  const arena = new Arena();
  try {
    const pieces: Manifold[] = [];
    const bounds = cs.bounds();
    const half = Math.min(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1]) / 2;
    const k = (c: number) => Math.max(0.2, (half - c) / half);
    let z0 = 0;
    let z1 = height;
    if (chamferBottom > 0) {
      const s = k(chamferBottom);
      const small = arena.track(cs.scale(s));
      pieces.push(arena.track(w.Manifold.extrude(small, chamferBottom, 0, 0, 1 / s)));
      z0 = chamferBottom;
    }
    if (chamferTop > 0) {
      const s = k(chamferTop);
      pieces.push(arena.track(w.Manifold.extrude(cs, chamferTop, 0, 0, s).translate([0, 0, height - chamferTop])));
      z1 = height - chamferTop;
    }
    pieces.push(arena.track(w.Manifold.extrude(cs, z1 - z0).translate([0, 0, z0])));
    return w.Manifold.union(pieces);
  } finally {
    arena.dispose();
  }
}

/** Matriz que leva coordenadas do "espaço do encaixe" (z ao longo da normal do corte) para o mundo. */
function placement(frame: PlaneFrame, p: Vec2, z: number, flip: boolean): Mat4 {
  const world = multiply(frameToWorldMatrix(frame), translation(p[0], p[1], z));
  return flip ? multiply(world, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1]) : world;
}

export interface ConnectorSolids {
  /** Sólidos somados a cada peça (pinos). */
  add: Map<string, Manifold[]>;
  /** Sólidos subtraídos de cada peça (furos). */
  subtract: Map<string, Manifold[]>;
  /** Peças extras (cavilhas). */
  extras: { name: string; solid: Manifold }[];
}

export function buildConnectorSolids(w: Wasm, reg: RunRegistry, iface: Interface, plan: ConnectorPlan, into: ConnectorSolids) {
  if (plan.kind === "none" || !plan.points.length) return;
  const arena = new Arena();
  try {
    const base = arena.track(profile(w, plan.kind, plan.size));
    const hole = arena.track(base.offset(plan.clearance, "Round"));
    const dev = plan.deviation;
    const top = 0.5 + dev;
    const chamfer = plan.chamfer ? Math.min(0.6, plan.size * 0.15) : 0;
    const pushTo = (map: Map<string, Manifold[]>, id: string, m: Manifold) => {
      const list = map.get(id);
      if (list) list.push(m);
      else map.set(id, [m]);
    };
    plan.points.forEach((p, i) => {
      if (plan.kind === "dowel" && plan.dowelDepths) {
        const [hf, hb] = plan.dowelDepths;
        // Furos dos dois lados e uma cavilha solta.
        const hFront = arena.track(prism(w, hole, hf + DEPTH_GAP + top, 0, 0));
        pushTo(into.subtract, iface.front, reg.connector(hFront.transform(placement(iface.frame, p, -top, false))));
        const hBack = arena.track(prism(w, hole, hb + DEPTH_GAP + top, 0, 0));
        pushTo(into.subtract, iface.back, reg.connector(hBack.transform(placement(iface.frame, p, top, true))));
        const pin = arena.track(prism(w, base, hf + hb, chamfer, chamfer));
        into.extras.push({ name: `cavilha_${i + 1}`, solid: reg.connector(pin.transform(placement(iface.frame, p, -hb, false))) });
        return;
      }
      if (plan.kind === "magnet") {
        const depth = plan.length + 0.2;
        const pf = arena.track(prism(w, hole, depth + top, 0, 0));
        pushTo(into.subtract, iface.front, reg.connector(pf.transform(placement(iface.frame, p, -top, false))));
        const pb = arena.track(prism(w, hole, depth + top, 0, 0));
        pushTo(into.subtract, iface.back, reg.connector(pb.transform(placement(iface.frame, p, top, true))));
        return;
      }
      const L = plan.length;
      const embed = 0.8 + dev;
      // No espaço do pino a ponta fica em z=0 e a base em L+embed.
      const pin = arena.track(prism(w, base, L + embed, chamfer, 0));
      const holeSolid = arena.track(prism(w, hole, L + DEPTH_GAP + top, 0, 0));
      if (plan.maleSide === "front") {
        // Pino sai da frente em direção ao verso (−normal).
        pushTo(into.add, iface.front, reg.connector(pin.transform(placement(iface.frame, p, -L, false))));
        pushTo(into.subtract, iface.back, reg.connector(holeSolid.transform(placement(iface.frame, p, -(L + DEPTH_GAP), false))));
      } else {
        pushTo(into.add, iface.back, reg.connector(pin.transform(placement(iface.frame, p, L, true))));
        pushTo(into.subtract, iface.front, reg.connector(holeSolid.transform(placement(iface.frame, p, L + DEPTH_GAP, true))));
      }
    });
  } finally {
    arena.dispose();
  }
}

/**
 * Maior tampa de corte plana da peça: é a face em que ela deve apoiar na mesa de impressão, então
 * convém que ela receba furos e não pinos.
 */
export function bedCapTag(g: PartGeometry): number | null {
  const p = g.mesh.positions;
  const idx = g.mesh.indices;
  const caps = new Map<number, { area: number; n: Vec3 }>();
  for (let t = 0; t < g.cut.length; t++) {
    const tag = g.cut[t];
    if (tag < 0) continue;
    const a = idx[t * 3] * 3;
    const b = idx[t * 3 + 1] * 3;
    const c = idx[t * 3 + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const n: Vec3 = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    let e = caps.get(tag);
    if (!e) caps.set(tag, (e = { area: 0, n: [0, 0, 0] }));
    e.area += Math.hypot(...n) / 2;
    for (let k = 0; k < 3; k++) e.n[k] += n[k] / 2;
  }
  let best: number | null = null;
  let bestArea = 0;
  for (const [tag, e] of caps)
    if (Math.hypot(...e.n) >= e.area * 0.97 && e.area > bestArea) {
      best = tag;
      bestArea = e.area;
    }
  // Um fundo plano que a peça já tem (ex.: a base de uma figura) ganha das tampas de corte, com o
  // mesmo critério usado para orientar a peça na mesa.
  let minZ = Infinity;
  for (let i = 2; i < p.length; i += 3) minZ = Math.min(minZ, p[i]);
  let bottom = 0;
  for (let t = 0; t < g.cut.length; t++) {
    if (g.cut[t] >= 0) continue;
    const a = idx[t * 3] * 3;
    const b = idx[t * 3 + 1] * 3;
    const c = idx[t * 3 + 2] * 3;
    if (p[a + 2] - minZ > 0.3 || p[b + 2] - minZ > 0.3 || p[c + 2] - minZ > 0.3) continue;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nz = ux * vy - uy * vx;
    const len = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, nz);
    if (len > 0 && nz / len < -0.985) bottom += len / 2;
  }
  return bottom >= bestArea * 1.1 ? null : best;
}

/** Dica de lado do furo para cada interface, para que cada peça possa deitar na sua maior face de corte. */
export function femaleHints(items: PlanInput[]): (MaleSide | undefined)[] {
  const cache = new Map<PartGeometry, number | null>();
  const cap = (g: PartGeometry) => {
    if (!cache.has(g)) cache.set(g, bedCapTag(g));
    return cache.get(g)!;
  };
  return items.map(({ iface, front, back }) => {
    const f = cap(front) === cutTag(iface.cutId, 0);
    const b = cap(back) === cutTag(iface.cutId, 1);
    return f && !b ? "front" : b && !f ? "back" : undefined;
  });
}

/**
 * Encaixes de cortes diferentes podem se cruzar dentro da mesma peça (ex.: o furo do ombro e o
 * furo do corte da cintura no tronco). Encurta o mais comprido e, se não bastar, remove o encaixe.
 */
export function resolveConnectorConflicts(w: Wasm, items: PlanInput[], plans: ConnectorPlan[]): ConnectorPlan[] {
  const out = plans.map((p) => ({ ...p, points: p.points.slice(), warnings: p.warnings.slice() }));
  const reg = new RunRegistry(w);
  for (let round = 0; round < 12; round++) {
    const arena = new Arena();
    try {
      // Formas que ocupam cada peça: furos subtraídos e pinos somados.
      const shapes = new Map<string, { plan: number; point: number; solid: Manifold }[]>();
      out.forEach((plan, pi) => {
        plan.points.forEach((p, qi) => {
          const into: ConnectorSolids = { add: new Map(), subtract: new Map(), extras: [] };
          buildConnectorSolids(w, reg, items[pi].iface, { ...plan, points: [p] }, into);
          for (const map of [into.add, into.subtract])
            for (const [part, list] of map)
              for (const solid of arena.trackAll(list)) {
                const l = shapes.get(part);
                const entry = { plan: pi, point: qi, solid };
                if (l) l.push(entry);
                else shapes.set(part, [entry]);
              }
          for (const e of into.extras) arena.track(e.solid);
        });
      });
      let conflict: [number, number] | null = null;
      for (const list of shapes.values()) {
        for (let i = 0; i < list.length && !conflict; i++)
          for (let j = i + 1; j < list.length && !conflict; j++) {
            if (list[i].plan === list[j].plan) continue;
            if (Math.abs(arena.track(list[i].solid.intersect(list[j].solid)).volume()) > 0.01)
              conflict = [list[i].plan, list[j].plan];
          }
        if (conflict) break;
      }
      if (!conflict) return out;
      const [a, b] = conflict;
      const victim = out[a].length >= out[b].length ? a : b;
      const plan = out[victim];
      if (plan.kind !== "dowel" && plan.kind !== "magnet" && plan.length > 3) {
        const next = Math.max(3, Math.round(plan.length * 0.7 * 10) / 10);
        plan.warnings.push(`Encurtado para ${next} mm para não cruzar outro encaixe.`);
        plan.length = next;
      } else {
        plan.warnings.push("Encaixe removido: cruzaria o encaixe de outro corte dentro da peça.");
        plan.points = [];
      }
    } finally {
      arena.dispose();
    }
  }
  return out;
}

export interface ConnectorCheck {
  interfaceId: string;
  /** Volume (mm³) de sobreposição entre as peças montadas; deve ser ~0. */
  collision: number;
  /** Algum furo atravessou a parede da peça. */
  brokeThrough: boolean;
  ok: boolean;
}

export interface AppliedConnectors {
  parts: Map<string, PartGeometry>;
  extras: { name: string; geometry: PartGeometry; interfaceId: string }[];
  checks: ConnectorCheck[];
}

/** Aplica os encaixes planejados: une pinos, subtrai furos e valida o encaixe montado. */
export function applyConnectors(w: Wasm, parts: PartRef[], interfaces: Interface[], plans: ConnectorPlan[]): AppliedConnectors {
  const reg = new RunRegistry(w);
  const arena = new Arena();
  try {
    const solids = new Map<string, Manifold>();
    for (const p of parts) solids.set(p.id, arena.track(reg.fromGeometry(p.geometry)));
    const into: ConnectorSolids = { add: new Map(), subtract: new Map(), extras: [] };
    const extrasByIface: string[] = [];
    for (const plan of plans) {
      const iface = interfaces.find((i) => i.id === plan.interfaceId);
      if (!iface || !solids.has(iface.front) || !solids.has(iface.back)) continue;
      const before = into.extras.length;
      buildConnectorSolids(w, reg, iface, plan, into);
      for (let k = before; k < into.extras.length; k++) extrasByIface.push(iface.id);
    }
    for (const list of [...into.add.values(), ...into.subtract.values()]) arena.trackAll(list);
    for (const e of into.extras) arena.track(e.solid);

    const result = new Map<string, Manifold>();
    for (const [id, solid] of solids) {
      let m = solid;
      const adds = into.add.get(id);
      if (adds?.length) m = arena.track(w.Manifold.union([m, ...adds]));
      const subs = into.subtract.get(id);
      if (subs?.length) m = arena.track(m.subtract(arena.track(w.Manifold.union(subs))));
      result.set(id, m);
    }
    const checks: ConnectorCheck[] = [];
    for (const plan of plans) {
      const iface = interfaces.find((i) => i.id === plan.interfaceId);
      if (!iface || !plan.points.length) continue;
      const f = result.get(iface.front);
      const b = result.get(iface.back);
      if (!f || !b) continue;
      const overlap = arena.track(f.intersect(b));
      const collision = Math.abs(overlap.volume());
      const brokeThrough = [iface.front, iface.back].some((id) => {
        const before = solids.get(id)!;
        const after = result.get(id)!;
        return after.genus() > before.genus();
      });
      checks.push({ interfaceId: iface.id, collision, brokeThrough, ok: collision < 0.05 && !brokeThrough });
    }
    const outParts = new Map<string, PartGeometry>();
    for (const [id, m] of result) outParts.set(id, reg.toGeometry(m));
    return {
      parts: outParts,
      extras: into.extras.map((e, i) => ({ name: e.name, geometry: reg.toGeometry(e.solid), interfaceId: extrasByIface[i] })),
      checks,
    };
  } finally {
    arena.dispose();
  }
}

