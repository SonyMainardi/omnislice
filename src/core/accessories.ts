import { DoubleSide, Matrix4, Ray } from "three";
import type { MeshBVH } from "three-mesh-bvh";
import { buildBVH } from "./bvh";
import type { IndexedMesh } from "./mesh";

/** Sólido com faces de mais de uma região (será cortado). */
export const MIXED_SOLID = -1;

/** Acima disso o teste de contato entre cascas não compensa (malhas com milhares de fragmentos). */
const MAX_SOLIDS = 2000;
/** Um acessório só acompanha uma região se for bem menor que ela (área). */
const MAX_ACCESSORY_FRACTION = 0.25;

export interface AccessoryAttachment {
  /** Sólido (índice em `solids`) e a região para onde ele vai. */
  solid: number;
  label: number;
}

/**
 * Acessórios soltos: cascas fechadas sem pintura que estão cravadas numa única região separada (um
 * logotipo no chapéu, uma espada na mão, um decalque na roupa) acompanham essa região, em vez de
 * ficarem flutuando junto do corpo principal.
 *
 * Só conta contato real (as superfícies se cruzam, ou o acessório está dentro do sólido): peças
 * modeladas com folga, mesmo pequena, ficam onde estão. Grupos de acessórios encostados entre si
 * contam juntos. Um grupo não se move se encostar no corpo principal, se encostar em mais de uma
 * região ou se não for bem menor que a região; o maior grupo sem pintura é o corpo principal
 * quando nenhum sólido cortado tem faces dele.
 */
export function attachLooseAccessories(
  mesh: IndexedMesh,
  labels: Uint16Array,
  areas: Float32Array,
  solids: Int32Array[],
  solidLabel: Int32Array,
  baseLabel: number,
): AccessoryAttachment[] {
  const count = solids.length;
  if (count < 2 || count > MAX_SOLIDS) return [];
  const isBase = (s: number) => solidLabel[s] === baseLabel;
  const anyBase = solids.some((_, s) => isBase(s));
  const anyOther = solids.some((_, s) => !isBase(s));
  if (!anyBase || !anyOther) return [];

  const p = mesh.positions;
  const idx = mesh.indices;
  const boxes = solids.map((faces) => {
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < faces.length; i++)
      for (let k = 0; k < 3; k++) {
        const v = idx[faces[i] * 3 + k] * 3;
        for (let a = 0; a < 3; a++) {
          if (p[v + a] < lo[a]) lo[a] = p[v + a];
          if (p[v + a] > hi[a]) hi[a] = p[v + a];
        }
      }
    return { lo, hi };
  });
  const overlap = (a: number, b: number) =>
    [0, 1, 2].every((k) => boxes[a].lo[k] <= boxes[b].hi[k] && boxes[b].lo[k] <= boxes[a].hi[k]);
  const inside = (a: number, b: number) => [0, 1, 2].every((k) => boxes[a].lo[k] >= boxes[b].lo[k] && boxes[a].hi[k] <= boxes[b].hi[k]);

  const solidArea = solids.map((faces) => {
    let s = 0;
    for (let i = 0; i < faces.length; i++) s += areas[faces[i]];
    return s;
  });
  const labelArea = new Map<number, number>();
  for (let f = 0; f < labels.length; f++) labelArea.set(labels[f], (labelArea.get(labels[f]) ?? 0) + areas[f]);

  const bvhs = new Map<number, MeshBVH>();
  const bvhOf = (s: number): MeshBVH => {
    let b = bvhs.get(s);
    if (!b) {
      b = buildBVH(meshOfFaces(mesh, solids[s]));
      bvhs.set(s, b);
    }
    return b;
  };
  const identity = new Matrix4();

  /** Rótulos das faces de `t` que a superfície de `s` atravessa (ou que envolvem `s`). */
  const contactLabels = (s: number, t: number): Set<number> => {
    const found = new Set<number>();
    const settled = solidLabel[t] !== MIXED_SOLID;
    const bt = bvhOf(t);
    const facesT = solids[t];
    let hits = 0;
    bt.bvhcast(bvhOf(s), identity, {
      intersectsTriangles: (t1, t2, i1) => {
        if (!t1.intersectsTriangle(t2)) return false;
        found.add(labels[facesT[bt.resolveTriangleIndex(i1)]]);
        // Num sólido de uma região só, o primeiro cruzamento basta; num cortado, uma amostra.
        return settled || ++hits >= 256;
      },
    });
    if (found.size || !inside(s, t)) return found;
    // Sem cruzamento: o acessório pode estar inteiro dentro do sólido (paridade de um raio).
    const v = idx[solids[s][0] * 3] * 3;
    const ray = new Ray();
    ray.origin.set(p[v], p[v + 1], p[v + 2]);
    ray.direction.set(0.5773, 0.5774, 0.5775).normalize();
    const crossings = bt.raycast(ray, DoubleSide);
    if (crossings.length % 2 === 1) {
      crossings.sort((a, b) => a.distance - b.distance);
      const face = crossings[0].faceIndex;
      if (face !== undefined && face !== null) found.add(labels[facesT[face]]);
    }
    return found;
  };

  // O que cada sólido sem pintura toca fora do corpo (calculado sob demanda).
  const memo = new Map<number, { labels: Set<number>; body: boolean }>();
  const touchesOutside = (s: number) => {
    let r = memo.get(s);
    if (r) return r;
    r = { labels: new Set<number>(), body: false };
    for (let t = 0; t < count; t++) {
      if (t === s || isBase(t) || !overlap(s, t)) continue;
      for (const l of contactLabels(s, t)) {
        if (l === baseLabel) r.body = true;
        else r.labels.add(l);
      }
    }
    memo.set(s, r);
    return r;
  };

  // Maior área que um acessório pode ter: uma fração da maior região separada.
  let maxLabelArea = 0;
  for (const [l, a] of labelArea) if (l !== baseLabel) maxLabelArea = Math.max(maxLabelArea, a);
  const cap = MAX_ACCESSORY_FRACTION * maxLabelArea;
  // Corpo principal: as faces sem pintura de um sólido cortado ou, se não houver, o maior grupo sem
  // pintura. Sem calcular todos os grupos: um grupo não é o maior se algum sólido sem pintura fora
  // dele já é maior que ele.
  const bodyInMixed = solids.some(
    (faces, s) => solidLabel[s] === MIXED_SOLID && Array.prototype.some.call(faces, (f: number) => labels[f] === baseLabel),
  );

  const out: AccessoryAttachment[] = [];
  const visited = new Uint8Array(count);
  for (let s0 = 0; s0 < count; s0++) {
    if (!isBase(s0) || visited[s0] || solidArea[s0] > cap) continue;
    // Só começa por quem encosta numa região separada.
    if (!solids.some((_, t) => !isBase(t) && overlap(s0, t))) continue;
    const first = touchesOutside(s0);
    if (!first.labels.size) continue;
    // Grupo de sólidos sem pintura encostados entre si, até passar do tamanho de um acessório.
    const members = [s0];
    visited[s0] = 1;
    let area = solidArea[s0];
    let tooBig = false;
    for (let i = 0; i < members.length && !tooBig; i++)
      for (let t = 0; t < count && !tooBig; t++) {
        if (visited[t] || !isBase(t) || !overlap(members[i], t)) continue;
        if (!contactLabels(members[i], t).size) continue;
        visited[t] = 1;
        members.push(t);
        area += solidArea[t];
        tooBig = area > cap;
      }
    if (tooBig) continue;
    const touchedLabels = new Set<number>();
    let body = false;
    for (const m of members) {
      const r = touchesOutside(m);
      body ||= r.body;
      for (const l of r.labels) touchedLabels.add(l);
    }
    if (body || touchedLabels.size !== 1) continue;
    const [label] = touchedLabels;
    if (area > MAX_ACCESSORY_FRACTION * (labelArea.get(label) ?? 0)) continue;
    const memberSet = new Set(members);
    const isMain = !bodyInMixed && !solids.some((_, t) => isBase(t) && !memberSet.has(t) && solidArea[t] >= area);
    if (isMain) continue;
    for (const m of members) out.push({ solid: m, label });
  }
  for (const b of bvhs.values()) b.geometry.dispose();
  return out;
}

function meshOfFaces(mesh: IndexedMesh, faces: Int32Array): IndexedMesh {
  const remap = new Int32Array(mesh.positions.length / 3).fill(-1);
  const order: number[] = [];
  const indices = new Uint32Array(faces.length * 3);
  for (let i = 0; i < faces.length; i++)
    for (let k = 0; k < 3; k++) {
      const v = mesh.indices[faces[i] * 3 + k];
      if (remap[v] < 0) {
        remap[v] = order.length;
        order.push(v);
      }
      indices[i * 3 + k] = remap[v];
    }
  const positions = new Float32Array(order.length * 3);
  order.forEach((v, i) => {
    positions[i * 3] = mesh.positions[v * 3];
    positions[i * 3 + 1] = mesh.positions[v * 3 + 1];
    positions[i * 3 + 2] = mesh.positions[v * 3 + 2];
  });
  return { positions, indices };
}
