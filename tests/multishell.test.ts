import type { Manifold } from "manifold-3d";
import { beforeAll, describe, expect, it } from "vitest";
import { cleanLabels, labelIslands } from "../src/core/labels";
import { GeometryError, type Wasm, getManifold } from "../src/core/manifoldBridge";
import { frameFromNormal } from "../src/core/math";
import { type IndexedMesh, computeBounds, faceComponents, faceNeighbors, faceNormalsAndAreas, mergeMeshes, signedVolume, triCount } from "../src/core/mesh";
import { geometryFromMesh } from "../src/core/part";
import { buildSampleFigure } from "../src/core/sample";
import { cutByPlane, splitByRegions, wasmTriangulator } from "../src/core/split";
import { describeReport, verifyCut } from "../src/core/verify";

/**
 * Arquivos com várias cascas (projetos multipartes, acessórios e detalhes modelados à parte, vários
 * objetos na mesma mesa): cada sólido é tratado sozinho, sem booleanas nas cascas que não precisam de
 * corte, e nada do arquivo é perdido nem deformado.
 */

let w: Wasm;
beforeAll(async () => {
  w = await getManifold();
});

const meshOf = (m: Manifold): IndexedMesh => {
  const mesh = m.getMesh();
  m.delete();
  return { positions: Float32Array.from(mesh.vertProperties), indices: Uint32Array.from(mesh.triVerts) };
};

interface Scene {
  mesh: IndexedMesh;
  /** Faixa de faces de cada casca, pelo nome. */
  range: Map<string, [number, number]>;
}

/** Monta um arquivo com várias cascas soltas (sem unir nada), como vem de um 3MF multipartes. */
function scene(shells: [string, IndexedMesh][]): Scene {
  const range = new Map<string, [number, number]>();
  let at = 0;
  for (const [name, m] of shells) {
    range.set(name, [at, at + triCount(m)]);
    at += triCount(m);
  }
  return { mesh: mergeMeshes(shells.map(([, m]) => m)), range };
}

/**
 * Boneco com chapéu, como um projeto multipartes: corpo (tronco + cabeça numa casca), chapéu com folga
 * de 0,2 mm da cabeça, logotipo cravado no chapéu (e um detalhe cravado só no logotipo), olho com folga
 * de 0,1 mm da cabeça, tatuagem fina cravada no tronco, um objeto oco e uma caixa longe dali (outro
 * objeto do projeto).
 */
function hattedFigure(): Scene {
  const { Manifold } = w;
  const body = Manifold.union([Manifold.cylinder(20, 8, 8, 48), Manifold.sphere(8, 48).translate([0, 0, 26])]);
  const hat = Manifold.union([
    Manifold.cylinder(1.5, 14, 14, 64).translate([0, 0, 34.2]),
    Manifold.cylinder(8, 8.5, 8, 64).translate([0, 0, 35.2]),
  ]);
  const hollow = Manifold.sphere(6, 32).subtract(Manifold.sphere(3, 24)).translate([-60, 0, 10]);
  return scene([
    ["corpo", meshOf(body)],
    ["chapeu", meshOf(hat)],
    // Logotipo: placa fina cravada na lateral da copa (atravessa a superfície do chapéu).
    ["logo", meshOf(Manifold.cube([4, 1, 4], true).translate([0, -8.4, 39.2]))],
    // Detalhe do logotipo: encosta só no logotipo, não no chapéu.
    ["logo-olho", meshOf(Manifold.cube([1, 0.6, 1], true).translate([0, -9.1, 39.7]))],
    // Olho com folga: modelado à parte, não encosta na cabeça.
    ["olho", meshOf(Manifold.sphere(1.5, 24).translate([0, -9.6, 26]))],
    // Tatuagem: lâmina de 0,3 mm cravada no tronco (fina de propósito).
    ["tatuagem", meshOf(Manifold.cube([5, 0.3, 5], true).translate([0, -7.95, 10]))],
    ["oco", meshOf(hollow)],
    ["caixa", meshOf(Manifold.cube([10, 10, 10], true).translate([60, 0, 5]))],
  ]);
}

function labelsFor(s: Scene, paint: (name: string, face: number) => number): Uint16Array {
  const labels = new Uint16Array(triCount(s.mesh));
  for (const [name, [a, b]] of s.range) for (let f = a; f < b; f++) labels[f] = paint(name, f);
  return labels;
}

function run(s: Scene, labels: Uint16Array, separate: number[], progress?: (f: number) => void) {
  const g = geometryFromMesh(s.mesh);
  const res = splitByRegions(
    w,
    { geometry: g, labels, separate, baseLabel: 0, mode: "auto", firstCutId: 1 },
    wasmTriangulator(w),
    progress ? (f) => progress(f) : undefined,
  );
  const part = (label: number) => res.parts.find((p) => p.label === label)?.geometry;
  /** Cascas do arquivo (pelo nome) presentes numa peça, pela origem dos triângulos. */
  const shellsIn = (label: number) => {
    const g2 = part(label);
    const names = new Set<string>();
    if (!g2) return names;
    for (let t = 0; t < g2.src.length; t++)
      for (const [name, [a, b]] of s.range) if (g2.src[t] >= a && g2.src[t] < b) names.add(name);
    return names;
  };
  /** Triângulos de uma casca do arquivo que chegaram intactos (mesma origem) numa peça. */
  const facesFrom = (label: number, name: string) => {
    const [a, b] = s.range.get(name)!;
    const g2 = part(label);
    let k = 0;
    if (g2) for (let t = 0; t < g2.src.length; t++) if (g2.src[t] >= a && g2.src[t] < b) k++;
    return k;
  };
  return { g, res, part, shellsIn, facesFrom };
}

const shellVolume = (s: Scene, name: string) => {
  const [a, b] = s.range.get(name)!;
  return signedVolume({ positions: s.mesh.positions, indices: s.mesh.indices.slice(a * 3, b * 3) });
};

describe("arquivos com várias cascas", () => {
  it("casca pintada inteira vira peça sem booleanas e leva o acessório cravado nela", () => {
    const s = hattedFigure();
    const labels = labelsFor(s, (name) => (name === "chapeu" ? 1 : 0));
    const { res, part, shellsIn, facesFrom } = run(s, labels, [1]);
    expect(res.parts.map((p) => p.label).sort()).toEqual([0, 1]);
    // Chapéu com o logotipo e o detalhe do logotipo (cravados nele), nada mais.
    expect([...shellsIn(1)].sort()).toEqual(["chapeu", "logo", "logo-olho"]);
    // O olho tem folga da cabeça e do chapéu; tatuagem, objeto oco e caixa são do corpo.
    expect([...shellsIn(0)].sort()).toEqual(["caixa", "corpo", "oco", "olho", "tatuagem"]);
    // Sem booleanas: cada casca chega inteira, triângulo por triângulo, e nenhum corte foi feito.
    for (const name of ["chapeu", "logo", "logo-olho"]) {
      const [a, b] = s.range.get(name)!;
      expect(facesFrom(1, name)).toBe(b - a);
    }
    for (const name of ["corpo", "olho", "tatuagem", "oco", "caixa"]) {
      const [a, b] = s.range.get(name)!;
      expect(facesFrom(0, name)).toBe(b - a);
    }
    expect(res.cuts).toHaveLength(0);
    // Volume conservado exatamente (as cascas não foram unidas nem recortadas).
    const total = signedVolume(s.mesh);
    expect(signedVolume(part(0)!.mesh) + signedVolume(part(1)!.mesh)).toBeCloseTo(total, 6);
    expect(res.islands.some((i) => i.label === 1 && /casca\(s\) solta\(s\)/.test(i.message ?? ""))).toBe(true);
  });

  it("pintura parcial corta só a casca pintada; as outras cascas não são tocadas", () => {
    const s = hattedFigure();
    // Só a copa do chapéu (acima da aba) é pintada.
    const c = s.mesh.positions;
    const idx = s.mesh.indices;
    const labels = labelsFor(s, (name, f) => {
      if (name !== "chapeu") return 0;
      const z = (c[idx[f * 3] * 3 + 2] + c[idx[f * 3 + 1] * 3 + 2] + c[idx[f * 3 + 2] * 3 + 2]) / 3;
      return z > 35.8 ? 1 : 0;
    });
    const { g, res, part, shellsIn, facesFrom } = run(s, labels, [1]);
    expect(res.islands.filter((i) => i.method === "falhou")).toHaveLength(0);
    expect(res.cuts.length).toBeGreaterThan(0);
    // A copa sai com o logotipo (cravado nela); a aba fica com o corpo.
    expect(shellsIn(1).has("logo")).toBe(true);
    expect(shellsIn(0).has("chapeu")).toBe(true);
    const crown = computeBounds(part(1)!.mesh.positions);
    expect(crown.min[2]).toBeGreaterThan(35.6);
    // As cascas que não tinham pintura chegam intactas.
    for (const name of ["corpo", "olho", "tatuagem", "oco", "caixa"]) {
      const [a, b] = s.range.get(name)!;
      expect(facesFrom(0, name)).toBe(b - a);
    }
    // A tatuagem fina (0,3 mm) não é tratada como lasca de corte.
    expect(signedVolume(part(0)!.mesh) + signedVolume(part(1)!.mesh)).toBeCloseTo(signedVolume(s.mesh), 2);
    const report = verifyCut(w, {
      original: g,
      parts: res.parts.map((p) => ({ name: `r${p.label}`, geometry: p.geometry })),
      cuts: res.cuts,
      allowMultipleSolids: true,
    });
    const errors = report.checks.filter((x) => !x.ok && x.severity === "erro");
    expect(errors, describeReport(report).join("\n")).toHaveLength(0);
  });

  it("objeto oco pintado por fora vai inteiro, com a cavidade", () => {
    const s = hattedFigure();
    const [a, b] = s.range.get("oco")!;
    // Só as faces da casca externa (as da cavidade ficam sem pintura: ninguém as vê).
    const nb = faceNeighbors(s.mesh);
    const { comp } = faceComponents(s.mesh, nb);
    let outer = -1;
    let best = -Infinity;
    for (let f = a; f < b; f++) {
      const z = s.mesh.positions[s.mesh.indices[f * 3] * 3 + 2];
      if (z > best) {
        best = z;
        outer = comp[f];
      }
    }
    const labels = labelsFor(s, (_, f) => (f >= a && f < b && comp[f] === outer ? 2 : 0));
    const { res, part } = run(s, labels, [2]);
    expect(res.cuts).toHaveLength(0);
    const g = part(2)!;
    expect(triCount(g.mesh)).toBe(b - a);
    expect(faceComponents(g.mesh).count).toBe(2);
    expect(signedVolume(g.mesh)).toBeCloseTo(shellVolume(s, "oco"), 6);
  });

  it("um pedestal sem pintura cravado na peça pintada continua sendo o corpo principal", () => {
    const { Manifold } = w;
    const s = scene([
      ["figura", meshOf(Manifold.union([Manifold.cylinder(20, 6, 6, 32), Manifold.sphere(7, 32).translate([0, 0, 24])]))],
      ["pedestal", meshOf(Manifold.cylinder(4, 12, 12, 48).translate([0, 0, -2]))],
    ]);
    const labels = labelsFor(s, (name) => (name === "figura" ? 1 : 0));
    const { shellsIn } = run(s, labels, [1]);
    expect([...shellsIn(0)]).toEqual(["pedestal"]);
    expect([...shellsIn(1)]).toEqual(["figura"]);
  });

  it("acessório cravado no corpo e na região separada fica com o corpo", () => {
    const { Manifold } = w;
    const base = hattedFigure();
    // Alça que atravessa a aba do chapéu e entra na cabeça (sem encostar no logotipo).
    const strap = meshOf(Manifold.cube([1, 1, 12], true).translate([0, -7.6, 30]));
    const s = scene([...[...base.range.keys()].map((name) => {
      const [a, b] = base.range.get(name)!;
      return [name, { positions: base.mesh.positions, indices: base.mesh.indices.slice(a * 3, b * 3) }] as [string, IndexedMesh];
    }), ["alca", strap]]);
    const labels = labelsFor(s, (name) => (name === "chapeu" ? 1 : 0));
    const { shellsIn } = run(s, labels, [1]);
    expect(shellsIn(0).has("alca")).toBe(true);
    expect(shellsIn(1).has("logo")).toBe(true);
  });

  it("casca dividida entre duas regiões, sem nada do corpo, não vira corpo", () => {
    const s = hattedFigure();
    const c = s.mesh.positions;
    const idx = s.mesh.indices;
    const labels = labelsFor(s, (name, f) => {
      if (name !== "chapeu") return 0;
      const z = (c[idx[f * 3] * 3 + 2] + c[idx[f * 3 + 1] * 3 + 2] + c[idx[f * 3 + 2] * 3 + 2]) / 3;
      return z > 35.8 ? 1 : 2;
    });
    const { res, shellsIn, part } = run(s, labels, [1, 2]);
    expect(res.islands.filter((i) => i.method === "falhou")).toHaveLength(0);
    expect(shellsIn(0).has("chapeu")).toBe(false);
    expect(shellsIn(1).has("chapeu")).toBe(true);
    expect(shellsIn(2).has("chapeu")).toBe(true);
    // Aba (topo em z = 35,7) e copa separadas perto da junção pintada.
    expect(computeBounds(part(2)!.mesh.positions).max[2]).toBeLessThan(37.5);
    expect(computeBounds(part(1)!.mesh.positions).min[2]).toBeGreaterThan(35.6);
  });

  it("informa o andamento do começo ao fim", () => {
    const s = hattedFigure();
    const c = s.mesh.positions;
    const idx = s.mesh.indices;
    const labels = labelsFor(s, (name, f) => (name === "chapeu" && c[idx[f * 3] * 3 + 2] > 35.8 ? 1 : 0));
    const seen: number[] = [];
    run(s, labels, [1], (f) => seen.push(f));
    expect(seen.length).toBeGreaterThan(1);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    expect(seen[seen.length - 1]).toBe(1);
  });
});

describe("limpeza da pintura", () => {
  it("não deixa ilhas de uma face depois de suavizar a fronteira", () => {
    const fig = buildSampleFigure(w, 48);
    const n = triCount(fig);
    const nb = faceNeighbors(fig);
    const { areas } = faceNormalsAndAreas(fig);
    let total = 0;
    for (let f = 0; f < n; f++) total += areas[f];
    // Fronteira serrilhada: faixa em xadrez em volta de z = 60 (como uma pintura feita a pincel).
    const labels = new Uint16Array(n);
    const p = fig.positions;
    for (let f = 0; f < n; f++) {
      const z = p[fig.indices[f * 3] * 3 + 2];
      labels[f] = z > 62 ? 1 : z > 58 ? f % 2 : 0;
    }
    const opts = { minIslandArea: total * 0.001, minIslandFaces: 8, smoothIterations: 3 };
    const out = cleanLabels(labels, nb, areas, opts);
    const { islands } = labelIslands(out, nb, areas);
    const tiny = islands.filter((i) => i.faces.length < opts.minIslandFaces);
    expect(tiny).toHaveLength(0);
  });
});

describe("corte por plano com várias cascas", () => {
  /** Cascas do arquivo presentes numa geometria, pela origem dos triângulos. */
  const shellsOf = (s: Scene, g: { src: Int32Array }) => {
    const names = new Set<string>();
    for (let t = 0; t < g.src.length; t++)
      for (const [name, [a, b]] of s.range) if (g.src[t] >= a && g.src[t] < b) names.add(name);
    return names;
  };
  const intact = (s: Scene, g: { src: Int32Array }, name: string) => {
    const [a, b] = s.range.get(name)!;
    let k = 0;
    for (let t = 0; t < g.src.length; t++) if (g.src[t] >= a && g.src[t] < b) k++;
    return k === b - a;
  };

  it("só corta as cascas que o plano atravessa", () => {
    const s = hattedFigure();
    const g = geometryFromMesh(s.mesh);
    // Plano horizontal na copa do chapéu (z = 36,5), abaixo do logotipo: a cabeça termina em z = 34.
    // (Um plano que atravessa cascas cravadas uma na outra deixa as tampas delas sobrepostas, como
    // as próprias cascas já estavam no arquivo.)
    const frame = frameFromNormal([0, 0, 36.5], [0, 0, 1]);
    const { front, back } = cutByPlane(w, g, frame, 1, false);
    expect(front).toHaveLength(1);
    expect(back).toHaveLength(1);
    expect([...shellsOf(s, front[0])].sort()).toEqual(["chapeu", "logo", "logo-olho"]);
    for (const name of ["corpo", "olho", "tatuagem", "oco", "caixa"]) expect(intact(s, back[0], name)).toBe(true);
    const report = verifyCut(w, {
      original: g,
      parts: [
        { name: "frente", geometry: front[0] },
        { name: "verso", geometry: back[0] },
      ],
      cuts: [{ id: 1, kind: "plane", frame }],
      allowMultipleSolids: true,
    });
    const errors = report.checks.filter((x) => !x.ok && x.severity === "erro");
    expect(errors, describeReport(report).join("\n")).toHaveLength(0);
  });

  it("um plano entre dois objetos separa os objetos sem cortar nada", () => {
    const s = hattedFigure();
    const g = geometryFromMesh(s.mesh);
    const { front, back } = cutByPlane(w, g, frameFromNormal([30, 0, 0], [1, 0, 0]), 1, false);
    expect([...shellsOf(s, front[0])]).toEqual(["caixa"]);
    expect(intact(s, front[0], "caixa")).toBe(true);
    expect(front[0].cut.every((c) => c < 0)).toBe(true);
    expect(back[0].cut.every((c) => c < 0)).toBe(true);
    expect(triCount(front[0].mesh) + triCount(back[0].mesh)).toBe(triCount(s.mesh));
  });

  it("um plano que não toca nada avisa que não atravessa a peça", () => {
    const s = hattedFigure();
    expect(() => cutByPlane(w, geometryFromMesh(s.mesh), frameFromNormal([200, 0, 0], [1, 0, 0]), 1, false)).toThrow(GeometryError);
  });
});
