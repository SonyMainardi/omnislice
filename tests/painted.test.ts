import { beforeAll, describe, expect, it } from "vitest";
import { analyzeMesh } from "../src/core/analysis";
import { applyConnectors, defaultConnectorSettings, planConnectors } from "../src/core/connectors";
import { type Wasm, getManifold } from "../src/core/manifoldBridge";
import type { Manifold } from "manifold-3d";
import { type IndexedMesh, faceCentroids, signedVolume, triCount } from "../src/core/mesh";
import { geometryFromMesh } from "../src/core/part";
import { computeInterfaces, splitByRegions, wasmTriangulator } from "../src/core/split";

let w: Wasm;
beforeAll(async () => {
  w = await getManifold();
});

function meshOf(m: Manifold): IndexedMesh {
  const mm = m.getMesh();
  m.delete();
  return { positions: new Float32Array(mm.vertProperties), indices: new Uint32Array(mm.triVerts) };
}

/** Faces de origem (pintadas ou não) presentes numa peça, sem contar as tampas de corte. */
function origins(src: Int32Array): number[] {
  return Array.from(src).filter((s) => s >= 0);
}

describe("pintura à mão", () => {
  it("relevo pintado numa superfície curva sai sozinho, sem levar a pele em volta", () => {
    // Braço (cilindro r = 4 mm) com um relevo em "T" de 0,4 mm, como a âncora tatuada do Popeye.
    const arm = w.Manifold.cylinder(30, 4, 4, 96).rotate([0, 90, 0]).translate([-15, 0, 0]);
    const bar = w.Manifold.cube([5, 1.2, 2], true).translate([0, 1.5, 3.8]);
    const stem = w.Manifold.cube([1.2, 3.6, 4], true).translate([0, 0, 2.8]);
    const joined = w.Manifold.union([arm, bar, stem]);
    const solid = joined.refineToLength(0.3);
    for (const m of [arm, bar, stem, joined]) m.delete();
    const mesh = meshOf(solid);
    const c = faceCentroids(mesh);
    const labels = new Uint16Array(triCount(mesh));
    for (let f = 0; f < labels.length; f++) if (Math.hypot(c[f * 3 + 1], c[f * 3 + 2]) > 4.02 && c[f * 3 + 2] > 0) labels[f] = 1;
    const res = splitByRegions(
      w,
      { geometry: geometryFromMesh(mesh), labels, separate: [1], baseLabel: 0, mode: "auto", firstCutId: 1, precise: true },
      wasmTriangulator(w),
    );
    expect(res.islands[0].method).toBe("contorno");
    // Pintura efetiva (depois da limpeza de faces soltas na borda).
    const painted = new Set<number>();
    res.cleanedLabels.forEach((l, f) => l && painted.add(f));
    const piece = res.parts.find((p) => p.label === 1)!.geometry;
    const rest = res.parts.find((p) => p.label === 0)!.geometry;
    // A peça só tem faces pintadas (nada da pele) e o braço continua com toda a pele.
    expect(origins(piece.src).every((s) => painted.has(s))).toBe(true);
    expect(origins(rest.src).some((s) => painted.has(s))).toBe(false);
    for (const g of [piece, rest]) expect(analyzeMesh(g.mesh).watertight).toBe(true);
    expect(Math.abs(signedVolume(piece.mesh) + signedVolume(rest.mesh) - signedVolume(mesh)) / signedVolume(mesh)).toBeLessThan(1e-3);
  });

  it("um plano que deixa um pedaço da região do outro lado não é aceito: o corte segue o contorno", () => {
    // Perna (cilindro r = 5 mm) com o "sapato" pintado até z = 10 e uma lingueta que sobe até
    // z = 13 na frente: o melhor plano pega mais de 95% da área, mas deixa a lingueta na perna.
    const leg = w.Manifold.cylinder(40, 5, 5, 64).refineToLength(0.4);
    const mesh = meshOf(leg);
    const c = faceCentroids(mesh);
    const labels = new Uint16Array(triCount(mesh));
    for (let f = 0; f < labels.length; f++) {
      const ang = Math.atan2(c[f * 3 + 1], c[f * 3]);
      const top = Math.abs(ang) < 0.3 ? 13 - 10 * Math.abs(ang) : 10;
      if (c[f * 3 + 2] < top) labels[f] = 1;
    }
    const split = (precise: boolean) =>
      splitByRegions(
        w,
        { geometry: geometryFromMesh(mesh), labels, separate: [1], baseLabel: 0, mode: "auto", firstCutId: 1, precise },
        wasmTriangulator(w),
      );
    // Segmentação automática (fronteira aproximada): o plano de junção continua valendo.
    expect(split(false).islands[0].method).toBe("plano");
    // Pintura à mão: a lingueta vai junto com o sapato.
    const res = split(true);
    expect(res.islands[0].method).toBe("contorno");
    const painted = new Set<number>();
    res.cleanedLabels.forEach((l, f) => l && painted.add(f));
    const rest = res.parts.find((p) => p.label === 0)!.geometry;
    expect(origins(rest.src).some((s) => painted.has(s))).toBe(false);
  });

  it("um detalhe pequeno pintado de propósito vira peça e encaixa num rebaixo", () => {
    // Cubo de 60 mm com um botão de Ø2 mm: a área do botão é menor que 0,1% do total, o limite
    // usado para limpar respingos de pincel. Antes ele sumia na limpeza da pintura.
    const box = w.Manifold.cube([60, 60, 60], true);
    const button = w.Manifold.cylinder(1.4, 1, 1, 48).translate([0, 0, 29.6]);
    const mesh = meshOf(w.Manifold.union([box, button]));
    box.delete();
    button.delete();
    const c = faceCentroids(mesh);
    const labels = new Uint16Array(triCount(mesh));
    for (let f = 0; f < labels.length; f++) if (c[f * 3 + 2] > 30.05) labels[f] = 1;
    const res = splitByRegions(
      w,
      { geometry: geometryFromMesh(mesh), labels, separate: [1], baseLabel: 0, mode: "auto", firstCutId: 1, precise: true },
      wasmTriangulator(w),
    );
    expect(res.parts.map((p) => p.label).sort()).toEqual([0, 1]);
    const parts = res.parts.map((p) => ({ id: p.label ? "botao" : "cubo", geometry: p.geometry }));
    const [iface] = computeInterfaces(w, parts, res.cuts);
    const byId = (id: string) => parts.find((p) => p.id === id)!.geometry;
    const plan = planConnectors(w, { iface, front: byId(iface.front), back: byId(iface.back), settings: defaultConnectorSettings });
    expect(plan.kind).toBe("socket");
    expect(plan.maleSide === "front" ? iface.front : iface.back).toBe("botao");
    const applied = applyConnectors(w, parts, [iface], [plan]);
    expect(applied.checks[0]).toMatchObject({ ok: true });
    for (const g of applied.parts.values()) expect(analyzeMesh(g.mesh).watertight).toBe(true);
  });
});
