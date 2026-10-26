import { beforeAll, describe, expect, it } from "vitest";
import { type Wasm, getManifold } from "../src/core/manifoldBridge";
import { type IndexedMesh, faceComponents, mergeMeshes, triCount } from "../src/core/mesh";
import { buildBox, buildSampleFigure } from "../src/core/sample";
import { decimateManifold } from "../src/core/decimate";
import { colorProvider, componentsProvider, geometricProvider } from "../src/segmentation/providers";
import { runSegmentation } from "../src/segmentation/run";
import { defaultSegmentationOptions } from "../src/segmentation/types";

let w: Wasm;
let figure: IndexedMesh;

beforeAll(async () => {
  w = await getManifold();
  figure = buildSampleFigure(w, 32);
});

describe("divisão automática", () => {
  it("encontra as partes do boneco pela geometria", async () => {
    const t0 = performance.now();
    const result = await geometricProvider.segment({ mesh: figure }, defaultSegmentationOptions);
    const elapsed = performance.now() - t0;
    const names = result.segments.map((s) => s.name);
    console.log("segmentos:", names.join(", "), `(${triCount(figure)} triângulos, ${elapsed.toFixed(0)} ms)`);
    expect(result.labels.length).toBe(triCount(figure));
    expect(result.segments.length).toBeGreaterThanOrEqual(6);
    expect(names).toContain("Cabeça");
    expect(names).toContain("Base");
    expect(names.filter((n) => n.startsWith("Braço"))).toHaveLength(2);
    expect(names.filter((n) => n.startsWith("Perna"))).toHaveLength(2);
    // Só o corpo principal não é sugerido para separar.
    expect(result.segments.filter((s) => !s.suggestedSeparate)).toHaveLength(1);
  });

  it("segmenta malhas densas numa cópia simplificada com o mesmo resultado", async () => {
    const dense = buildSampleFigure(w, 220);
    expect(triCount(dense)).toBeGreaterThan(100000);
    const result = await runSegmentation(geometricProvider, { mesh: dense }, defaultSegmentationOptions, {
      decimate: (m, target) => decimateManifold(w, m, target),
    });
    expect(result.labels.length).toBe(triCount(dense));
    const names = result.segments.map((s) => s.name);
    for (const name of ["Base", "Tronco", "Cabeça", "Braço esquerdo", "Braço direito", "Perna esquerda", "Perna direita"])
      expect(names).toContain(name);
    expect(result.notes.join(" ")).toMatch(/simplificada/);
    // A área transferida cobre a malha inteira.
    const total = result.segments.reduce((s, x) => s + x.area, 0);
    expect(total).toBeGreaterThan(0);
  });

  it("separa cascas soltas e cores", async () => {
    const a = buildBox(w, [10, 10, 10]);
    const b = buildBox(w, [4, 4, 4]);
    const shifted = { positions: b.positions.map((v, i) => (i % 3 === 0 ? v + 20 : v)), indices: b.indices };
    const mesh = mergeMeshes([a, shifted]);
    expect(faceComponents(mesh).count).toBe(2);
    expect(componentsProvider.available({ mesh })).toBe(true);
    const shells = await componentsProvider.segment({ mesh }, defaultSegmentationOptions);
    expect(shells.segments).toHaveLength(2);
    const faceColors = Uint32Array.from({ length: triCount(mesh) }, (_, f) => (f < 12 ? 0xff0000 : 0x00ff00));
    const colors = await colorProvider.segment({ mesh, faceColors }, defaultSegmentationOptions);
    expect(colors.segments.map((s) => s.name)).toEqual(["Cor #ff0000", "Cor #00ff00"]);
  });
});
