import {
  type Mat4,
  type Vec3,
  identity,
  multiply,
  rotationAxisAngle,
  rotationBetween,
  transformPoint,
  translation,
} from "./math";
import { computeBounds, faceNormalsAndAreas, triCount } from "./mesh";
import type { PartGeometry } from "./part";

export interface BedSpec {
  id: string;
  name: string;
  size: Vec3;
  tech: "fdm" | "resina";
}

/** Volumes de impressão de referência (mm). Confira sempre no manual da sua impressora. */
export const bedPresets: BedSpec[] = [
  { id: "bambu-a1", name: "Bambu Lab A1", size: [256, 256, 256], tech: "fdm" },
  { id: "bambu-a1-mini", name: "Bambu Lab A1 mini", size: [180, 180, 180], tech: "fdm" },
  { id: "bambu-p1s", name: "Bambu Lab P1S / X1C", size: [256, 256, 256], tech: "fdm" },
  { id: "prusa-mk4", name: "Prusa MK4 / MK4S", size: [250, 210, 220], tech: "fdm" },
  { id: "prusa-mini", name: "Prusa MINI+", size: [180, 180, 180], tech: "fdm" },
  { id: "ender3-v3", name: "Creality Ender-3 V3", size: [220, 220, 250], tech: "fdm" },
  { id: "creality-k1", name: "Creality K1 / K1C", size: [220, 220, 250], tech: "fdm" },
  { id: "creality-k1-max", name: "Creality K1 Max", size: [300, 300, 300], tech: "fdm" },
  { id: "elegoo-saturn4-ultra", name: "Elegoo Saturn 4 Ultra (resina)", size: [218.88, 122.88, 220], tech: "resina" },
  { id: "anycubic-m7", name: "Anycubic Photon Mono M7 (resina)", size: [223, 126, 230], tech: "resina" },
  { id: "custom", name: "Personalizada", size: [220, 220, 250], tech: "fdm" },
];

export interface OrientationChoice {
  /** Rotação (sem translação) aplicada à peça para imprimir. */
  rotation: Mat4;
  reason: string;
  size: Vec3;
}

function rotatedBounds(g: PartGeometry, m: Mat4): { min: Vec3; max: Vec3 } {
  const p = g.mesh.positions;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) {
    const q = transformPoint(m, [p[i], p[i + 1], p[i + 2]]);
    for (let k = 0; k < 3; k++) {
      if (q[k] < min[k]) min[k] = q[k];
      if (q[k] > max[k]) max[k] = q[k];
    }
  }
  return { min, max };
}

/** Casco convexo 2D (monotone chain) da projeção XY, usado para girar a peça na mesa. */
function hull2D(points: [number, number][]): [number, number][] {
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: [number, number][] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

/**
 * Escolhe como a peça vai para a mesa: de preferência apoiada na maior face de corte plana
 * (que não tenha pino saindo dela); senão, mantém a orientação original.
 */
export function chooseOrientation(g: PartGeometry, maleTags: Set<number>, bed?: Vec3, fixed?: Mat4): OrientationChoice {
  const { normals, areas } = faceNormalsAndAreas(g.mesh);
  const caps = new Map<number, { area: number; n: Vec3 }>();
  for (let t = 0; t < g.cut.length; t++) {
    const tag = g.cut[t];
    if (tag < 0) continue;
    let c = caps.get(tag);
    if (!c) caps.set(tag, (c = { area: 0, n: [0, 0, 0] }));
    c.area += areas[t];
    for (let k = 0; k < 3; k++) c.n[k] += normals[t * 3 + k] * areas[t];
  }
  // Área plana já apoiada na mesa na orientação original.
  const b = computeBounds(g.mesh.positions);
  let bottom = 0;
  for (let t = 0; t < triCount(g.mesh); t++) {
    if (normals[t * 3 + 2] > -0.985) continue;
    const z = g.mesh.positions[g.mesh.indices[t * 3] * 3 + 2];
    if (z - b.min[2] < 0.3) bottom += areas[t];
  }
  let best: { rotation: Mat4; score: number; reason: string } = {
    rotation: identity(),
    score: bottom,
    reason: bottom > 0 ? "Mantida a base original apoiada na mesa." : "Orientação original.",
  };
  for (const [tag, cap] of fixed ? [] : caps) {
    const len = Math.hypot(...cap.n);
    // Tampas de corte plano têm normal média com comprimento ≈ área; tampas curvas, bem menos.
    if (len < cap.area * 0.97) continue;
    const male = maleTags.has(tag);
    const score = cap.area * (male ? 0.05 : 1.1);
    if (score > best.score) {
      const nrm: Vec3 = [cap.n[0] / len, cap.n[1] / len, cap.n[2] / len];
      best = {
        rotation: rotationBetween(nrm, [0, 0, -1]),
        score,
        reason: male ? "Apoiada na face com pino (precisa de suporte)." : "Apoiada na face de corte plana.",
      };
    }
  }
  // Orientação escolhida pelo usuário (giros de 90°) substitui a automática.
  if (fixed) best = { rotation: fixed, score: 0, reason: "Orientação definida manualmente." };
  // Gira em torno de Z para a menor área ocupada na mesa.
  const p = g.mesh.positions;
  const step = Math.max(1, Math.floor(p.length / 3 / 20000));
  const xy: [number, number][] = [];
  for (let i = 0; i < p.length; i += 3 * step) {
    const q = transformPoint(best.rotation, [p[i], p[i + 1], p[i + 2]]);
    xy.push([q[0], q[1]]);
  }
  const hull = hull2D(xy);
  let bestAngle = 0;
  let bestArea = Infinity;
  let bestFits = false;
  for (let a = 0; a < 180; a += 3) {
    const c = Math.cos((a * Math.PI) / 180);
    const s = Math.sin((a * Math.PI) / 180);
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const [x, y] of hull) {
      const rx = c * x - s * y;
      const ry = s * x + c * y;
      minX = Math.min(minX, rx);
      maxX = Math.max(maxX, rx);
      minY = Math.min(minY, ry);
      maxY = Math.max(maxY, ry);
    }
    const w = maxX - minX;
    const h = maxY - minY;
    const fits = bed ? w <= bed[0] && h <= bed[1] : true;
    const area = w * h;
    // Prefere ângulos em que a peça cabe; entre eles, a menor área.
    if ((fits && !bestFits) || (fits === bestFits && area < bestArea - 1e-6)) {
      bestArea = area;
      bestAngle = a;
      bestFits = fits;
    }
  }
  const rotation = multiply(rotationAxisAngle([0, 0, 1], bestAngle), best.rotation);
  const rb = rotatedBounds(g, rotation);
  return {
    rotation,
    reason: best.reason,
    size: [rb.max[0] - rb.min[0], rb.max[1] - rb.min[1], rb.max[2] - rb.min[2]],
  };
}

export function fitsBed(size: Vec3, bed: Vec3, margin = 1): boolean {
  return size[0] <= bed[0] - margin && size[1] <= bed[1] - margin && size[2] <= bed[2] - margin;
}

export interface Placement {
  id: string;
  plate: number;
  /** Matriz completa: coordenadas do modelo → coordenadas da mesa (origem no canto da mesa). */
  matrix: Mat4;
  size: Vec3;
  fits: boolean;
  reason: string;
}

/** Distribui as peças orientadas em uma ou mais mesas (empacotamento por prateleiras). */
export function layoutPlates(
  parts: { id: string; geometry: PartGeometry; maleTags: Set<number>; rotation?: Mat4 }[],
  bed: Vec3,
  spacing = 6,
): { placements: Placement[]; plates: number } {
  const items = parts.map((p) => {
    const o = chooseOrientation(p.geometry, p.maleTags, bed, p.rotation);
    const rb = rotatedBounds(p.geometry, o.rotation);
    return { id: p.id, o, min: rb.min, size: o.size, fits: fitsBed(o.size, bed) };
  });
  const order = items
    .map((it, i) => ({ it, i }))
    .sort((a, b) => b.it.size[1] - a.it.size[1] || b.it.size[0] - a.it.size[0]);
  const placements: Placement[] = new Array(items.length);
  const place = (i: number, plate: number, px: number, py: number) => {
    const it = items[i];
    const matrix = multiply(translation(px - it.min[0], py - it.min[1], -it.min[2]), it.o.rotation);
    placements[i] = { id: it.id, plate, matrix, size: it.size, fits: it.fits, reason: it.o.reason };
  };
  let plate = 0;
  let x = spacing;
  let y = spacing;
  let shelf = 0;
  let used = false;
  for (const { it, i } of order) {
    if (!it.fits) continue;
    const [w, h] = it.size;
    if (x + w > bed[0] - spacing + 1e-6) {
      x = spacing;
      y += shelf + spacing;
      shelf = 0;
    }
    if (y + h > bed[1] - spacing + 1e-6 && used) {
      plate++;
      x = spacing;
      y = spacing;
      shelf = 0;
    }
    place(i, plate, x, y);
    x += w + spacing;
    shelf = Math.max(shelf, h);
    used = true;
  }
  // Peças maiores que a mesa ficam cada uma em uma mesa própria, centralizadas (precisam ser divididas).
  let next = used ? plate + 1 : 0;
  for (const { it, i } of order) {
    if (it.fits) continue;
    place(i, next++, (bed[0] - it.size[0]) / 2, (bed[1] - it.size[1]) / 2);
  }
  const plates = placements.reduce((m, p) => Math.max(m, p.plate + 1), 0);
  return { placements, plates };
}
