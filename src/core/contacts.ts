import type { CrossSection } from "manifold-3d";
import { Vector3 } from "three";
import type { MeshBVH } from "three-mesh-bvh";
import { buildBVH } from "./bvh";
import type { Wasm } from "./manifoldBridge";
import { type Vec2, type Vec3, fitPlane, frameFromNormal, toLocal } from "./math";
import { type Bounds, computeBounds, triCount } from "./mesh";
import { NO_CUT, type PartGeometry } from "./part";
import type { Interface, PartRef } from "./split";

/**
 * Contatos entre peças que já eram cascas separadas no arquivo: a figura em pé sobre a base, um
 * acessório apoiado no corpo. Não existe corte entre elas, então antes não havia onde pôr encaixe e a
 * base separada saía sem pino nenhum.
 *
 * Uma peça "apoia" na outra onde as faces dela ficam de frente para uma superfície plana da outra, a
 * no máximo `CONTACT_GAP` (a sola esculpida de uma bota toca a base num ponto e fica uns décimos de
 * milímetro acima no resto). Cada região dessas (cada sola) vira uma interface como a de um corte
 * plano, no plano da superfície de apoio; o pino atravessa a folga. Contato em superfície curva (um
 * chapéu na cabeça, uma espada na mão) não serve para pino e fica de fora.
 *
 * Só contam faces originais do arquivo: as tampas dos cortes já têm as interfaces delas.
 */

/** Ids de "corte" dos contatos (cortes de verdade começam em 1 e nunca chegam aqui). */
export const CONTACT_ID_BASE = 1 << 24;
/** Folga máxima (mm) entre uma face e a superfície de apoio para contar como apoiada. */
export const CONTACT_GAP = 1;

export interface ContactOptions {
  /** Área mínima (mm²) de uma região de contato. */
  minArea?: number;
  /** Faces testadas por par, no máximo (modelos enormes com muitas cascas). */
  maxFaces?: number;
}

const overlapBox = (a: Bounds, b: Bounds, pad: number): Bounds | null => {
  const min: Vec3 = [0, 0, 0];
  const max: Vec3 = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    min[k] = Math.max(a.min[k], b.min[k]) - pad;
    max[k] = Math.min(a.max[k], b.max[k]) + pad;
    if (min[k] > max[k]) return null;
  }
  return { min, max };
};

/** Faces originais (sem marca de corte ou encaixe) cuja caixa toca `box`. */
function facesIn(g: PartGeometry, box: Bounds): number[] {
  const p = g.mesh.positions;
  const idx = g.mesh.indices;
  const out: number[] = [];
  for (let t = 0; t < triCount(g.mesh); t++) {
    if (g.cut[t] !== NO_CUT) continue;
    let inside = true;
    for (let k = 0; k < 3 && inside; k++) {
      const a = p[idx[t * 3] * 3 + k];
      const b = p[idx[t * 3 + 1] * 3 + k];
      const c = p[idx[t * 3 + 2] * 3 + k];
      inside = Math.max(a, b, c) >= box.min[k] && Math.min(a, b, c) <= box.max[k];
    }
    if (inside) out.push(t);
  }
  return out;
}

function triInfo(g: PartGeometry, t: number): { n: Vec3; area: number; c: Vec3 } {
  const p = g.mesh.positions;
  const idx = g.mesh.indices;
  const a = idx[t * 3] * 3;
  const b = idx[t * 3 + 1] * 3;
  const c = idx[t * 3 + 2] * 3;
  const ux = p[b] - p[a];
  const uy = p[b + 1] - p[a + 1];
  const uz = p[b + 2] - p[a + 2];
  const vx = p[c] - p[a];
  const vy = p[c + 1] - p[a + 1];
  const vz = p[c + 2] - p[a + 2];
  const n: Vec3 = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
  const l = Math.hypot(n[0], n[1], n[2]);
  return {
    n: l > 0 ? [n[0] / l, n[1] / l, n[2] / l] : [0, 0, 0],
    area: l / 2,
    c: [(p[a] + p[b] + p[c]) / 3, (p[a + 1] + p[b + 1] + p[c + 1]) / 3, (p[a + 2] + p[b + 2] + p[c + 2]) / 3],
  };
}

/** Grupos de faces ligadas por vértices compartilhados. */
function groups(g: PartGeometry, faces: number[]): number[][] {
  const parent = faces.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  const owner = new Map<number, number>();
  faces.forEach((t, i) => {
    for (let k = 0; k < 3; k++) {
      const v = g.mesh.indices[t * 3 + k];
      const j = owner.get(v);
      if (j === undefined) owner.set(v, i);
      else parent[find(i)] = find(j);
    }
  });
  const out = new Map<number, number[]>();
  faces.forEach((t, i) => {
    const r = find(i);
    const list = out.get(r);
    if (list) list.push(t);
    else out.set(r, [t]);
  });
  return [...out.values()];
}

/** Id estável de um contato: a posição dele (grade de 0,5 mm), para o ajuste próprio não se perder. */
function contactId(center: Vec3, used: Set<number>): number {
  let h = 2166136261;
  for (const v of center) {
    h ^= Math.round(v * 2) & 0xffff;
    h = Math.imul(h, 16777619) >>> 0;
  }
  let id = CONTACT_ID_BASE + (h % (1 << 20));
  while (used.has(id)) id++;
  used.add(id);
  return id;
}

interface Facing {
  face: number;
  /** Ponto mais próximo na superfície de apoio. */
  q: Vec3;
  area: number;
}

/**
 * Faces de `F` de frente para a superfície de `G`, inteiras a no máximo `CONTACT_GAP` dela (o centro e
 * os três vértices: um triângulo comprido do topo de uma base, que só passa perto da bota numa ponta,
 * não está apoiado nela).
 */
function facingFaces(F: PartGeometry, fFaces: number[], G: PartGeometry, gFaces: number[]): Facing[] {
  const mesh = { positions: G.mesh.positions, indices: new Uint32Array(gFaces.length * 3) };
  gFaces.forEach((t, k) => mesh.indices.set(G.mesh.indices.subarray(t * 3, t * 3 + 3), k * 3));
  const bvh: MeshBVH = buildBVH(mesh);
  const hit = { point: new Vector3(), distance: 0, faceIndex: 0 };
  const probe = new Vector3();
  const out: Facing[] = [];
  try {
    for (const t of fFaces) {
      const { n, c, area } = triInfo(F, t);
      probe.set(c[0], c[1], c[2]);
      const r = bvh.closestPointToPoint(probe, hit, 0, CONTACT_GAP);
      if (!r || r.distance > CONTACT_GAP) continue;
      const q: Vec3 = [r.point.x, r.point.y, r.point.z];
      const other = triInfo(G, gFaces[r.faceIndex]).n;
      if (n[0] * other[0] + n[1] * other[1] + n[2] * other[2] >= -0.85) continue;
      let near = true;
      for (let k = 0; k < 3 && near; k++) {
        const v = F.mesh.indices[t * 3 + k] * 3;
        probe.set(F.mesh.positions[v], F.mesh.positions[v + 1], F.mesh.positions[v + 2]);
        const rv = bvh.closestPointToPoint(probe, hit, 0, CONTACT_GAP);
        near = rv !== null && rv.distance <= CONTACT_GAP;
      }
      if (near) out.push({ face: t, q, area });
    }
  } finally {
    bvh.geometry.dispose();
  }
  return out;
}

export function computeContacts(w: Wasm, parts: PartRef[], opts: ContactOptions = {}): Interface[] {
  const minArea = opts.minArea ?? 1;
  const maxFaces = opts.maxFaces ?? 400_000;
  const bounds = parts.map((p) => computeBounds(p.geometry.mesh.positions));
  // Peças ligadas por um corte já têm encaixe nele: o resto do encosto delas (a barra da calça sobre
  // a canela) não é um apoio.
  const cutsOf = parts.map((p) => {
    const ids = new Set<number>();
    for (const t of p.geometry.cut) if (t >= 0) ids.add(t >> 1);
    return ids;
  });
  const shareCut = (a: number, b: number) => [...cutsOf[a]].some((id) => cutsOf[b].has(id));
  const out: Interface[] = [];
  const used = new Set<number>();
  for (let i = 0; i < parts.length; i++)
    for (let j = i + 1; j < parts.length; j++) {
      if (shareCut(i, j)) continue;
      const box = overlapBox(bounds[i], bounds[j], CONTACT_GAP);
      if (!box) continue;
      const fi = facesIn(parts[i].geometry, box);
      const fj = facesIn(parts[j].geometry, box);
      if (!fi.length || !fj.length || fi.length + fj.length > maxFaces) continue;
      // Testa nos dois sentidos: a superfície de apoio (plana) pode ser de qualquer uma das peças.
      const directions: [PartRef, PartRef, number[], number[]][] = [
        [parts[i], parts[j], fi, fj],
        [parts[j], parts[i], fj, fi],
      ];
      for (const [F, G, fFaces, gFaces] of directions) {
        const facing = facingFaces(F.geometry, fFaces, G.geometry, gFaces);
        if (!facing.length) continue;
        const byFace = new Map(facing.map((x) => [x.face, x]));
        let found = 0;
        for (const group of groups(F.geometry, facing.map((x) => x.face))) {
          const contact = contactRegion(w, F.geometry, group.map((t) => byFace.get(t)!), minArea);
          if (!contact) continue;
          // A normal sai da superfície de apoio (G) para a peça apoiada (F): F fica na frente.
          const cutId = contactId(contact.frame.origin, used);
          out.push({
            id: `${cutId}:${F.id}:${G.id}`,
            cutId,
            kind: "contact",
            frame: contact.frame,
            front: F.id,
            back: G.id,
            polygons: contact.polygons,
            area: contact.area,
            deviation: contact.deviation,
          });
          found++;
        }
        if (found) break;
      }
    }
  return out;
}

/**
 * Região de contato: o plano é o da superfície de apoio (os pontos mais próximos nela precisam estar
 * num plano) e a região é a união das faces apoiadas, projetadas nele.
 */
function contactRegion(
  w: Wasm,
  g: PartGeometry,
  facing: Facing[],
  minArea: number,
): { frame: Interface["frame"]; polygons: Vec2[][]; area: number; deviation: number } | null {
  let area = 0;
  for (const f of facing) area += f.area;
  if (area < minArea || facing.length < 3) return null;
  const pts = new Float64Array(facing.length * 3);
  facing.forEach((f, i) => pts.set(f.q, i * 3));
  const fit = fitPlane(pts, facing.length);
  // Superfície de apoio que não é plana (cabeça, mão): sem contato para pino.
  if (fit.maxDeviation > Math.max(0.05, 0.01 * fit.radius)) return null;
  // Normal para o lado da peça apoiada: contra as normais das faces dela, que olham para o apoio
  // (vale também quando a sola está um pouco cravada na base, abaixo do plano).
  let side = 0;
  for (const f of facing) {
    const n = triInfo(g, f.face).n;
    side -= (n[0] * fit.normal[0] + n[1] * fit.normal[1] + n[2] * fit.normal[2]) * f.area;
  }
  const normal: Vec3 = side >= 0 ? fit.normal : [-fit.normal[0], -fit.normal[1], -fit.normal[2]];
  const frame = frameFromNormal(fit.centroid, normal);
  const p = g.mesh.positions;
  const idx = g.mesh.indices;
  const polys: Vec2[][] = [];
  let deviation = 0;
  for (const f of facing) {
    const tri: Vec2[] = [];
    for (let k = 0; k < 3; k++) {
      const v = idx[f.face * 3 + k] * 3;
      const l = toLocal(frame, [p[v], p[v + 1], p[v + 2]]);
      deviation = Math.max(deviation, Math.abs(l[2]));
      tri.push([l[0], l[1]]);
    }
    const a2 = (tri[1][0] - tri[0][0]) * (tri[2][1] - tri[0][1]) - (tri[2][0] - tri[0][0]) * (tri[1][1] - tri[0][1]);
    if (Math.abs(a2) < 1e-12) continue;
    polys.push(a2 > 0 ? tri : [tri[0], tri[2], tri[1]]);
  }
  const owned: CrossSection[] = [];
  const own = (x: CrossSection) => {
    owned.push(x);
    return x;
  };
  try {
    // Faces apoiadas formam uma região com recortes (a sola esculpida encosta aqui e ali): fecha os
    // recortes menores que meio milímetro e descarta lascas soltas bem menores que a região principal.
    const cs = own(new w.CrossSection(polys, "Positive"));
    const closed = own(own(cs.offset(0.25, "Round")).offset(-0.25, "Round"));
    const pieces = closed.decompose().map(own);
    const largest = Math.max(0, ...pieces.map((x) => x.area()));
    const kept = pieces.filter((x) => x.area() >= 0.15 * largest);
    if (!kept.length) return null;
    const simple = own(own(w.CrossSection.union(kept)).simplify(0.01));
    const a = simple.area();
    if (a < minArea) return null;
    return { frame, polygons: simple.toPolygons() as Vec2[][], area: a, deviation };
  } finally {
    for (const x of owned) x.delete();
  }
}
