export type Vec2 = [number, number];
export type Vec3 = [number, number, number];
/** Matriz 4x4 em ordem column-major (mesma convenção do Manifold e do three.js). */
export type Mat4 = [
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
];

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);

export function normalize(a: Vec3): Vec3 {
  const l = length(a);
  return l > 1e-20 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 1];
}

/**
 * Referencial ortonormal de um plano. `normal` aponta para o lado "frontal" (positivo) do corte;
 * `u × v = normal`, então polígonos CCW em (u, v) têm a normal do plano como frente.
 */
export interface PlaneFrame {
  origin: Vec3;
  normal: Vec3;
  u: Vec3;
  v: Vec3;
}

export function frameFromNormal(origin: Vec3, normal: Vec3, hintU?: Vec3): PlaneFrame {
  const n = normalize(normal);
  const project = (r: Vec3): Vec3 => normalize(sub(r, scale(n, dot(r, n))));
  let u: Vec3;
  let v: Vec3;
  if (hintU && Math.abs(dot(normalize(hintU), n)) < 0.999) {
    u = project(hintU);
    v = cross(n, u);
  } else if (Math.abs(n[2]) < 0.9) {
    // Plano em pé: v aponta para "cima" (Z do mundo), deixando o editor 2D com leitura natural.
    v = project([0, 0, 1]);
    u = cross(v, n);
  } else {
    // Plano deitado: u acompanha o X do mundo.
    u = project([1, 0, 0]);
    v = cross(n, u);
  }
  return { origin: [...origin] as Vec3, normal: n, u, v };
}

export function toLocal(f: PlaneFrame, p: Vec3): Vec3 {
  const d = sub(p, f.origin);
  return [dot(d, f.u), dot(d, f.v), dot(d, f.normal)];
}

export function toWorld(f: PlaneFrame, x: number, y: number, z: number): Vec3 {
  return [
    f.origin[0] + f.u[0] * x + f.v[0] * y + f.normal[0] * z,
    f.origin[1] + f.u[1] * x + f.v[1] * y + f.normal[1] * z,
    f.origin[2] + f.u[2] * x + f.v[2] * y + f.normal[2] * z,
  ];
}

/** Matriz local→mundo (colunas u, v, n, origem). */
export function frameToWorldMatrix(f: PlaneFrame): Mat4 {
  const { u, v, normal: n, origin: o } = f;
  return [u[0], u[1], u[2], 0, v[0], v[1], v[2], 0, n[0], n[1], n[2], 0, o[0], o[1], o[2], 1];
}

/** Matriz mundo→local (inversa de uma transformação rígida). */
export function worldToFrameMatrix(f: PlaneFrame): Mat4 {
  const { u, v, normal: n, origin: o } = f;
  return [
    u[0], v[0], n[0], 0,
    u[1], v[1], n[1], 0,
    u[2], v[2], n[2], 0,
    -dot(u, o), -dot(v, o), -dot(n, o), 1,
  ];
}

export function identity(): Mat4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

export function multiply(a: Mat4, b: Mat4): Mat4 {
  const r = new Array(16).fill(0) as Mat4;
  for (let c = 0; c < 4; c++)
    for (let row = 0; row < 4; row++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + row] * b[c * 4 + k];
      r[c * 4 + row] = s;
    }
  return r;
}

export function translation(x: number, y: number, z: number): Mat4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
}

export function scaling(s: number): Mat4 {
  return [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, 0, 0, 0, 1];
}

/** Rotação em torno de um eixo unitário (graus). */
export function rotationAxisAngle(axis: Vec3, degrees: number): Mat4 {
  const [x, y, z] = normalize(axis);
  const a = (degrees * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const t = 1 - c;
  return [
    t * x * x + c, t * x * y + s * z, t * x * z - s * y, 0,
    t * x * y - s * z, t * y * y + c, t * y * z + s * x, 0,
    t * x * z + s * y, t * y * z - s * x, t * z * z + c, 0,
    0, 0, 0, 1,
  ];
}

/** Rotação mínima que leva o vetor unitário `from` até `to`. */
export function rotationBetween(from: Vec3, to: Vec3): Mat4 {
  const f = normalize(from);
  const t = normalize(to);
  const c = dot(f, t);
  if (c > 1 - 1e-12) return identity();
  if (c < -1 + 1e-12) {
    const axis = Math.abs(f[0]) < 0.9 ? cross(f, [1, 0, 0]) : cross(f, [0, 1, 0]);
    return rotationAxisAngle(axis, 180);
  }
  const axis = cross(f, t);
  return rotationAxisAngle(axis, (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI);
}

export function transformPoint(m: Mat4, p: Vec3): Vec3 {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}

export function transformDirection(m: Mat4, d: Vec3): Vec3 {
  return [
    m[0] * d[0] + m[4] * d[1] + m[8] * d[2],
    m[1] * d[0] + m[5] * d[1] + m[9] * d[2],
    m[2] * d[0] + m[6] * d[1] + m[10] * d[2],
  ];
}

/** Autovalores/autovetores de uma matriz simétrica 3x3 (Jacobi). Autovalores em ordem crescente. */
export function symmetricEigen3(m: number[]): { values: Vec3; vectors: [Vec3, Vec3, Vec3] } {
  const a = [
    [m[0], m[1], m[2]],
    [m[1], m[4], m[5]],
    [m[2], m[5], m[8]],
  ];
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let sweep = 0; sweep < 50; sweep++) {
    const off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
    if (off < 1e-14) break;
    for (let p = 0; p < 2; p++)
      for (let q = p + 1; q < 3; q++) {
        if (Math.abs(a[p][q]) < 1e-18) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < 3; k++) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < 3; k++) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 3; k++) {
          const vkp = v[k][p];
          const vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
  }
  const order = [0, 1, 2].sort((i, j) => a[i][i] - a[j][j]);
  const values = order.map((i) => a[i][i]) as Vec3;
  const vectors = order.map((i) => normalize([v[0][i], v[1][i], v[2][i]])) as [Vec3, Vec3, Vec3];
  return { values, vectors };
}

export interface PlaneFit {
  centroid: Vec3;
  /** Normal de menor variância (orientação arbitrária). */
  normal: Vec3;
  /** Eixos principais em ordem decrescente de extensão. */
  axes: [Vec3, Vec3, Vec3];
  /** Desvio máximo dos pontos em relação ao plano ajustado. */
  maxDeviation: number;
  /** Raio médio dos pontos em torno do centróide, medido no plano. */
  radius: number;
}

/** Ajuste de plano por mínimos quadrados (PCA) sobre pontos xyz intercalados. */
export function fitPlane(points: ArrayLike<number>, count = points.length / 3): PlaneFit {
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let i = 0; i < count; i++) {
    cx += points[i * 3];
    cy += points[i * 3 + 1];
    cz += points[i * 3 + 2];
  }
  cx /= count;
  cy /= count;
  cz /= count;
  const cov = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < count; i++) {
    const x = points[i * 3] - cx;
    const y = points[i * 3 + 1] - cy;
    const z = points[i * 3 + 2] - cz;
    cov[0] += x * x;
    cov[1] += x * y;
    cov[2] += x * z;
    cov[4] += y * y;
    cov[5] += y * z;
    cov[8] += z * z;
  }
  cov[3] = cov[1];
  cov[6] = cov[2];
  cov[7] = cov[5];
  const { vectors } = symmetricEigen3(cov);
  const normal = vectors[0];
  const centroid: Vec3 = [cx, cy, cz];
  let maxDeviation = 0;
  let radius = 0;
  for (let i = 0; i < count; i++) {
    const d: Vec3 = [points[i * 3] - cx, points[i * 3 + 1] - cy, points[i * 3 + 2] - cz];
    const h = dot(d, normal);
    maxDeviation = Math.max(maxDeviation, Math.abs(h));
    radius += Math.sqrt(Math.max(0, dot(d, d) - h * h));
  }
  return {
    centroid,
    normal,
    axes: [vectors[2], vectors[1], vectors[0]],
    maxDeviation,
    radius: radius / Math.max(1, count),
  };
}

/** Normal de Newell de um polígono 3D fechado (comprimento = 2 × área). */
export function newellNormal(points: Vec3[]): Vec3 {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return [nx, ny, nz];
}

export function polygonArea2D(poly: Vec2[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
