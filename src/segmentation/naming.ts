import type { Vec3 } from "../core/math";
import { type IndexedMesh, computeBounds, faceCentroids, faceNormalsAndAreas, triCount } from "../core/mesh";
import type { SegmentInfo } from "./types";

interface Seg {
  id: number;
  area: number;
  centroid: Vec3;
  min: Vec3;
  max: Vec3;
  faces: number;
  neighbors: Map<number, number>;
}

/** Estatísticas por segmento: área, centróide, caixa e vizinhança. */
export function describeSegments(mesh: IndexedMesh, neighbors: Int32Array, labels: Uint16Array): Seg[] {
  const n = triCount(mesh);
  const { areas } = faceNormalsAndAreas(mesh);
  const c = faceCentroids(mesh);
  let count = 0;
  for (let f = 0; f < n; f++) count = Math.max(count, labels[f] + 1);
  const segs: Seg[] = Array.from({ length: count }, (_, id) => ({
    id,
    area: 0,
    centroid: [0, 0, 0] as Vec3,
    min: [Infinity, Infinity, Infinity] as Vec3,
    max: [-Infinity, -Infinity, -Infinity] as Vec3,
    faces: 0,
    neighbors: new Map<number, number>(),
  }));
  for (let f = 0; f < n; f++) {
    const s = segs[labels[f]];
    s.area += areas[f];
    s.faces++;
    for (let k = 0; k < 3; k++) {
      const v = c[f * 3 + k];
      s.centroid[k] += v * areas[f];
      s.min[k] = Math.min(s.min[k], v);
      s.max[k] = Math.max(s.max[k], v);
    }
    for (let j = 0; j < 3; j++) {
      const g = neighbors[f * 3 + j];
      if (g >= 0 && labels[g] !== labels[f]) s.neighbors.set(labels[g], (s.neighbors.get(labels[g]) ?? 0) + 1);
    }
  }
  for (const s of segs) if (s.area > 0) s.centroid = s.centroid.map((v) => v / s.area) as Vec3;
  return segs;
}

/**
 * Sugere nomes anatômicos/estruturais por posição (eixo Z para cima, personagem olhando para −Y).
 * São apenas sugestões editáveis: a geometria não diz o que cada parte "é".
 */
export function nameSegments(mesh: IndexedMesh, neighbors: Int32Array, labels: Uint16Array): SegmentInfo[] {
  const segs = describeSegments(mesh, neighbors, labels).filter((s) => s.faces > 0);
  const names = new Map<number, string>();
  const model = computeBounds(mesh.positions);
  const height = Math.max(model.max[2] - model.min[2], 1e-9);
  const footprint = (model.max[0] - model.min[0]) * (model.max[1] - model.min[1]);
  // Segmentos achatados apoiados no fundo do modelo formam a base (pode vir em mais de um pedaço).
  const isBase = (s: Seg) =>
    s.min[2] - model.min[2] < height * 0.02 &&
    s.max[2] - s.min[2] < height * 0.2 &&
    (s.max[0] - s.min[0]) * (s.max[1] - s.min[1]) > footprint * 0.1;
  const bases = segs.filter(isBase).sort((a, b) => b.area - a.area);
  const baseFootprint = bases.reduce((s, b) => s + (b.max[0] - b.min[0]) * (b.max[1] - b.min[1]), 0);
  const base = baseFootprint > footprint * 0.3 ? bases[0] : undefined;
  if (base) bases.forEach((b, i) => names.set(b.id, i === 0 ? "Base" : `Base ${i + 1}`));
  const rest = segs.filter((s) => !names.has(s.id)).sort((a, b) => b.area - a.area);
  const main = rest[0];
  if (!main) return [];
  const side = (s: Seg) => (s.centroid[0] >= main.centroid[0] ? "esquerdo" : "direito");
  const sideF = (s: Seg) => (s.centroid[0] >= main.centroid[0] ? "esquerda" : "direita");
  const mainHalfWidth = (main.max[0] - main.min[0]) / 2;
  const isAdjacent = (a: Seg, b: Seg) => a.neighbors.has(b.id) || b.neighbors.has(a.id);
  const lateral = (s: Seg) => Math.abs(s.centroid[0] - main.centroid[0]) > mainHalfWidth * 0.55;
  const top = main.max[2];
  const middle = main.centroid[2];

  const figureLike = rest.some((s) => s !== main && isAdjacent(s, main) && s.centroid[2] > top - height * 0.05 && !lateral(s));
  names.set(main.id, figureLike ? "Tronco" : "Corpo");

  // Cabeça: vizinho central acima do tronco (possivelmente via pescoço).
  const above = rest.filter((s) => s !== main && !lateral(s) && s.centroid[2] > top - height * 0.03);
  const neck = above.find((s) => isAdjacent(s, main) && above.some((h) => h !== s && isAdjacent(h, s) && h.centroid[2] > s.centroid[2]));
  const head = above
    .filter((s) => s !== neck && (isAdjacent(s, main) || (neck && isAdjacent(s, neck))))
    .sort((a, b) => b.area - a.area)[0];
  if (head) names.set(head.id, "Cabeça");
  if (neck && head) names.set(neck.id, "Pescoço");

  for (const s of rest) {
    if (names.has(s.id)) continue;
    if (isAdjacent(s, main) && lateral(s) && s.centroid[2] >= middle - height * 0.05) names.set(s.id, `Braço ${side(s)}`);
    else if (isAdjacent(s, main) && s.centroid[2] < middle) names.set(s.id, `Perna ${sideF(s)}`);
  }
  for (const s of rest) {
    if (names.has(s.id)) continue;
    const arm = rest.find((a) => names.get(a.id)?.startsWith("Braço") && isAdjacent(a, s));
    const leg = rest.find((l) => names.get(l.id)?.startsWith("Perna") && isAdjacent(l, s));
    if (arm) names.set(s.id, `Mão ${sideF(s)}`);
    else if (leg && s.centroid[2] < leg.centroid[2]) names.set(s.id, `Pé ${side(s)}`);
    else if (head && isAdjacent(head, s)) names.set(s.id, s.centroid[2] > head.centroid[2] ? "Chapéu / cabelo" : "Acessório da cabeça");
  }
  let extra = 1;
  const used = new Map<string, number>();
  return segs.map((s) => {
    let name = names.get(s.id) ?? `Parte ${extra++}`;
    const count = used.get(name) ?? 0;
    used.set(name, count + 1);
    if (count) name = `${name} ${count + 1}`;
    return {
      id: s.id,
      name,
      area: s.area,
      centroid: s.centroid,
      faceCount: s.faces,
      suggestedSeparate: s !== main,
    };
  });
}
