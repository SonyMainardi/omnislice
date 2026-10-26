import type { Manifold } from "manifold-3d";
import { type IndexedMesh, computeBounds, faceComponents, triCount } from "./mesh";
import type { PartGeometry } from "./part";

/**
 * Cascas fechadas de uma malha e como elas se aninham. Um objeto oco tem uma casca externa (volume
 * positivo) e uma cavidade: uma casca interna com as normais para dentro (volume negativo).
 */
export interface ShellInfo {
  faces: number[];
  signedVolume: number;
  /** Quantas outras cascas contêm esta por inteiro. */
  depth: number;
  /** Casca que contém esta diretamente (-1 se nenhuma). */
  parent: number;
}

// Direções "tortas" para o teste de paridade não passar exatamente por arestas ou vértices.
const RAY_DIRS: [number, number, number][] = [
  [0.5773, 0.5774, 0.5775],
  [-0.6123, 0.2117, 0.7616],
  [0.1371, -0.8492, 0.5099],
];

/** Interseção raio–triângulo (Möller–Trumbore), só no sentido positivo do raio. */
function rayHitsTriangle(
  o: [number, number, number],
  d: [number, number, number],
  p: ArrayLike<number>,
  a: number,
  b: number,
  c: number,
): boolean {
  const e1x = p[b] - p[a];
  const e1y = p[b + 1] - p[a + 1];
  const e1z = p[b + 2] - p[a + 2];
  const e2x = p[c] - p[a];
  const e2y = p[c + 1] - p[a + 1];
  const e2z = p[c + 2] - p[a + 2];
  const px = d[1] * e2z - d[2] * e2y;
  const py = d[2] * e2x - d[0] * e2z;
  const pz = d[0] * e2y - d[1] * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-18) return false;
  const inv = 1 / det;
  const tx = o[0] - p[a];
  const ty = o[1] - p[a + 1];
  const tz = o[2] - p[a + 2];
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < 0 || u > 1) return false;
  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;
  const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
  if (v < 0 || u + v > 1) return false;
  return (e2x * qx + e2y * qy + e2z * qz) * inv > 1e-12;
}

/** O ponto está dentro da casca (conjunto fechado de faces)? Paridade de cruzamentos, voto em 3 raios. */
export function insideShell(mesh: IndexedMesh, faces: number[], point: [number, number, number]): boolean {
  const p = mesh.positions;
  const idx = mesh.indices;
  let votes = 0;
  for (const d of RAY_DIRS) {
    let crossings = 0;
    for (const f of faces)
      if (rayHitsTriangle(point, d, p, idx[f * 3] * 3, idx[f * 3 + 1] * 3, idx[f * 3 + 2] * 3)) crossings++;
    if (crossings % 2 === 1) votes++;
  }
  return votes >= 2;
}

function shellVolume(mesh: IndexedMesh, faces: number[]): number {
  const p = mesh.positions;
  let v = 0;
  for (const f of faces) {
    const a = mesh.indices[f * 3] * 3;
    const b = mesh.indices[f * 3 + 1] * 3;
    const c = mesh.indices[f * 3 + 2] * 3;
    v +=
      p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) -
      p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
      p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return v / 6;
}

/** Vértices extremos da casca em cada eixo: sondas para saber se ela está inteira dentro de outra. */
function probesOf(mesh: IndexedMesh, faces: number[]): [number, number, number][] {
  const best = new Int32Array(6).fill(-1);
  const p = mesh.positions;
  for (const f of faces)
    for (let k = 0; k < 3; k++) {
      const v = mesh.indices[f * 3 + k];
      for (let axis = 0; axis < 3; axis++) {
        const lo = best[axis * 2];
        const hi = best[axis * 2 + 1];
        if (lo < 0 || p[v * 3 + axis] < p[lo * 3 + axis]) best[axis * 2] = v;
        if (hi < 0 || p[v * 3 + axis] > p[hi * 3 + axis]) best[axis * 2 + 1] = v;
      }
    }
  return [...new Set(best)].filter((v) => v >= 0).map((v) => [p[v * 3], p[v * 3 + 1], p[v * 3 + 2]]);
}

/**
 * Cascas (componentes por aresta) com volume assinado e aninhamento. Uma casca só conta como
 * contida em outra quando todos os seus vértices extremos estão dentro dela; cascas que apenas se
 * cruzam (um acessório enfiado no corpo, por exemplo) não ficam aninhadas.
 */
export function shellNesting(mesh: IndexedMesh, neighbors?: Int32Array): ShellInfo[] {
  const { count, comp } = faceComponents(mesh, neighbors);
  const shells: ShellInfo[] = Array.from({ length: count }, () => ({ faces: [], signedVolume: 0, depth: 0, parent: -1 }));
  for (let f = 0; f < comp.length; f++) shells[comp[f]].faces.push(f);
  for (const s of shells) s.signedVolume = shellVolume(mesh, s.faces);
  if (count < 2) return shells;
  const boxes = shells.map((s) => {
    const pts: number[] = [];
    for (const f of s.faces)
      for (let k = 0; k < 3; k++) {
        const v = mesh.indices[f * 3 + k] * 3;
        pts.push(mesh.positions[v], mesh.positions[v + 1], mesh.positions[v + 2]);
      }
    return computeBounds(pts);
  });
  const containers: number[][] = shells.map(() => []);
  for (let i = 0; i < count; i++) {
    const bi = boxes[i];
    let probes: [number, number, number][] | null = null;
    for (let j = 0; j < count; j++) {
      if (i === j) continue;
      const bj = boxes[j];
      const boxInside =
        bi.min[0] >= bj.min[0] && bi.min[1] >= bj.min[1] && bi.min[2] >= bj.min[2] &&
        bi.max[0] <= bj.max[0] && bi.max[1] <= bj.max[1] && bi.max[2] <= bj.max[2];
      if (!boxInside) continue;
      probes ??= probesOf(mesh, shells[i].faces);
      if (probes.every((pt) => insideShell(mesh, shells[j].faces, pt))) containers[i].push(j);
    }
  }
  for (let i = 0; i < count; i++) {
    shells[i].depth = containers[i].length;
    // Pai direto: o contêiner mais fundo.
    let parent = -1;
    for (const j of containers[i]) if (parent < 0 || containers[j].length > containers[parent].length) parent = j;
    shells[i].parent = parent;
  }
  return shells;
}

/**
 * Agrupa as cascas em sólidos físicos: cada cavidade fica com a casca sólida que a contém.
 * `isCavity` decide o que é cavidade (pelo sinal do volume na saída do Manifold, que é sempre
 * orientada; pela profundidade de aninhamento em arquivos importados).
 */
function groupShells(shells: ShellInfo[], isCavity: (s: ShellInfo) => boolean): number[][] {
  const owner = shells.map((_, i) => {
    let r = i;
    let guard = 0;
    while (isCavity(shells[r]) && shells[r].parent >= 0 && guard++ < shells.length) r = shells[r].parent;
    return isCavity(shells[r]) ? i : r;
  });
  const groups = new Map<number, number[]>();
  owner.forEach((o, i) => {
    const list = groups.get(o);
    if (list) list.push(i);
    else groups.set(o, [i]);
  });
  return [...groups.values()];
}

/**
 * Sólido físico de cada face (como `faceComponents`, mas cada cavidade pertence ao sólido que a
 * envolve). Para malhas importadas: a cavidade é reconhecida pelo aninhamento.
 */
export function solidComponents(mesh: IndexedMesh, neighbors?: Int32Array): { count: number; comp: Int32Array; shells: ShellInfo[] } {
  const shells = shellNesting(mesh, neighbors);
  const groups = groupShells(shells, (s) => s.depth % 2 === 1);
  const comp = new Int32Array(triCount(mesh));
  groups.forEach((members, id) => {
    for (const i of members) for (const f of shells[i].faces) comp[f] = id;
  });
  return { count: groups.length, comp, shells };
}

/**
 * Divide um sólido do Manifold em pedaços físicos (cada casca externa com as cavidades dela).
 * `Manifold.decompose()` devolve as cavidades como pedaços "do avesso", que `compose` e `union`
 * descartam; aqui cada casca externa que tem cavidade vira a interseção dela com o sólido inteiro,
 * uma booleana exata que mantém a precisão interna e a origem (lado do corte) de cada face.
 */
export function decomposeSolids(m: Manifold): Manifold[] {
  const pieces = m.decompose();
  if (pieces.length <= 1) {
    for (const p of pieces) p.delete();
    return [m];
  }
  const solids: Manifold[] = [];
  const cavities: Manifold[] = [];
  for (const p of pieces) (p.volume() < 0 ? cavities : solids).push(p);
  if (!cavities.length) return solids;
  const inside = (a: Manifold, b: Manifold) => {
    const x = a.boundingBox();
    const y = b.boundingBox();
    return x.min.every((v, k) => v >= y.min[k]) && x.max.every((v, k) => v <= y.max[k]);
  };
  const out = solids.map((outer) => {
    if (!cavities.some((c) => inside(c, outer))) return outer;
    // A interseção também traria pedaços soltos dentro da cavidade (uma bola dentro de uma esfera
    // oca): eles já são peças próprias e saem daqui.
    let piece = m.intersect(outer);
    for (const other of solids) {
      if (other === outer || !inside(other, outer)) continue;
      const next = piece.subtract(other);
      piece.delete();
      piece = next;
    }
    return piece;
  });
  for (const s of solids) if (!out.includes(s)) s.delete();
  for (const c of cavities) c.delete();
  return out;
}

/** Subconjunto de faces de uma peça, com atributos e vértices compactados. */
export function subsetGeometry(g: PartGeometry, faces: number[]): PartGeometry {
  const remap = new Int32Array(g.mesh.positions.length / 3).fill(-1);
  const positions: number[] = [];
  const indices = new Uint32Array(faces.length * 3);
  const src = new Int32Array(faces.length);
  const cut = new Int32Array(faces.length);
  faces.forEach((f, i) => {
    for (let k = 0; k < 3; k++) {
      const v = g.mesh.indices[f * 3 + k];
      if (remap[v] < 0) {
        remap[v] = positions.length / 3;
        positions.push(g.mesh.positions[v * 3], g.mesh.positions[v * 3 + 1], g.mesh.positions[v * 3 + 2]);
      }
      indices[i * 3 + k] = remap[v];
    }
    src[i] = g.src[f];
    cut[i] = g.cut[f];
  });
  return { mesh: { positions: new Float32Array(positions), indices }, src, cut };
}
