import { DoubleSide, Ray } from "three";
import type { MeshBVH } from "three-mesh-bvh";
import { buildBVH } from "./bvh";
import { capOutsideFraction } from "./capcheck";
import { islandLoops, labelIslands } from "./labels";
import { type Vec3, symmetricEigen3 } from "./math";
import { type EdgeTable, type IndexedMesh, faceComponents } from "./mesh";
import { type Triangulator, capLoop } from "./repair";

/**
 * Bolsos sem pintura dentro de uma região pintada.
 *
 * Quem pinta com o pincel cobre o que vê: o lado de fora de uma bota com o cano dobrado em funil fica
 * pintado, mas o lado de dentro do funil (onde a perna entra) costuma ficar sem tinta. A fronteira
 * pintada passa então pela borda do funil, e nenhum corte consegue segui-la por dentro do material:
 * a tampa que fecha essa borda atravessa o vão entre o funil e a perna. O plano que sobrava deixava
 * um pedaço do funil preso na perna.
 *
 * Só contornos assim (a tampa deles passaria pelo ar) contam. Faces sem pintura ligadas a eles que
 * ficam dentro do volume fechado pela região pintada e pelas tampas dos seus contornos (o lado de
 * dentro do funil) são o "bolso" dessa região e passam a ser dela: a fronteira desce pelo funil até
 * onde ele encontra a perna e o corte fecha por dentro do material. Superfícies sem pintura fora
 * desse volume (a pele em volta de um relevo, o resto do corpo) nunca mudam, e um contorno cuja
 * tampa já fica dentro do material (o ombro de um braço) não mexe em nada.
 */

/** Fração da tampa de um contorno no ar a partir da qual a fronteira não fecha por dentro. */
const AIRY_CAP = 0.02;

// Direções "tortas" para o teste de paridade não passar exatamente por arestas ou vértices.
const RAY_DIRS: Vec3[] = [
  [0.5773, 0.5774, 0.5775],
  [-0.6123, 0.2117, 0.7616],
  [0.1371, -0.8492, 0.5099],
];

export interface PocketContext {
  edges: EdgeTable;
  neighbors: Int32Array;
  areas: Float32Array;
  normals: Float32Array;
  centroids: Float32Array;
}

export interface PocketFill {
  labels: Uint16Array;
  /** Área (mm²) acrescentada a cada rótulo. */
  filled: Map<number, number>;
}

/**
 * Superfície fechada da ilha (faces dela + tampas dos contornos), em vértices locais, e quais
 * contornos têm a tampa passando pelo ar (fora do sólido `solid`).
 */
function closedSurface(
  mesh: IndexedMesh,
  faces: ArrayLike<number>,
  loops: { vertices: number[] }[],
  triangulate: Triangulator | null,
  solid: () => MeshBVH,
): { surface: IndexedMesh; airy: boolean[] } | null {
  const remap = new Map<number, number>();
  const positions: number[] = [];
  const local = (v: number) => {
    let i = remap.get(v);
    if (i === undefined) {
      i = positions.length / 3;
      remap.set(v, i);
      positions.push(mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]);
    }
    return i;
  };
  const indices: number[] = [];
  for (let i = 0; i < faces.length; i++) {
    const f = faces[i];
    indices.push(local(mesh.indices[f * 3]), local(mesh.indices[f * 3 + 1]), local(mesh.indices[f * 3 + 2]));
  }
  const airy: boolean[] = [];
  for (const loop of loops) {
    const verts = loop.vertices.map(local);
    const cap = capLoop(verts, positions, triangulate, false);
    if (!cap) return null;
    airy.push(capOutsideFraction(solid(), positions, cap.tris, cap.extraVerts) > AIRY_CAP);
    for (const v of cap.extraVerts) positions.push(v[0], v[1], v[2]);
    indices.push(...cap.tris);
  }
  return { surface: { positions: new Float32Array(positions), indices: new Uint32Array(indices) }, airy };
}

function insideOf(bvh: MeshBVH): (p: Vec3) => boolean {
  const ray = new Ray();
  return (p) => {
    let votes = 0;
    for (const d of RAY_DIRS) {
      ray.origin.set(p[0], p[1], p[2]);
      ray.direction.set(d[0], d[1], d[2]).normalize();
      if (bvh.raycast(ray, DoubleSide).filter((h) => h.distance > 1e-7).length % 2 === 1) votes++;
    }
    return votes >= 2;
  };
}

/**
 * Passa para cada região pintada as faces de `baseLabel` presas dentro dela (ver o comentário do
 * módulo). Só entram faces ligadas a um contorno da região por faces que também estão dentro, e o
 * bolso nunca é maior que a própria região pintada.
 */
export function fillPockets(
  mesh: IndexedMesh,
  labels: Uint16Array,
  ctx: PocketContext,
  baseLabel: number,
  triangulate: Triangulator | null,
): PocketFill {
  // Um bolso preenchido muda o contorno da região (ele desce pelo funil até a perna): a passada
  // seguinte, com a tampa do contorno novo, alcança cantos que a tampa da borda não cobria (a dobra
  // em "V" na frente de um cano virado).
  let cur = labels;
  const filled = new Map<number, number>();
  // A tampa é testada contra a casca da própria região (num arquivo com muitas cascas, só ela).
  const { count, comp } = faceComponents(mesh, ctx.neighbors);
  const bvhs = new Map<number, MeshBVH>();
  const solid = (c: number) => {
    let b = bvhs.get(c);
    if (!b) {
      let k = 0;
      for (let f = 0; f < comp.length; f++) if (comp[f] === c) k++;
      const indices = new Uint32Array(k * 3);
      k = 0;
      for (let f = 0; f < comp.length; f++) if (comp[f] === c) indices.set(mesh.indices.subarray(f * 3, f * 3 + 3), 3 * k++);
      b = count > 1 ? buildBVH({ positions: mesh.positions, indices }) : buildBVH(mesh);
      bvhs.set(c, b);
    }
    return b;
  };
  try {
    for (let pass = 0; pass < 3; pass++) {
      // Um bolso já começado (rótulo em `filled`) é completado nas passadas seguintes mesmo onde a
      // tampa do contorno novo já não passa pelo ar (o canto de uma dobra ligado à perna).
      const r = fillOnce(mesh, cur, ctx, baseLabel, triangulate, (f) => solid(comp[f]), (label) => filled.has(label));
      if (!r.filled.size) break;
      for (const [l, a] of r.filled) filled.set(l, (filled.get(l) ?? 0) + a);
      cur = r.labels;
    }
  } finally {
    for (const b of bvhs.values()) b.geometry.dispose();
  }
  return { labels: cur, filled };
}

function fillOnce(
  mesh: IndexedMesh,
  labels: Uint16Array,
  ctx: PocketContext,
  baseLabel: number,
  triangulate: Triangulator | null,
  /** BVH da casca da face dada. */
  solid: (face: number) => MeshBVH,
  started: (label: number) => boolean,
): PocketFill {
  const { islands, islandOf } = labelIslands(labels, ctx.neighbors, ctx.areas);
  const out = labels.slice();
  const filled = new Map<number, number>();
  const c = ctx.centroids;
  const p = mesh.positions;
  const idx = mesh.indices;
  for (const isl of islands) {
    if (isl.label === baseLabel || isl.faces.length < 3) continue;
    const loops = islandLoops(mesh, ctx.edges, (f) => islandOf[f] === isl.id, isl.faces, islandOf);
    if (!loops.length || loops.some((l) => !l.closed)) continue;
    if (!loops.some((l) => l.outerFaces.some((g) => out[g] === baseLabel))) continue;
    // O bolso fica dentro da caixa da própria região.
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (const f of isl.faces)
      for (let k = 0; k < 3; k++) {
        const v = idx[f * 3 + k] * 3;
        for (let a = 0; a < 3; a++) {
          lo[a] = Math.min(lo[a], p[v + a]);
          hi[a] = Math.max(hi[a], p[v + a]);
        }
      }
    const inBox = (f: number) => [0, 1, 2].every((a) => c[f * 3 + a] >= lo[a] && c[f * 3 + a] <= hi[a]);
    const closed = closedSurface(mesh, isl.faces, loops, triangulate, () => solid(isl.faces[0]));
    if (!closed) continue;
    // O bolso começa nos contornos cuja tampa passaria pelo ar.
    const open = started(isl.label);
    const seeds = loops.flatMap((l, i) => (open || closed.airy[i] ? l.outerFaces.filter((g) => out[g] === baseLabel) : []));
    if (!seeds.length) continue;
    const bvh = buildBVH(closed.surface);
    const inside = insideOf(bvh);
    const isIn = (f: number) => inBox(f) && inside([c[f * 3], c[f * 3 + 1], c[f * 3 + 2]]);
    const pocket: number[] = [];
    const seen = new Set<number>();
    const stack: number[] = [];
    for (const f of seeds)
      if (!seen.has(f)) {
        seen.add(f);
        if (isIn(f)) stack.push(f);
      }
    let area = 0;
    let tooBig = false;
    while (stack.length && !tooBig) {
      const f = stack.pop()!;
      pocket.push(f);
      area += ctx.areas[f];
      if (area > isl.area) tooBig = true;
      for (let k = 0; k < 3; k++) {
        const g = ctx.neighbors[f * 3 + k];
        if (g < 0 || seen.has(g) || out[g] !== baseLabel) continue;
        seen.add(g);
        if (isIn(g)) stack.push(g);
      }
    }
    bvh.geometry.dispose();
    // Um "bolso" maior que a própria região não é bolso: a tampa do contorno passou por fora.
    if (tooBig || !pocket.length) continue;
    const inPocket = new Set(pocket);
    for (const f of intrudingTube(ctx, out, baseLabel, inPocket)) inPocket.delete(f);
    area = 0;
    for (const f of inPocket) {
      out[f] = isl.label;
      area += ctx.areas[f];
    }
    if (inPocket.size) filled.set(isl.label, (filled.get(isl.label) ?? 0) + area);
  }
  return { labels: out, filled };
}

/**
 * O corpo que entra pelo bolso (a perna dentro do funil da bota) continua sendo da parte vizinha.
 * Perto da borda do preenchimento ele é um tubo: as normais das faces ficam perpendiculares a um eixo
 * e apontam para fora dele. As faces do bolso que continuam esse tubo para dentro voltam para a parte
 * vizinha, até onde o tubo encontra o fundo ou a parede do bolso (normais viradas para o eixo ou ao
 * longo dele). Assim o corte fica onde a perna encontra a bota, perpendicular a ela, e não atravessado
 * no meio da perna na altura da borda.
 */
function intrudingTube(ctx: PocketContext, labels: Uint16Array, baseLabel: number, pocket: Set<number>): number[] {
  const { neighbors: nb, normals: nr, centroids: c, areas } = ctx;
  // Faces sem pintura logo fora do preenchimento.
  const borderSet = new Set<number>();
  for (const f of pocket)
    for (let k = 0; k < 3; k++) {
      const g = nb[f * 3 + k];
      if (g >= 0 && labels[g] === baseLabel && !pocket.has(g)) borderSet.add(g);
    }
  const border = [...borderSet];
  if (border.length < 6) return [];
  const center: Vec3 = [0, 0, 0];
  for (const f of border) for (let a = 0; a < 3; a++) center[a] += c[f * 3 + a] / border.length;
  let reach = 0;
  for (const f of border) reach += Math.hypot(c[f * 3] - center[0], c[f * 3 + 1] - center[1], c[f * 3 + 2] - center[2]) / border.length;
  // Faixa curta do corpo vizinho logo além da borda (até ~1 raio dela), sem entrar no bolso: um
  // membro afina e se curva, e só o trecho perto da borda diz a direção dele ali.
  const band = new Set<number>(border);
  const queue = border.slice();
  const limit = 1.2 * reach;
  while (queue.length) {
    const f = queue.pop()!;
    for (let k = 0; k < 3; k++) {
      const g = nb[f * 3 + k];
      if (g < 0 || band.has(g) || pocket.has(g) || labels[g] !== baseLabel) continue;
      if (Math.hypot(c[g * 3] - center[0], c[g * 3 + 1] - center[1], c[g * 3 + 2] - center[2]) > limit) continue;
      band.add(g);
      queue.push(g);
    }
  }
  // Eixo do tubo: a direção perpendicular a todas as normais (menor autovalor de Σ n·nᵀ).
  const cov = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const origin: Vec3 = [0, 0, 0];
  let total = 0;
  for (const f of band) {
    const w = areas[f];
    const n = [nr[f * 3], nr[f * 3 + 1], nr[f * 3 + 2]];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cov[i * 3 + j] += w * n[i] * n[j];
    for (let a = 0; a < 3; a++) origin[a] += w * c[f * 3 + a];
    total += w;
  }
  if (!(total > 0)) return [];
  for (let a = 0; a < 3; a++) origin[a] /= total;
  const { values, vectors } = symmetricEigen3(cov);
  const spread = values[0] + values[1] + values[2];
  if (!(values[0] < 0.3 * values[1]) || !(values[1] > 0.2 * spread)) return [];
  const axis = vectors[0];
  // O eixo passa pelo centro da borda (o anel em volta do membro).
  for (let a = 0; a < 3; a++) origin[a] = center[a];
  const radial = (f: number): { dist: number; out: number; along: number } => {
    const d = [c[f * 3] - origin[0], c[f * 3 + 1] - origin[1], c[f * 3 + 2] - origin[2]];
    const t = d[0] * axis[0] + d[1] * axis[1] + d[2] * axis[2];
    const r = [d[0] - t * axis[0], d[1] - t * axis[1], d[2] - t * axis[2]];
    const dist = Math.hypot(r[0], r[1], r[2]) || 1e-12;
    const n = [nr[f * 3], nr[f * 3 + 1], nr[f * 3 + 2]];
    return {
      dist,
      out: (n[0] * r[0] + n[1] * r[1] + n[2] * r[2]) / dist,
      along: Math.abs(n[0] * axis[0] + n[1] * axis[1] + n[2] * axis[2]),
    };
  };
  const radii = [...band].map((f) => radial(f).dist).sort((a, b) => a - b);
  const radius = radii[Math.floor(radii.length / 2)];
  const isTube = (f: number) => {
    const r = radial(f);
    return r.dist < 1.6 * radius && r.out > 0.4 && r.along < 0.6;
  };
  const tube: number[] = [];
  const seen = new Set<number>();
  const stack: number[] = [];
  for (const f of border)
    for (let k = 0; k < 3; k++) {
      const g = nb[f * 3 + k];
      if (g >= 0 && pocket.has(g) && !seen.has(g)) {
        seen.add(g);
        if (isTube(g)) stack.push(g);
      }
    }
  while (stack.length) {
    const f = stack.pop()!;
    tube.push(f);
    for (let k = 0; k < 3; k++) {
      const g = nb[f * 3 + k];
      if (g < 0 || seen.has(g) || !pocket.has(g)) continue;
      seen.add(g);
      if (isTube(g)) stack.push(g);
    }
  }
  return tube;
}
