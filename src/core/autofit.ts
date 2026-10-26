import { chooseOrientation, fitsBed } from "./layout";
import { Arena, RunRegistry, type Wasm } from "./manifoldBridge";
import { type Vec3, fitPlane, frameFromNormal, toWorld, worldToFrameMatrix } from "./math";
import type { PartGeometry } from "./part";
import { type CutRecord, cutByPlane } from "./split";

/** Eixo mais longo (PCA dos vértices) e a extensão da peça ao longo dele. */
function longestAxis(g: PartGeometry): { center: Vec3; axis: Vec3; min: number; max: number } {
  const fit = fitPlane(g.mesh.positions);
  const axis = fit.axes[0];
  let min = Infinity;
  let max = -Infinity;
  const p = g.mesh.positions;
  for (let i = 0; i < p.length; i += 3) {
    const t = (p[i] - fit.centroid[0]) * axis[0] + (p[i + 1] - fit.centroid[1]) * axis[1] + (p[i + 2] - fit.centroid[2]) * axis[2];
    min = Math.min(min, t);
    max = Math.max(max, t);
  }
  return { center: fit.centroid, axis, min, max };
}

/**
 * Divide uma peça até que cada pedaço caiba na mesa. Cada corte é perpendicular ao eixo mais longo,
 * na posição (entre 30% e 70%) com a menor seção transversal — o corte mais fácil de colar.
 */
export function autoFitSplit(
  w: Wasm,
  g: PartGeometry,
  bed: Vec3,
  firstCutId: number,
  maxPieces: number,
): { pieces: PartGeometry[]; cuts: CutRecord[]; nextCutId: number; fits: boolean } {
  const queue = [g];
  const done: PartGeometry[] = [];
  const cuts: CutRecord[] = [];
  let cutId = firstCutId;
  let fits = true;
  while (queue.length) {
    const piece = queue.shift()!;
    const o = chooseOrientation(piece, new Set(), bed);
    if (fitsBed(o.size, bed)) {
      done.push(piece);
      continue;
    }
    if (done.length + queue.length + 1 >= maxPieces) {
      fits = false;
      done.push(piece);
      continue;
    }
    const { center, axis, min, max } = longestAxis(piece);
    const base = frameFromNormal(center, axis);
    const reg = new RunRegistry(w);
    const arena = new Arena();
    let bestT = 0.5;
    try {
      const solid = arena.track(reg.fromGeometry(piece));
      const local = arena.track(solid.transform(worldToFrameMatrix(base)));
      let bestArea = Infinity;
      for (let t = 0.3; t <= 0.7001; t += 0.05) {
        const z = min + (max - min) * t;
        const cs = local.slice(z);
        // Leve preferência pelo meio para não gerar pedaços muito desiguais.
        const area = cs.area() * (1 + Math.abs(t - 0.5) * 0.6);
        cs.delete();
        if (area > 0 && area < bestArea) {
          bestArea = area;
          bestT = t;
        }
      }
    } finally {
      arena.dispose();
    }
    const frame = frameFromNormal(toWorld(base, 0, 0, min + (max - min) * bestT), axis);
    const { front, back } = cutByPlane(w, piece, frame, cutId, false);
    cuts.push({ id: cutId, kind: "plane", frame });
    cutId++;
    queue.push(...front, ...back);
  }
  return { pieces: done, cuts, nextCutId: cutId, fits };
}
