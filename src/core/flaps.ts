import { DoubleSide, Ray } from "three";
import { buildBVH } from "./bvh";
import { type PlaneFrame, type Vec2, type Vec3, toLocal, toWorld } from "./math";
import { triCount } from "./mesh";
import type { PartGeometry } from "./part";

/** Parede mínima imprimível em FDM (mm): duas linhas de um bico de 0,4 mm. */
export const FDM_MIN_WALL = 0.8;
/** Largura (mm) a partir da qual uma região mais fina que a parede mínima é uma aba, não uma borda. */
export const FLAP_WIDTH = 3;

export interface CapFlap {
  /** Largura (mm) da maior região da tampa onde a peça é mais fina que `minWall`. */
  width: number;
  /** Menor espessura medida perpendicularmente ao corte (Infinity se não houve amostra). */
  minThickness: number;
}

/**
 * Abas criadas por um corte: numa grade sobre a tampa, mede a espessura da peça na direção
 * perpendicular ao corte e devolve a largura da maior região mais fina que `minWall` (o diâmetro do
 * maior disco que cabe nela). Uma cunha estreita na borda de um corte oblíquo não conta; uma lâmina
 * larga (corte rente a uma face plana, plano quase tangente a uma superfície) conta.
 *
 * `footprint` restringe a grade a um retângulo no plano do corte (coordenadas locais do `frame`).
 */
export function capFlap(
  g: PartGeometry,
  tag: number,
  frame: PlaneFrame,
  side: 0 | 1,
  minWall: number,
  footprint?: { lo: Vec2; hi: Vec2 },
): CapFlap {
  const p = g.mesh.positions;
  const idx = g.mesh.indices;
  let lo: Vec2 = [Infinity, Infinity];
  let hi: Vec2 = [-Infinity, -Infinity];
  for (let t = 0; t < g.cut.length; t++) {
    if (g.cut[t] !== tag) continue;
    for (let k = 0; k < 3; k++) {
      const v = idx[t * 3 + k] * 3;
      const l = toLocal(frame, [p[v], p[v + 1], p[v + 2]]);
      lo = [Math.min(lo[0], l[0]), Math.min(lo[1], l[1])];
      hi = [Math.max(hi[0], l[0]), Math.max(hi[1], l[1])];
    }
  }
  if (footprint) {
    lo = [Math.max(lo[0], footprint.lo[0]), Math.max(lo[1], footprint.lo[1])];
    hi = [Math.min(hi[0], footprint.hi[0]), Math.min(hi[1], footprint.hi[1])];
  }
  if (!(hi[0] > lo[0] && hi[1] > lo[1])) return { width: 0, minThickness: Infinity };
  const extent = Math.max(hi[0] - lo[0], hi[1] - lo[1]);
  // Passo da grade: fino o bastante para medir abas de alguns milímetros (≥ 12 células na largura
  // limite), limitado para tampas grandes.
  const h = Math.min(Math.max(extent / 220, 0.08), 0.25);
  const nx = Math.ceil((hi[0] - lo[0]) / h) + 1;
  const ny = Math.ceil((hi[1] - lo[1]) / h) + 1;
  // Só as faces cuja projeção cai sobre a grade podem ser atingidas pelos raios perpendiculares.
  const n = triCount(g.mesh);
  const keep: number[] = [];
  for (let t = 0; t < n; t++) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let k = 0; k < 3; k++) {
      const v = idx[t * 3 + k] * 3;
      const l = toLocal(frame, [p[v], p[v + 1], p[v + 2]]);
      x0 = Math.min(x0, l[0]);
      y0 = Math.min(y0, l[1]);
      x1 = Math.max(x1, l[0]);
      y1 = Math.max(y1, l[1]);
    }
    if (x1 >= lo[0] - h && x0 <= hi[0] + h && y1 >= lo[1] - h && y0 <= hi[1] + h) keep.push(t);
  }
  const sub = new Uint32Array(keep.length * 3);
  keep.forEach((t, i) => {
    sub[i * 3] = idx[t * 3];
    sub[i * 3 + 1] = idx[t * 3 + 1];
    sub[i * 3 + 2] = idx[t * 3 + 2];
  });
  const bvh = buildBVH({ positions: p, indices: sub });
  // A peça do lado 0 fica para onde a normal aponta; a do lado 1, para o outro lado.
  const into: Vec3 = side === 0 ? frame.normal : [-frame.normal[0], -frame.normal[1], -frame.normal[2]];
  const ray = new Ray();
  // 0 = fora da tampa, 1 = parede boa, 2 = fina.
  const cell = new Uint8Array(nx * ny);
  let minThickness = Infinity;
  const back = 0.05;
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const o = toWorld(frame, lo[0] + i * h, lo[1] + j * h, 0);
      ray.origin.set(o[0] - into[0] * back, o[1] - into[1] * back, o[2] - into[2] * back);
      ray.direction.set(into[0], into[1], into[2]);
      const hits = bvh.raycast(ray, DoubleSide).sort((a, b) => a.distance - b.distance);
      if (hits.length < 2 || g.cut[keep[hits[0].faceIndex ?? -1]] !== tag) continue;
      const thickness = hits[1].distance - hits[0].distance;
      minThickness = Math.min(minThickness, thickness);
      cell[j * nx + i] = thickness < minWall ? 2 : 1;
    }
  bvh.geometry.dispose();
  // Distância (em células) de cada célula fina até a célula não fina mais próxima: chanfro 3-4.
  const d = new Float64Array(nx * ny).fill(1e9);
  for (let k = 0; k < d.length; k++) if (cell[k] !== 2) d[k] = 0;
  const relax = (k: number, i: number, j: number, di: number, dj: number, w: number) => {
    const ii = i + di;
    const jj = j + dj;
    const v = ii < 0 || jj < 0 || ii >= nx || jj >= ny ? 0 : d[jj * nx + ii];
    if (v + w < d[k]) d[k] = v + w;
  };
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (!d[k]) continue;
      relax(k, i, j, -1, 0, 3);
      relax(k, i, j, 0, -1, 3);
      relax(k, i, j, -1, -1, 4);
      relax(k, i, j, 1, -1, 4);
    }
  for (let j = ny - 1; j >= 0; j--)
    for (let i = nx - 1; i >= 0; i--) {
      const k = j * nx + i;
      if (!d[k]) continue;
      relax(k, i, j, 1, 0, 3);
      relax(k, i, j, 0, 1, 3);
      relax(k, i, j, 1, 1, 4);
      relax(k, i, j, -1, 1, 4);
    }
  let worst = 0;
  for (let k = 0; k < d.length; k++) if (cell[k] === 2) worst = Math.max(worst, d[k]);
  // Distância em células ≈ d/3 (raio); a largura da região fina é o dobro.
  return { width: ((2 * worst) / 3) * h, minThickness };
}
