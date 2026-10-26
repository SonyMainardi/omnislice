import { beforeAll, describe, expect, it } from "vitest";
import { applyConnectors, bedCapTag, defaultConnectorSettings, femaleHints, planConnectors } from "../src/core/connectors";
import { type Wasm, getManifold } from "../src/core/manifoldBridge";
import { frameFromNormal } from "../src/core/math";
import { type IndexedMesh, computeBounds, faceComponents } from "../src/core/mesh";
import { CONNECTOR_TAG, cutTag, geometryFromMesh } from "../src/core/part";
import { buildBox, buildSampleFigure } from "../src/core/sample";
import { computeInterfaces, cutByPlane, splitByRegions, wasmTriangulator } from "../src/core/split";
import { geometricProvider } from "../src/segmentation/providers";
import { sampleThickness } from "../src/segmentation/sdf";
import { defaultSegmentationOptions } from "../src/segmentation/types";

let w: Wasm;
let figure: IndexedMesh;
beforeAll(async () => {
  w = await getManifold();
  figure = buildSampleFigure(w, 48);
});

describe("qualidade das peças", () => {
  it("separa a base exatamente no topo plano e sem lascas soltas", async () => {
    const seg = await geometricProvider.segment({ mesh: figure }, defaultSegmentationOptions);
    const main = seg.segments.find((s) => !s.suggestedSeparate)!.id;
    const res = splitByRegions(
      w,
      {
        geometry: geometryFromMesh(figure),
        labels: seg.labels,
        separate: seg.segments.filter((s) => s.suggestedSeparate).map((s) => s.id),
        baseLabel: main,
        mode: "auto",
        firstCutId: 1,
      },
      wasmTriangulator(w),
    );
    const byName = new Map(res.parts.map((p) => [seg.segments.find((s) => s.id === p.label)!.name, p.geometry]));
    const base = computeBounds(byName.get("Base")!.mesh.positions);
    // Topo da base do boneco em z = 6,4 mm (4,9 + 1,5).
    expect(base.max[2]).toBeCloseTo(6.4, 2);
    for (const g of byName.values()) expect(faceComponents(g.mesh).count).toBe(1);
    expect(sampleThickness(byName.get("Base")!.mesh).p10).toBeGreaterThan(5);
  });

  it("corte por plano devolve migalhas ao lado que elas tocam", () => {
    // Em z = 46 o plano raspa só a parte de baixo das mãos.
    const { front, back } = cutByPlane(w, geometryFromMesh(figure), frameFromNormal([0, 0, 46], [0, 0, 1]), 9, false);
    expect(faceComponents(front[0].mesh).count).toBe(1);
    expect(faceComponents(back[0].mesh).count).toBe(1);
    // As mãos inteiras ficam com a parte de cima.
    expect(computeBounds(front[0].mesh.positions).min[2]).toBeLessThan(44);
  });

  it("põe o furo na peça que vai apoiar na face de corte", () => {
    const frame = frameFromNormal([0, 0, 78], [0, 0, 1]);
    const { front, back } = cutByPlane(w, geometryFromMesh(figure), frame, 3, false);
    // A cabeça só tem esta tampa: é a face de apoio dela.
    expect(bedCapTag(front[0])).toBe(cutTag(3, 0));
    const parts = [
      { id: "cabeca", geometry: front[0] },
      { id: "corpo", geometry: back[0] },
    ];
    const [iface] = computeInterfaces(w, parts, [{ id: 3, kind: "plane", frame }]);
    const item = { iface, front: front[0], back: back[0], settings: defaultConnectorSettings };
    const [hint] = femaleHints([item]);
    // O corpo tem o fundo plano da base como apoio, então a cabeça recebe o furo.
    expect(hint).toBe("front");
    const plan = planConnectors(w, { ...item, femaleHint: hint });
    expect(plan.maleSide).toBe("back");
    expect(applyConnectors(w, parts, [iface], [plan]).checks[0].ok).toBe(true);
  });

  it("não acusa parede fina em um bloco com furo", () => {
    const box = geometryFromMesh(buildBox(w, [30, 30, 20]));
    const frame = frameFromNormal([0, 0, 0], [0, 0, 1]);
    const { front, back } = cutByPlane(w, box, frame, 1, false);
    const parts = [
      { id: "a", geometry: front[0] },
      { id: "b", geometry: back[0] },
    ];
    const [iface] = computeInterfaces(w, parts, [{ id: 1, kind: "plane", frame }]);
    const plan = planConnectors(w, { iface, front: front[0], back: back[0], settings: defaultConnectorSettings });
    const applied = applyConnectors(w, parts, [iface], [plan]);
    // Como no worker, faces do próprio encaixe (chanfro, fundo de 1 mm do furo) não contam.
    for (const g of applied.parts.values())
      expect(sampleThickness(g.mesh, 1500, (f) => g.cut[f] === CONNECTOR_TAG).p10).toBeGreaterThan(2);
  });
});
