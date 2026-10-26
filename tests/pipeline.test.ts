import { beforeAll, describe, expect, it } from "vitest";
import { analyzeMesh } from "../src/core/analysis";
import { applyConnectors, defaultConnectorSettings, planConnectors, resolveConnectorConflicts } from "../src/core/connectors";
import { type Wasm, getManifold } from "../src/core/manifoldBridge";
import { frameFromNormal } from "../src/core/math";
import { computeBounds, type IndexedMesh } from "../src/core/mesh";
import { geometryFromMesh } from "../src/core/part";
import { buildSampleFigure } from "../src/core/sample";
import { computeInterfaces, cutByPlane, splitByRegions, wasmTriangulator } from "../src/core/split";
import { geometricProvider } from "../src/segmentation/providers";
import { defaultSegmentationOptions } from "../src/segmentation/types";

let w: Wasm;
let figure: IndexedMesh;
beforeAll(async () => {
  w = await getManifold();
  figure = buildSampleFigure(w, 64);
});

describe("fluxo completo", () => {
  it("segmenta, divide, corta o tronco e encaixa tudo sem colisões", async () => {
    const seg = await geometricProvider.segment({ mesh: figure }, defaultSegmentationOptions);
    const base = seg.segments.find((s) => !s.suggestedSeparate)!.id;
    const res = splitByRegions(
      w,
      {
        geometry: geometryFromMesh(figure),
        labels: seg.labels,
        separate: seg.segments.filter((s) => s.suggestedSeparate).map((s) => s.id),
        baseLabel: base,
        mode: "auto",
        firstCutId: 1,
      },
      wasmTriangulator(w),
    );
    const methods = res.islands.map((i) => i.method);
    console.log("métodos:", res.islands.map((i) => `${seg.segments.find((s) => s.id === i.label)?.name}=${i.method}`).join(", "));
    expect(methods).not.toContain("falhou");
    // Braços, pernas e cabeça saem por planos de junção (faces retas, melhores para pinos).
    expect(methods.filter((m) => m === "plano").length).toBeGreaterThanOrEqual(5);
    let parts = res.parts.map((p) => ({ id: seg.segments.find((s) => s.id === p.label)!.name, geometry: p.geometry }));
    for (const p of parts) expect(analyzeMesh(p.geometry.mesh).watertight).toBe(true);
    const torso = parts.find((p) => p.id === "Tronco")!;
    const b = computeBounds(torso.geometry.mesh.positions);
    const frame = frameFromNormal([(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2], [0, 0, 1]);
    const cut = cutByPlane(w, torso.geometry, frame, 100, false);
    parts = parts.filter((p) => p !== torso).concat([
      { id: "sup", geometry: cut.front[0] },
      { id: "inf", geometry: cut.back[0] },
    ]);
    const ifaces = computeInterfaces(w, parts, [...res.cuts, { id: 100, kind: "plane", frame }]);
    const byId = new Map(parts.map((p) => [p.id, p]));
    const items = ifaces.map((iface) => ({ iface, front: byId.get(iface.front)!.geometry, back: byId.get(iface.back)!.geometry, settings: defaultConnectorSettings }));
    const plans = resolveConnectorConflicts(w, items, items.map((it) => planConnectors(w, it)));
    expect(plans.filter((p) => p.points.length).length).toBeGreaterThanOrEqual(6);
    const applied = applyConnectors(w, parts, ifaces, plans);
    for (const c of applied.checks) expect(c, JSON.stringify(c) + JSON.stringify(plans.find((p) => p.interfaceId === c.interfaceId))).toMatchObject({ ok: true });
    for (const g of applied.parts.values()) expect(analyzeMesh(g.mesh).watertight).toBe(true);
  });
});
