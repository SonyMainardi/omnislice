import { beforeAll, describe, expect, it } from "vitest";
import { analyzeMesh } from "../src/core/analysis";
import { applyConnectors, defaultConnectorSettings, planConnectors } from "../src/core/connectors";
import { RunRegistry, type Wasm, getManifold } from "../src/core/manifoldBridge";
import { frameFromNormal } from "../src/core/math";
import { type IndexedMesh, faceCentroids, signedVolume, triCount } from "../src/core/mesh";
import { geometryFromMesh } from "../src/core/part";
import { defaultRepairOptions, repairMesh } from "../src/core/repair";
import { buildBox, buildSampleFigure } from "../src/core/sample";
import { computeInterfaces, cutByPlane, splitByRegions, wasmTriangulator } from "../src/core/split";

let w: Wasm;
let figure: IndexedMesh;

beforeAll(async () => {
  w = await getManifold();
  figure = buildSampleFigure(w, 32);
});

function volumeOf(m: IndexedMesh) {
  return signedVolume(m);
}

describe("análise e reparo", () => {
  it("reconhece um cubo fechado", () => {
    const box = buildBox(w, [10, 20, 30]);
    const r = analyzeMesh(box);
    expect(r.watertight).toBe(true);
    expect(r.triangles).toBe(12);
    expect(r.volume).toBeCloseTo(6000, 3);
    expect(r.size).toEqual([10, 20, 30]);
    expect(r.issues[0].code).toBe("ok");
  });

  it("fecha um buraco e corrige faces invertidas", () => {
    const box = buildBox(w, [10, 10, 10]);
    // Remove um triângulo e inverte outro.
    const idx = Array.from(box.indices.slice(3));
    [idx[1], idx[2]] = [idx[2], idx[1]];
    const broken: IndexedMesh = { positions: box.positions, indices: Uint32Array.from(idx) };
    const before = analyzeMesh(broken);
    expect(before.holes).toBe(1);
    expect(before.inconsistentEdges).toBeGreaterThan(0);
    const fixed = repairMesh(broken, defaultRepairOptions, wasmTriangulator(w));
    const after = analyzeMesh(fixed.mesh);
    expect(after.watertight).toBe(true);
    expect(after.inconsistentEdges).toBe(0);
    expect(after.volume).toBeCloseTo(1000, 3);
    expect(fixed.faceMap.filter((f) => f < 0).length).toBe(1);
  });

  it("o boneco de exemplo é uma casca única e estanque", () => {
    const r = analyzeMesh(figure);
    expect(r.watertight).toBe(true);
    expect(r.components).toBe(1);
    expect(r.size[2]).toBeGreaterThan(95);
  });
});

describe("corte por plano", () => {
  it("divide o boneco na cintura em duas peças fechadas com interface", () => {
    const g = geometryFromMesh(figure);
    const total = volumeOf(figure);
    const frame = frameFromNormal([0, 0, 55], [0, 0, 1]);
    const { front, back } = cutByPlane(w, g, frame, 7, false);
    expect(front).toHaveLength(1);
    expect(back).toHaveLength(1);
    const sum = volumeOf(front[0].mesh) + volumeOf(back[0].mesh);
    expect(Math.abs(sum - total) / total).toBeLessThan(1e-4);
    for (const p of [...front, ...back]) expect(analyzeMesh(p.mesh).watertight).toBe(true);
    const ifaces = computeInterfaces(
      w,
      [
        { id: "a", geometry: front[0] },
        { id: "b", geometry: back[0] },
      ],
      [{ id: 7, kind: "plane", frame }],
    );
    // O plano corta o tronco e os dois braços: três ilhas na mesma interface.
    expect(ifaces).toHaveLength(1);
    expect(ifaces[0].front).toBe("a");
    expect(ifaces[0].polygons.length).toBeGreaterThanOrEqual(3);
    expect(ifaces[0].area).toBeGreaterThan(200);
  });

  it("separa pedaços soltos quando pedido", () => {
    const g = geometryFromMesh(figure);
    const frame = frameFromNormal([0, 0, 55], [0, 0, -1]);
    const { front } = cutByPlane(w, g, frame, 1, true);
    // Abaixo da cintura: corpo inferior + duas mãos.
    expect(front.length).toBe(3);
  });

  it("recusa um plano que não cruza a peça", () => {
    const g = geometryFromMesh(figure);
    expect(() => cutByPlane(w, g, frameFromNormal([0, 0, 500], [0, 0, 1]), 1, false)).toThrow(/não atravessa/);
  });
});

describe("divisão por regiões", () => {
  function paintFigure(mesh: IndexedMesh): Uint16Array {
    const c = faceCentroids(mesh);
    const labels = new Uint16Array(triCount(mesh));
    for (let f = 0; f < labels.length; f++) {
      const x = c[f * 3];
      const z = c[f * 3 + 2];
      if (z > 82.5) labels[f] = 1; // cabeça
      else if (x < -19 && z > 36) labels[f] = 2; // braço direito do boneco (−X)
      else if (x > 19 && z > 36) labels[f] = 3; // braço esquerdo
      else if (z < 6.2) labels[f] = 4; // base
    }
    return labels;
  }

  it("separa cabeça, braços e base em peças fechadas", () => {
    const g = geometryFromMesh(figure);
    const total = volumeOf(figure);
    const result = splitByRegions(
      w,
      { geometry: g, labels: paintFigure(figure), separate: [1, 2, 3, 4], baseLabel: 0, mode: "auto", firstCutId: 1 },
      wasmTriangulator(w),
    );
    expect(result.parts.map((p) => p.label).sort()).toEqual([0, 1, 2, 3, 4]);
    let sum = 0;
    for (const p of result.parts) {
      const r = analyzeMesh(p.geometry.mesh);
      expect(r.watertight).toBe(true);
      sum += volumeOf(p.geometry.mesh);
    }
    expect(Math.abs(sum - total) / total).toBeLessThan(1e-3);
    for (const isl of result.islands) expect(isl.method).not.toBe("falhou");
    const refs = result.parts.map((p) => ({ id: `p${p.label}`, geometry: p.geometry }));
    const ifaces = computeInterfaces(w, refs, result.cuts);
    const pairs = new Set(ifaces.map((i) => [i.front, i.back].sort().join("-")));
    expect(pairs).toEqual(new Set(["p0-p1", "p0-p2", "p0-p3", "p0-p4"]));
    // A cabeça sai por um plano quase horizontal no pescoço.
    const head = ifaces.find((i) => i.front === "p1" || i.back === "p1")!;
    expect(Math.abs(head.frame.normal[2])).toBeGreaterThan(0.9);
    expect(head.kind).toBe("plane");
  });

  it("separar só a cabeça mantém o resto unido", () => {
    const g = geometryFromMesh(figure);
    const result = splitByRegions(
      w,
      { geometry: g, labels: paintFigure(figure), separate: [1], baseLabel: 0, mode: "auto", firstCutId: 1 },
      wasmTriangulator(w),
    );
    expect(result.parts).toHaveLength(2);
    expect(result.cuts).toHaveLength(1);
  });

  it("modo contorno fecha a costura pintada exatamente", () => {
    const g = geometryFromMesh(figure);
    const total = volumeOf(figure);
    const result = splitByRegions(
      w,
      { geometry: g, labels: paintFigure(figure), separate: [2], baseLabel: 0, mode: "seam", firstCutId: 1 },
      wasmTriangulator(w),
    );
    expect(result.parts).toHaveLength(2);
    expect(result.islands[0].method).toBe("contorno");
    let sum = 0;
    for (const p of result.parts) {
      expect(analyzeMesh(p.geometry.mesh).watertight).toBe(true);
      sum += volumeOf(p.geometry.mesh);
    }
    expect(Math.abs(sum - total) / total).toBeLessThan(1e-3);
    expect(result.cuts[0].kind).toBe("seam");
  });

  it("modo contorno tampa uma faixa que se cruza quando achatada", () => {
    const sphere = w.Manifold.sphere(20, 96);
    const mm = sphere.getMesh();
    const mesh: IndexedMesh = { positions: new Float32Array(mm.vertProperties), indices: new Uint32Array(mm.triVerts) };
    sphere.delete();
    const c = faceCentroids(mesh);
    const labels = new Uint16Array(triCount(mesh));
    for (let t = 0; t < labels.length; t++) {
      const phi = Math.atan2(c[t * 3 + 1], c[t * 3]) + Math.PI;
      if (Math.abs(c[t * 3 + 2]) < 6 && phi > 0.4 && phi < 5.6) labels[t] = 1;
    }
    const total = volumeOf(mesh);
    const result = splitByRegions(
      w,
      { geometry: geometryFromMesh(mesh), labels, separate: [1], baseLabel: 0, mode: "seam", firstCutId: 1 },
      wasmTriangulator(w),
    );
    expect(result.islands[0].method).toBe("contorno");
    expect(result.islands[0].message).toMatch(/irregular/);
    expect(result.parts).toHaveLength(2);
    let sum = 0;
    for (const p of result.parts) {
      expect(analyzeMesh(p.geometry.mesh).watertight).toBe(true);
      expect(volumeOf(p.geometry.mesh)).toBeGreaterThan(0);
      sum += volumeOf(p.geometry.mesh);
    }
    expect(Math.abs(sum - total) / total).toBeLessThan(1e-3);
  });

  it("encaixes sobre uma costura ondulada usam a parte plana da tampa", () => {
    const sphere = w.Manifold.sphere(20, 96);
    const mm = sphere.getMesh();
    const mesh: IndexedMesh = { positions: new Float32Array(mm.vertProperties), indices: new Uint32Array(mm.triVerts) };
    sphere.delete();
    const c = faceCentroids(mesh);
    const labels = new Uint16Array(triCount(mesh));
    for (let t = 0; t < labels.length; t++)
      if (c[t * 3 + 2] > 4 * Math.sin(3 * Math.atan2(c[t * 3 + 1], c[t * 3]))) labels[t] = 1;
    const result = splitByRegions(
      w,
      { geometry: geometryFromMesh(mesh), labels, separate: [1], baseLabel: 0, mode: "seam", firstCutId: 1 },
      wasmTriangulator(w),
    );
    expect(result.parts).toHaveLength(2);
    const parts = result.parts.map((p) => ({ id: String(p.label), geometry: p.geometry }));
    const [iface] = computeInterfaces(w, parts, result.cuts);
    expect(iface).toBeDefined();
    const byId = (id: string) => parts.find((p) => p.id === id)!.geometry;
    const plan = planConnectors(w, {
      iface,
      front: byId(iface.front),
      back: byId(iface.back),
      settings: { ...defaultConnectorSettings, kind: "cylinder", count: 1 },
    });
    expect(plan.points.length).toBeGreaterThan(0);
    const applied = applyConnectors(w, parts, [iface], [plan]);
    expect(applied.checks[0].ok).toBe(true);
    for (const g of applied.parts.values()) expect(analyzeMesh(g.mesh).watertight).toBe(true);
  });

  it("preserva a origem das faces para cores e materiais", () => {
    const g = geometryFromMesh(figure);
    const result = splitByRegions(
      w,
      { geometry: g, labels: paintFigure(figure), separate: [1], baseLabel: 0, mode: "auto", firstCutId: 1 },
      wasmTriangulator(w),
    );
    const head = result.parts.find((p) => p.label === 1)!;
    const reg = new RunRegistry(w);
    void reg;
    const origin = head.geometry.src.filter((s) => s >= 0);
    expect(origin.length).toBeGreaterThan(0.8 * head.geometry.src.length);
    expect(Math.max(...origin)).toBeLessThan(triCount(figure));
  });
});
