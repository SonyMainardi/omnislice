import { beforeAll, describe, expect, it } from "vitest";
import { applyConnectors, defaultConnectorSettings, planConnectors } from "../src/core/connectors";
import { CONTACT_ID_BASE, computeContacts } from "../src/core/contacts";
import { type Wasm, getManifold } from "../src/core/manifoldBridge";
import { frameFromNormal } from "../src/core/math";
import { type IndexedMesh, triCount } from "../src/core/mesh";
import { type PartGeometry, geometryFromMesh } from "../src/core/part";
import { cutByPlane, splitByRegions, wasmTriangulator } from "../src/core/split";
import { baseDisc, bootsFigure, mergeTracked, paint, tracked } from "./figures";

/**
 * Peças que já eram cascas separadas no arquivo e se apoiam uma na outra (a figura em pé sobre a
 * base): sem corte entre elas, os encaixes vêm das regiões de apoio.
 */

let w: Wasm;
beforeAll(async () => {
  w = await getManifold();
});

function separateBase(lift: number) {
  const scene = mergeTracked([bootsFigure(w, lift), baseDisc(w)]);
  const res = splitByRegions(
    w,
    { geometry: geometryFromMesh(scene.mesh), labels: paint(scene, ["base"]), separate: [1], baseLabel: 0, mode: "auto", firstCutId: 1, precise: true },
    wasmTriangulator(w),
  );
  // A base é uma casca inteira: sai sem corte nenhum.
  expect(res.cuts).toHaveLength(0);
  return res.parts.map((p) => ({ id: p.label ? "base" : "figura", geometry: p.geometry }));
}

function planAll(parts: { id: string; geometry: PartGeometry }[]) {
  const ifaces = computeContacts(w, parts);
  const byId = new Map(parts.map((p) => [p.id, p.geometry]));
  const plans = ifaces.map((iface) => planConnectors(w, { iface, front: byId.get(iface.front)!, back: byId.get(iface.back)!, settings: defaultConnectorSettings }));
  return { ifaces, plans, applied: applyConnectors(w, parts, ifaces, plans) };
}

describe("apoio entre peças separadas", () => {
  it("figura sobre a base: cada sola ganha um encaixe", () => {
    const { ifaces, plans, applied } = planAll(separateBase(0));
    expect(ifaces).toHaveLength(2);
    for (const iface of ifaces) {
      expect(iface.kind).toBe("contact");
      expect(iface.cutId).toBeGreaterThanOrEqual(CONTACT_ID_BASE);
      // Plano do topo da base, com a normal para a figura (que fica na frente).
      expect(iface.frame.normal[2]).toBeGreaterThan(0.99);
      expect(Math.abs(iface.frame.origin[2])).toBeLessThan(1e-3);
      expect(iface.front).toBe("figura");
      expect(iface.back).toBe("base");
    }
    for (const plan of plans) expect(plan.points.length, plan.warnings.join(" | ")).toBeGreaterThan(0);
    expect(applied.checks.map((c) => c.ok)).toEqual([true, true]);
  });

  it("sola esculpida que fica um pouco acima da base também conta como apoio", () => {
    // Folga de 0,3 mm entre as solas e a base: o pino atravessa a folga.
    const { ifaces, plans, applied } = planAll(separateBase(0.3));
    expect(ifaces).toHaveLength(2);
    for (const iface of ifaces) expect(iface.deviation).toBeGreaterThan(0.25);
    for (const plan of plans) expect(plan.points.length, plan.warnings.join(" | ")).toBeGreaterThan(0);
    expect(applied.checks.every((c) => c.ok)).toBe(true);
  });

  it("sola cravada na base (sobreposição no arquivo): o encaixe valida sem acusar a sobreposição antiga", () => {
    const { ifaces, plans, applied } = planAll(separateBase(-0.4));
    expect(ifaces).toHaveLength(2);
    for (const plan of plans) expect(plan.points.length, plan.warnings.join(" | ")).toBeGreaterThan(0);
    expect(applied.checks.every((c) => c.ok)).toBe(true);
  });

  it("peças longe uma da outra, ligadas por corte ou encostadas numa superfície curva não ganham apoio", () => {
    expect(planAll(separateBase(3)).ifaces).toHaveLength(0);
    // Caixa cortada ao meio: as tampas já são a interface do corte.
    const box = w.Manifold.cube([20, 20, 20], true);
    const mm = box.getMesh();
    box.delete();
    const g = geometryFromMesh({ positions: new Float32Array(mm.vertProperties), indices: new Uint32Array(mm.triVerts) });
    const cut = cutByPlane(w, g, frameFromNormal([0, 0, 0], [0, 0, 1]), 1, false);
    expect(computeContacts(w, [{ id: "a", geometry: cut.front[0] }, { id: "b", geometry: cut.back[0] }])).toHaveLength(0);
    // Bola apoiada numa cuba com folga de 0,2 mm: o apoio é curvo, não serve para pino.
    const cup = tracked((prim) => prim("cuba", w.Manifold.cube([30, 30, 12], true).subtract(w.Manifold.sphere(8.2, 64).translate([0, 0, 6]))), 0.6);
    const ball = tracked((prim) => prim("bola", w.Manifold.sphere(8, 64).translate([0, 0, 6])), 0.6);
    const parts = [cup, ball].map((t, i) => ({ id: `p${i}`, geometry: geometryFromMesh(t.mesh as IndexedMesh) }));
    expect(triCount(parts[1].geometry.mesh)).toBeGreaterThan(0);
    expect(computeContacts(w, parts)).toHaveLength(0);
  });
});
