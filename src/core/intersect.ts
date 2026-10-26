/**
 * Cruzamento real entre dois triângulos: os dois atravessam o plano um do outro e o trecho em comum
 * tem comprimento. Encostar num vértice ou ao longo de uma aresta não é cruzar. Triângulos
 * coplanares contam quando se sobrepõem com área (faces repetidas ou dobradas).
 *
 * `eps` é a distância tratada como zero (o arredondamento das coordenadas).
 */
export function trianglesCross(p: ArrayLike<number>, t1: [number, number, number], q: ArrayLike<number>, t2: [number, number, number], eps: number): boolean {
  const A = [t1[0] * 3, t1[1] * 3, t1[2] * 3];
  const B = [t2[0] * 3, t2[1] * 3, t2[2] * 3];
  const n1 = normalOf(p, A);
  const n2 = normalOf(q, B);
  if (!n1 || !n2) return false;
  const d1 = n1[0] * p[A[0]] + n1[1] * p[A[0] + 1] + n1[2] * p[A[0] + 2];
  const d2 = n2[0] * q[B[0]] + n2[1] * q[B[0] + 1] + n2[2] * q[B[0] + 2];
  const s2 = B.map((v) => snap(n1[0] * q[v] + n1[1] * q[v + 1] + n1[2] * q[v + 2] - d1, eps));
  const s1 = A.map((v) => snap(n2[0] * p[v] + n2[1] * p[v + 1] + n2[2] * p[v + 2] - d2, eps));
  if (s1.every((s) => s === 0) && s2.every((s) => s === 0)) return coplanarOverlap(p, A, q, B, n1, eps);
  const crosses = (s: number[]) => s.some((x) => x > 0) && s.some((x) => x < 0);
  if (!crosses(s1) || !crosses(s2)) return false;
  // Trechos de cada triângulo sobre a reta comum aos dois planos; cruzam se os trechos se sobrepõem.
  const dir = [n1[1] * n2[2] - n1[2] * n2[1], n1[2] * n2[0] - n1[0] * n2[2], n1[0] * n2[1] - n1[1] * n2[0]];
  const len = Math.hypot(dir[0], dir[1], dir[2]);
  if (len < 1e-12) return false;
  const i1 = interval(p, A, s1, dir);
  const i2 = interval(q, B, s2, dir);
  const overlap = (Math.min(i1[1], i2[1]) - Math.max(i1[0], i2[0])) / len;
  return overlap > eps * 10;
}

function snap(x: number, eps: number): number {
  return Math.abs(x) <= eps ? 0 : x;
}

function normalOf(p: ArrayLike<number>, v: number[]): number[] | null {
  const ux = p[v[1]] - p[v[0]];
  const uy = p[v[1] + 1] - p[v[0] + 1];
  const uz = p[v[1] + 2] - p[v[0] + 2];
  const wx = p[v[2]] - p[v[0]];
  const wy = p[v[2] + 1] - p[v[0] + 1];
  const wz = p[v[2] + 2] - p[v[0] + 2];
  const n = [uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx];
  const l = Math.hypot(n[0], n[1], n[2]);
  return l > 1e-18 ? [n[0] / l, n[1] / l, n[2] / l] : null;
}

/** Intervalo (projetado em `dir`) do trecho do triângulo sobre o plano do outro. */
function interval(p: ArrayLike<number>, v: number[], s: number[], dir: number[]): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  const take = (x: number, y: number, z: number) => {
    const t = x * dir[0] + y * dir[1] + z * dir[2];
    lo = Math.min(lo, t);
    hi = Math.max(hi, t);
  };
  for (let k = 0; k < 3; k++) {
    const a = v[k];
    const b = v[(k + 1) % 3];
    if (s[k] === 0) take(p[a], p[a + 1], p[a + 2]);
    if ((s[k] > 0 && s[(k + 1) % 3] < 0) || (s[k] < 0 && s[(k + 1) % 3] > 0)) {
      const t = s[k] / (s[k] - s[(k + 1) % 3]);
      take(p[a] + (p[b] - p[a]) * t, p[a + 1] + (p[b + 1] - p[a + 1]) * t, p[a + 2] + (p[b + 2] - p[a + 2]) * t);
    }
  }
  return [lo, hi];
}

/** Sobreposição com área de dois triângulos no mesmo plano (recorte de Sutherland–Hodgman). */
function coplanarOverlap(p: ArrayLike<number>, A: number[], q: ArrayLike<number>, B: number[], n: number[], eps: number): boolean {
  // Projeta no plano de coordenadas mais aberto em relação à normal.
  const ax = Math.abs(n[0]);
  const ay = Math.abs(n[1]);
  const az = Math.abs(n[2]);
  const [i, j] = az >= ax && az >= ay ? [0, 1] : ay >= ax ? [2, 0] : [1, 2];
  const toPoly = (src: ArrayLike<number>, v: number[]) => v.map((x) => [src[x + i], src[x + j]] as [number, number]);
  const ccw = (poly: [number, number][]) => (area(poly) < 0 ? poly.reverse() : poly);
  let subject = ccw(toPoly(p, A));
  const clip = ccw(toPoly(q, B));
  for (let k = 0; k < 3 && subject.length; k++) {
    const a = clip[k];
    const b = clip[(k + 1) % 3];
    const side = (pt: [number, number]) => (b[0] - a[0]) * (pt[1] - a[1]) - (b[1] - a[1]) * (pt[0] - a[0]);
    const out: [number, number][] = [];
    for (let m = 0; m < subject.length; m++) {
      const c = subject[m];
      const d = subject[(m + 1) % subject.length];
      const sc = side(c);
      const sd = side(d);
      if (sc >= 0) out.push(c);
      if ((sc >= 0) !== (sd >= 0)) {
        const t = sc / (sc - sd);
        out.push([c[0] + (d[0] - c[0]) * t, c[1] + (d[1] - c[1]) * t]);
      }
    }
    subject = out;
  }
  return subject.length >= 3 && Math.abs(area(subject)) > eps * eps * 100;
}

function area(poly: [number, number][]): number {
  let s = 0;
  for (let k = 0; k < poly.length; k++) {
    const a = poly[k];
    const b = poly[(k + 1) % poly.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}
