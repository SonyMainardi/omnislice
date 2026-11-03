import type { Manifold } from "manifold-3d";
import type { Wasm } from "../src/core/manifoldBridge";
import { type IndexedMesh, faceCentroids, mergeMeshes, triCount } from "../src/core/mesh";

/**
 * Figuras de teste geradas com o Manifold, com o nome da primitiva de origem de cada face: dá para
 * "pintar" exatamente como uma pessoa pintaria (só o lado de fora de uma bota, o olho inteiro...).
 */
export interface Tracked {
  mesh: IndexedMesh;
  /** Primitiva de origem de cada face. */
  tag: string[];
}

export function tracked(build: (prim: (name: string, m: Manifold) => Manifold) => Manifold, refine = 0): Tracked {
  const names = new Map<number, string>();
  const prim = (name: string, m: Manifold) => {
    const o = m.asOriginal();
    m.delete();
    names.set(o.originalID(), name);
    return o;
  };
  let result = build(prim);
  if (refine > 0) {
    const r = result.refineToLength(refine);
    result.delete();
    result = r;
  }
  const mm = result.getMesh();
  result.delete();
  const tag: string[] = new Array(mm.numTri).fill("?");
  for (let r = 0; r < mm.numRun; r++) {
    const name = names.get(mm.runOriginalID[r]) ?? "?";
    for (let t = mm.runIndex[r] / 3; t < mm.runIndex[r + 1] / 3; t++) tag[t] = name;
  }
  return { mesh: { positions: Float32Array.from(mm.vertProperties), indices: Uint32Array.from(mm.triVerts) }, tag };
}

/** Várias cascas soltas no mesmo arquivo (sem unir), como um 3MF com a figura e a base. */
export function mergeTracked(list: Tracked[]): Tracked {
  return { mesh: mergeMeshes(list.map((t) => t.mesh)), tag: list.flatMap((t) => t.tag) };
}

/**
 * Perna com bota de cano dobrado em funil: pé de sola chata (z = 0), cano, funil de parede fina aberto
 * em cima e a perna entrando pelo meio do funil (o fundo do funil é um anel em volta da perna).
 */
function bootLeg(w: Wasm, prim: (name: string, m: Manifold) => Manifold, x: number): Manifold {
  const { Manifold } = w;
  const foot = prim(
    "pe",
    Manifold.hull([
      Manifold.cube([5, 5, 3]).translate([x - 2.5, -1.5, 0]),
      Manifold.cube([4.5, 6, 2.2]).translate([x - 2.25, -9, 0]),
      Manifold.sphere(4.2, 32).translate([x, 0.5, 6]),
    ]),
  );
  const shaft = prim("cano", Manifold.cylinder(8.5, 4.2, 4.3, 48).translate([x, 0.5, 4]));
  const outer = Manifold.cylinder(10, 4.4, 7.5, 64).translate([x, 0.5, 12]);
  const inner = prim("funil-dentro", Manifold.cylinder(10.2, 3.5, 6.7, 64).translate([x, 0.5, 12.9]));
  const funnel = prim("funil-fora", outer).subtract(inner);
  const leg = prim("perna", Manifold.cylinder(40, 3.0, 3.4, 48).translate([x, 0.5, 8]));
  return Manifold.union([foot, shaft, funnel, leg]);
}

/** Duas pernas com botas presas a um quadril, numa casca só (figura fundida). `lift` sobe tudo. */
export function bootsFigure(w: Wasm, lift = 0): Tracked {
  return tracked(
    (prim) => {
      const { Manifold } = w;
      const hip = prim("quadril", Manifold.cube([26, 12, 12]).translate([-13, -5.5, 46]));
      const u = Manifold.union([bootLeg(w, prim, -8.5), bootLeg(w, prim, 8.5), hip]);
      return lift ? u.translate([0, 0, lift]) : u;
    },
    0.45,
  );
}

/** Base redonda separada (outra casca), com o topo em z = 0. */
export function baseDisc(w: Wasm): Tracked {
  return tracked((prim) => prim("base", w.Manifold.cylinder(4, 22, 22, 96).translate([0, 0, -4])), 0.8);
}

/**
 * Cabeça com um olho de anime: o olho é uma concavidade rasa (0,7 mm) e a íris um relevo no meio dela
 * que sobe um pouco acima da pele em volta (um plano pela borda só pegaria a íris).
 */
export function eyeHead(w: Wasm): Tracked {
  return tracked(
    (prim) => {
      const { Manifold } = w;
      const R = 14;
      const l = Math.hypot(0, -1, 0.1);
      const at = (r: number): [number, number, number] => [0, (-1 / l) * r, (0.1 / l) * r];
      const head = prim("cabeca", Manifold.sphere(R, 96));
      const dish = prim("olho", Manifold.sphere(1, 48).scale([3.2, 1.6, 3.8]).translate(at(R + 1.6 - 0.7)));
      const iris = prim("iris", Manifold.sphere(1, 48).scale([1.4, 0.9, 1.7]).translate(at(R - 0.7 + 0.15)));
      const neck = prim("pescoco", Manifold.cylinder(12, 6, 6, 48).translate([0, 0, -R - 8]));
      return Manifold.union([head.subtract(dish), iris, neck]);
    },
    0.25,
  );
}

/** Rótulo 1 nas faces das primitivas dadas (opcionalmente só onde `where` vale, pelo centro da face). */
export function paint(t: Tracked, names: string[], where?: (c: [number, number, number]) => boolean): Uint16Array {
  const labels = new Uint16Array(triCount(t.mesh));
  const c = faceCentroids(t.mesh);
  for (let f = 0; f < labels.length; f++)
    if (names.includes(t.tag[f]) && (!where || where([c[f * 3], c[f * 3 + 1], c[f * 3 + 2]]))) labels[f] = 1;
  return labels;
}
