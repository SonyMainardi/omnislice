import { beforeAll, describe, expect, it } from "vitest";
import { analyzeMesh } from "../src/core/analysis";
import {
  type ConnectorSettings,
  applyConnectors,
  autoClearance,
  defaultConnectorSettings,
  planConnectors,
} from "../src/core/connectors";
import { type Wasm, getManifold } from "../src/core/manifoldBridge";
import { frameFromNormal } from "../src/core/math";
import { type IndexedMesh, signedVolume } from "../src/core/mesh";
import { CONNECTOR_TAG, geometryFromMesh } from "../src/core/part";
import { buildBox, buildSampleFigure } from "../src/core/sample";
import { type Interface, type PartRef, computeInterfaces, cutByPlane } from "../src/core/split";

let w: Wasm;
let figure: IndexedMesh;

beforeAll(async () => {
  w = await getManifold();
  figure = buildSampleFigure(w, 32);
});

function cutBox(normalZ: 1 | -1 = 1): { parts: PartRef[]; iface: Interface } {
  const box = geometryFromMesh(buildBox(w, [40, 30, 60]));
  const frame = frameFromNormal([0, 0, 0], [0, 0, normalZ]);
  const { front, back } = cutByPlane(w, box, frame, 1, false);
  const parts = [
    { id: "f", geometry: front[0] },
    { id: "b", geometry: back[0] },
  ];
  const [iface] = computeInterfaces(w, parts, [{ id: 1, kind: "plane", frame }]);
  return { parts, iface };
}

function run(settings: Partial<ConnectorSettings>, normalZ: 1 | -1 = 1) {
  const { parts, iface } = cutBox(normalZ);
  const plan = planConnectors(w, {
    iface,
    front: parts[0].geometry,
    back: parts[1].geometry,
    settings: { ...defaultConnectorSettings, ...settings },
  });
  const applied = applyConnectors(w, parts, [iface], [plan]);
  return { parts, iface, plan, applied };
}

describe("encaixes", () => {
  it("cria um pino que entra no furo sem colisão", () => {
    const { parts, plan, applied } = run({ kind: "cylinder", count: 1 });
    expect(plan.points).toHaveLength(1);
    expect(plan.size).toBeGreaterThanOrEqual(2);
    expect(plan.length).toBeGreaterThan(2);
    const check = applied.checks[0];
    expect(check.ok).toBe(true);
    expect(check.collision).toBeLessThan(0.05);
    const male = plan.maleSide === "front" ? "f" : "b";
    const female = male === "f" ? "b" : "f";
    const maleBefore = signedVolume(parts.find((p) => p.id === male)!.geometry.mesh);
    const femaleBefore = signedVolume(parts.find((p) => p.id === female)!.geometry.mesh);
    const maleAfter = signedVolume(applied.parts.get(male)!.mesh);
    const femaleAfter = signedVolume(applied.parts.get(female)!.mesh);
    expect(maleAfter).toBeGreaterThan(maleBefore);
    expect(femaleAfter).toBeLessThan(femaleBefore);
    // O furo é maior que o pino por causa da folga.
    expect(femaleBefore - femaleAfter).toBeGreaterThan(maleAfter - maleBefore);
    for (const g of applied.parts.values()) {
      expect(analyzeMesh(g.mesh).watertight).toBe(true);
      expect(Array.from(g.cut).some((t) => t === CONNECTOR_TAG)).toBe(true);
    }
  });

  it("funciona com o pino em qualquer lado do corte", () => {
    for (const side of ["front", "back"] as const) {
      const { plan, applied } = run({ kind: "hex", count: 2, maleSide: side }, -1);
      expect(plan.maleSide).toBe(side);
      expect(plan.points).toHaveLength(2);
      expect(applied.checks[0].ok).toBe(true);
    }
  });

  it("espalha vários pinos respeitando a parede mínima", () => {
    const { plan, iface } = run({ kind: "square", count: 4, size: 5 });
    expect(plan.points).toHaveLength(4);
    for (const p of plan.points) {
      expect(Math.abs(p[0])).toBeLessThanOrEqual(20 - 2.5 - 1.2);
      expect(Math.abs(p[1])).toBeLessThanOrEqual(15 - 2.5 - 1.2);
    }
    for (let i = 0; i < plan.points.length; i++)
      for (let j = i + 1; j < plan.points.length; j++) {
        const d = Math.hypot(plan.points[i][0] - plan.points[j][0], plan.points[i][1] - plan.points[j][1]);
        expect(d).toBeGreaterThanOrEqual(5 + 2.5 - 1e-6);
      }
    expect(iface.area).toBeCloseTo(1200, 0);
  });

  it("gera cavilhas avulsas com furos dos dois lados", () => {
    const { plan, applied, parts } = run({ kind: "dowel", count: 2, size: 5, length: 16 });
    expect(plan.dowelDepths).toEqual([8, 8]);
    expect(applied.extras).toHaveLength(2);
    for (const p of parts)
      expect(signedVolume(applied.parts.get(p.id)!.mesh)).toBeLessThan(signedVolume(p.geometry.mesh));
    const dowel = applied.extras[0].geometry.mesh;
    expect(signedVolume(dowel)).toBeGreaterThan(0);
    expect(applied.checks[0].ok).toBe(true);
  });

  it("cria alojamentos de ímã nos dois lados", () => {
    const { plan, applied } = run({ kind: "magnet", count: 2, size: 6, length: 2 });
    expect(plan.points).toHaveLength(2);
    expect(applied.extras).toHaveLength(0);
    expect(applied.checks[0].ok).toBe(true);
  });

  it("um tamanho escolhido que não cabe num corte fino é reduzido nesse corte, sem sumir", () => {
    // O tamanho padrão vale para todos os cortes: 6 mm serve na cintura, mas não num tornozelo de 7 mm.
    const rod = geometryFromMesh(buildBox(w, [7, 7, 40]));
    const frame = frameFromNormal([0, 0, 0], [0, 0, 1]);
    const { front, back } = cutByPlane(w, rod, frame, 1, false);
    const parts = [
      { id: "f", geometry: front[0] },
      { id: "b", geometry: back[0] },
    ];
    const [iface] = computeInterfaces(w, parts, [{ id: 1, kind: "plane", frame }]);
    for (const kind of ["cylinder", "square", "hex"] as const) {
      const settings = { ...defaultConnectorSettings, kind, size: 6 };
      const plan = planConnectors(w, { iface, front: front[0], back: back[0], settings });
      expect(plan.points, kind).toHaveLength(1);
      expect(plan.size, kind).toBeLessThan(6);
      expect(plan.warnings.some((m) => m.includes("reduzido para")), kind).toBe(true);
      const applied = applyConnectors(w, parts, [iface], [plan]);
      expect(applied.checks[0].ok, kind).toBe(true);
    }
    // Onde cabe, o tamanho escolhido é respeitado.
    const big = run({ kind: "cylinder", size: 6 });
    expect(big.plan.size).toBe(6);
    expect(big.plan.warnings.some((m) => m.includes("reduzido"))).toBe(false);
  });

  it("ímã automático: usa o maior ímã comercial que cabe em cortes finos", () => {
    // Haste de 7 × 7 mm: o ímã padrão de 6 mm não cabe com parede de 1,6 mm (antes a face ficava lisa).
    const rod = geometryFromMesh(buildBox(w, [7, 7, 40]));
    const frame = frameFromNormal([0, 0, 0], [0, 0, 1]);
    const { front, back } = cutByPlane(w, rod, frame, 1, false);
    const parts = [
      { id: "f", geometry: front[0] },
      { id: "b", geometry: back[0] },
    ];
    const [iface] = computeInterfaces(w, parts, [{ id: 1, kind: "plane", frame }]);
    const settings = { ...defaultConnectorSettings, kind: "magnet" as const };
    const plan = planConnectors(w, { iface, front: front[0], back: back[0], settings });
    expect(plan.points).toHaveLength(1);
    expect(plan.size).toBeLessThan(6);
    expect(plan.warnings.some((m) => m.startsWith("Ímã reduzido"))).toBe(true);
    const applied = applyConnectors(w, parts, [iface], [plan]);
    expect(applied.checks[0].ok).toBe(true);
    for (const p of parts) expect(applied.parts.get(p.id)!.cut.some((c) => c === CONNECTOR_TAG)).toBe(true);
    // Num corte grande, o padrão continua sendo o ímã de 6 × 3 mm.
    const big = run({ kind: "magnet" });
    expect([big.plan.size, big.plan.length]).toEqual([6, 3]);
    // Seção menor que qualquer ímã: sem alojamento, com aviso claro.
    const pin = geometryFromMesh(buildBox(w, [3, 3, 40]));
    const cut = cutByPlane(w, pin, frame, 2, false);
    const pinParts = [
      { id: "f", geometry: cut.front[0] },
      { id: "b", geometry: cut.back[0] },
    ];
    const [pinIface] = computeInterfaces(w, pinParts, [{ id: 2, kind: "plane", frame }]);
    if (pinIface) {
      const none = planConnectors(w, { iface: pinIface, front: cut.front[0], back: cut.back[0], settings });
      expect(none.points).toHaveLength(0);
      expect(none.warnings.join(" ")).toMatch(/Nenhum ímã/);
    }
  });

  it("peça pequena demais para pino encaixa num rebaixo com o formato do corte", () => {
    // Um "olho" (botão de Ø2,4 mm) sobre uma caixa: nenhum pino cabe com parede, então a peça
    // pequena ganha um plugue com o contorno do corte e a caixa um rebaixo do mesmo formato.
    const box = w.Manifold.cube([20, 20, 10], true);
    const eye = w.Manifold.cylinder(1.6, 1.2, 1.2, 48).translate([0, 0, 4.6]);
    const solid = w.Manifold.union([box, eye]);
    const mm = solid.getMesh();
    for (const m of [box, eye, solid]) m.delete();
    const g = geometryFromMesh({ positions: new Float32Array(mm.vertProperties), indices: new Uint32Array(mm.triVerts) });
    const frame = frameFromNormal([0, 0, 5.4], [0, 0, 1]);
    const { front, back } = cutByPlane(w, g, frame, 1, false);
    const parts = [
      { id: "olho", geometry: front[0] },
      { id: "cabeca", geometry: back[0] },
    ];
    const [iface] = computeInterfaces(w, parts, [{ id: 1, kind: "plane", frame }]);
    const plan = planConnectors(w, { iface, front: front[0], back: back[0], settings: defaultConnectorSettings });
    expect(plan.kind, JSON.stringify(plan.warnings)).toBe("socket");
    expect(plan.points).toHaveLength(1);
    expect(plan.maleSide).toBe("front");
    expect(plan.warnings.join(" ")).toMatch(/rebaixo/);
    // O plugue fica dentro do contorno do corte, com folga e parede até a borda.
    for (const poly of plan.profile!) for (const [x, y] of poly) expect(Math.hypot(x + plan.points[0][0], y + plan.points[0][1])).toBeLessThan(1.2 - plan.clearance - 0.15);
    const applied = applyConnectors(w, parts, [iface], [plan]);
    expect(applied.checks[0]).toMatchObject({ ok: true });
    const eyeBefore = signedVolume(front[0].mesh);
    const eyeAfter = signedVolume(applied.parts.get("olho")!.mesh);
    const headBefore = signedVolume(back[0].mesh);
    const headAfter = signedVolume(applied.parts.get("cabeca")!.mesh);
    expect(eyeAfter).toBeGreaterThan(eyeBefore);
    expect(headAfter).toBeLessThan(headBefore);
    // A peça pequena não muda por fora: o topo do olho continua a 1,2 mm do corte.
    const top = Math.max(...Array.from({ length: applied.parts.get("olho")!.mesh.positions.length / 3 }, (_, i) => applied.parts.get("olho")!.mesh.positions[i * 3 + 2]));
    expect(top).toBeCloseTo(6.2, 3);
    for (const p of applied.parts.values()) expect(analyzeMesh(p.mesh).watertight).toBe(true);
    // Escolhido à mão, o rebaixo também vale para cortes grandes.
    const big = run({ kind: "socket" });
    expect(big.plan.points).toHaveLength(1);
    expect(big.applied.checks[0].ok).toBe(true);
  });

  it("encurta o pino quando a peça fêmea é fina", () => {
    const box = geometryFromMesh(buildBox(w, [40, 40, 10], false));
    const frame = frameFromNormal([0, 0, 3], [0, 0, 1]);
    const { front, back } = cutByPlane(w, box, frame, 1, false);
    const parts = [
      { id: "f", geometry: front[0] },
      { id: "b", geometry: back[0] },
    ];
    const [iface] = computeInterfaces(w, parts, [{ id: 1, kind: "plane", frame }]);
    const plan = planConnectors(w, {
      iface,
      front: front[0],
      back: back[0],
      settings: { ...defaultConnectorSettings, size: 4, length: 10 },
    });
    // Frente tem 7 mm de material: o furo vai nela e o pino fica com no máximo 7 − 1 − 0,4 mm.
    expect(plan.maleSide).toBe("back");
    expect(plan.length).toBeLessThanOrEqual(5.6 + 1e-9);
    expect(plan.warnings.join(" ")).toMatch(/encurtado/);
    const applied = applyConnectors(w, parts, [iface], [plan]);
    expect(applied.checks[0].ok).toBe(true);
  });

  it("encaixa a cabeça do boneco no pescoço", () => {
    const g = geometryFromMesh(figure);
    const frame = frameFromNormal([0, 0, 78], [0, 0, 1]);
    const { front, back } = cutByPlane(w, g, frame, 3, false);
    const parts = [
      { id: "cabeca", geometry: front[0] },
      { id: "corpo", geometry: back[0] },
    ];
    const [iface] = computeInterfaces(w, parts, [{ id: 3, kind: "plane", frame }]);
    const plan = planConnectors(w, { iface, front: front[0], back: back[0], settings: defaultConnectorSettings });
    expect(plan.points).toHaveLength(1);
    // Pescoço com raio 5: pino automático de 4 mm, centralizado.
    expect(plan.size).toBe(4);
    expect(Math.hypot(...plan.points[0])).toBeLessThan(0.5);
    const applied = applyConnectors(w, parts, [iface], [plan]);
    expect(applied.checks[0].ok).toBe(true);
  });

  it("usa folgas de referência por material", () => {
    expect(autoClearance({ material: "pla", fit: "normal", kind: "cylinder" }, 8)).toBe(0.15);
    expect(autoClearance({ material: "pla", fit: "normal", kind: "cylinder" }, 4)).toBe(0.2);
    expect(autoClearance({ material: "resina", fit: "justo", kind: "cylinder" }, 4)).toBe(0.05);
  });
});
