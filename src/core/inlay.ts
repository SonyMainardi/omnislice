import { DoubleSide, Ray } from "three";
import type { MeshBVH } from "three-mesh-bvh";
import { capDefects } from "./capcheck";
import type { BoundaryLoop } from "./labels";
import type { Vec3 } from "./math";
import { type IndexedMesh, halfEdgeFrom, halfEdgeTo } from "./mesh";

/**
 * Peça embutida: a superfície pintada vira o topo de uma peça com espessura constante para dentro
 * do modelo, com paredes ao longo do contorno pintado.
 *
 * É o corte de detalhes que ficam na superfície (um olho, um emblema, um botão rente): a tampa que
 * fecha o contorno por cima ficaria no ar (olho afundado) ou rente à pintura (peça sem espessura), e
 * um plano só pegaria o que sobra acima dele (a íris, e não o olho todo). Com o embutido o contorno
 * da peça é exatamente o pintado e ela assenta num rebaixo do mesmo formato.
 */

export interface InlayOptions {
  /** Profundidade máxima (mm). */
  maxDepth: number;
  /** Abaixo disso o embutido não vale (mm). */
  minDepth: number;
  /** Material que precisa sobrar atrás do rebaixo (mm). */
  minWall: number;
}

export interface InlayCap {
  /** Triângulos da tampa (paredes + fundo), com as normais para fora da peça. */
  tris: number[];
  /** Vértices novos (o fundo), numerados depois dos vértices de `positions`. */
  extraVerts: Vec3[];
  depth: number;
  /** Direção média da superfície pintada (para fora) e centro do fundo. */
  normal: Vec3;
  centroid: Vec3;
  /** Área da região projetada na direção média (mm²): a peça tem perto de `projected × depth` de volume. */
  projected: number;
}

/** Normais por vértice das faces da região, suavizadas sobre ela (rugas finas não entortam o fundo). */
function patchNormals(m: IndexedMesh, faces: number[], local: Map<number, number>, order: number[]): Float64Array {
  const p = m.positions;
  const idx = m.indices;
  const nv = order.length;
  let n = new Float64Array(nv * 3);
  const adj: Set<number>[] = Array.from({ length: nv }, () => new Set<number>());
  for (const f of faces) {
    const a = idx[f * 3];
    const b = idx[f * 3 + 1];
    const c = idx[f * 3 + 2];
    const ux = p[b * 3] - p[a * 3];
    const uy = p[b * 3 + 1] - p[a * 3 + 1];
    const uz = p[b * 3 + 2] - p[a * 3 + 2];
    const vx = p[c * 3] - p[a * 3];
    const vy = p[c * 3 + 1] - p[a * 3 + 1];
    const vz = p[c * 3 + 2] - p[a * 3 + 2];
    const cx = uy * vz - uz * vy;
    const cy = uz * vx - ux * vz;
    const cz = ux * vy - uy * vx;
    const ls = [local.get(a)!, local.get(b)!, local.get(c)!];
    for (const l of ls) {
      n[l * 3] += cx;
      n[l * 3 + 1] += cy;
      n[l * 3 + 2] += cz;
    }
    adj[ls[0]].add(ls[1]).add(ls[2]);
    adj[ls[1]].add(ls[0]).add(ls[2]);
    adj[ls[2]].add(ls[0]).add(ls[1]);
  }
  const normalize = (arr: Float64Array) => {
    for (let i = 0; i < nv; i++) {
      const l = Math.hypot(arr[i * 3], arr[i * 3 + 1], arr[i * 3 + 2]) || 1;
      arr[i * 3] /= l;
      arr[i * 3 + 1] /= l;
      arr[i * 3 + 2] /= l;
    }
  };
  normalize(n);
  let next = new Float64Array(nv * 3);
  for (let it = 0; it < 6; it++) {
    for (let i = 0; i < nv; i++) {
      let x = n[i * 3];
      let y = n[i * 3 + 1];
      let z = n[i * 3 + 2];
      for (const j of adj[i]) {
        x += n[j * 3];
        y += n[j * 3 + 1];
        z += n[j * 3 + 2];
      }
      next[i * 3] = x;
      next[i * 3 + 1] = y;
      next[i * 3 + 2] = z;
    }
    normalize(next);
    [n, next] = [next, n];
  }
  return n;
}

/**
 * Tampa de um embutido para as faces `faces` de `m` (a região inteira, com os contornos `loops`).
 * `positions` são as coordenadas de `m` como lista (os vértices novos vêm depois delas) e `solid` a
 * BVH de `m`. Devolve null quando a peça seria fina demais ou o fundo sairia do material.
 */
export function inlayCap(
  m: IndexedMesh,
  faces: number[],
  loops: BoundaryLoop[],
  solid: MeshBVH,
  positions: number[],
  opts: InlayOptions,
): InlayCap | null {
  if (!faces.length || !loops.length) return null;
  const idx = m.indices;
  const p = m.positions;
  const local = new Map<number, number>();
  const order: number[] = [];
  for (const f of faces)
    for (let k = 0; k < 3; k++) {
      const v = idx[f * 3 + k];
      if (!local.has(v)) {
        local.set(v, order.length);
        order.push(v);
      }
    }
  const n = patchNormals(m, faces, local, order);
  // Direção média da superfície pintada (para fora), ponderada pela área.
  const avg: Vec3 = [0, 0, 0];
  for (const f of faces) {
    const a = idx[f * 3] * 3;
    const b = idx[f * 3 + 1] * 3;
    const c = idx[f * 3 + 2] * 3;
    const ux = p[b] - p[a];
    const uy = p[b + 1] - p[a + 1];
    const uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a];
    const vy = p[c + 1] - p[a + 1];
    const vz = p[c + 2] - p[a + 2];
    avg[0] += uy * vz - uz * vy;
    avg[1] += uz * vx - ux * vz;
    avg[2] += ux * vy - uy * vx;
  }
  const al = Math.hypot(...avg);
  // A região precisa olhar para um lado (área projetada ≥ metade da área): uma faixa em volta de um
  // membro não é um detalhe de superfície.
  let area = 0;
  for (const f of faces) {
    const a = idx[f * 3] * 3;
    const b = idx[f * 3 + 1] * 3;
    const c = idx[f * 3 + 2] * 3;
    const ux = p[b] - p[a];
    const uy = p[b + 1] - p[a + 1];
    const uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a];
    const vy = p[c + 1] - p[a + 1];
    const vz = p[c + 2] - p[a + 2];
    area += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  }
  if (!(al > 0) || al < 0.5 * area) return null;
  const N: Vec3 = [avg[0] / al, avg[1] / al, avg[2] / al];

  // Espessura do modelo atrás da pintura: raio de cada vértice para dentro até a próxima superfície.
  const ray = new Ray();
  const stride = Math.max(1, Math.floor(order.length / 600));
  const thickness: number[] = [];
  for (let i = 0; i < order.length; i += stride) {
    const v = order[i];
    ray.origin.set(p[v * 3] - N[0] * 1e-4, p[v * 3 + 1] - N[1] * 1e-4, p[v * 3 + 2] - N[2] * 1e-4);
    ray.direction.set(-N[0], -N[1], -N[2]);
    const hit = solid.raycast(ray, DoubleSide).find((h) => h.distance > 1e-3);
    thickness.push(hit ? hit.distance : Infinity);
  }
  thickness.sort((a, b) => a - b);
  const thin = thickness[Math.floor(thickness.length * 0.1)] ?? 0;
  let depth = Math.min(opts.maxDepth, thin - opts.minWall);
  if (!(depth >= opts.minDepth)) return null;

  const base = positions.length / 3;
  const off = (v: number) => base + local.get(v)!;
  // Duas formas de descer: a região inteira deslocada numa direção só (o fundo é uma cópia da
  // pintura, nunca se dobra; serve para o que se pinta olhando de frente, como um olho) e, se ela
  // sair do material (um emblema que dá a volta num braço), cada vértice pela normal suavizada.
  const directions: ((i: number) => Vec3)[] = [() => N, (i) => [n[i * 3], n[i * 3 + 1], n[i * 3 + 2]]];
  for (let attempt = 0; attempt < 2 && depth >= opts.minDepth; attempt++) {
    for (const dir of directions) {
      const extraVerts: Vec3[] = order.map((v, i) => {
        const d = dir(i);
        return [p[v * 3] - depth * d[0], p[v * 3 + 1] - depth * d[1], p[v * 3 + 2] - depth * d[2]];
      });
      const tris: number[] = [];
      // Fundo: a região deslocada para dentro, com a orientação invertida (normal para dentro do modelo).
      for (const f of faces) tris.push(off(idx[f * 3]), off(idx[f * 3 + 2]), off(idx[f * 3 + 1]));
      // Paredes: cada aresta do contorno (a → b na face pintada) desce até o fundo.
      for (const loop of loops)
        for (const h of loop.halfEdges) {
          const a = halfEdgeFrom(m, h);
          const b = halfEdgeTo(m, h);
          tris.push(b, a, off(a), b, off(a), off(b));
        }
      const defects = capDefects(m, solid, positions, tris, extraVerts);
      if (defects.out < 0.002 && defects.self < 0.002) {
        const centroid: Vec3 = [0, 0, 0];
        for (const q of extraVerts) for (let k = 0; k < 3; k++) centroid[k] += q[k] / extraVerts.length;
        return { tris, extraVerts, depth, normal: N, centroid, projected: al / 2 };
      }
    }
    depth *= 0.6;
  }
  return null;
}
