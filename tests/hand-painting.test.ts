import { beforeAll, describe, expect, it } from "vitest";
import { analyzeMesh } from "../src/core/analysis";
import { applyConnectors, defaultConnectorSettings, planConnectors } from "../src/core/connectors";
import { type Wasm, getManifold } from "../src/core/manifoldBridge";
import { type IndexedMesh, signedVolume } from "../src/core/mesh";
import { type PartGeometry, geometryFromMesh } from "../src/core/part";
import { computeInterfaces, splitByRegions, wasmTriangulator } from "../src/core/split";
import { type Tracked, bootsFigure, eyeHead, paint } from "./figures";

/**
 * Pintura à mão: o corte segue o que foi pintado, sem plano "aproximado" que corta fora da pintura
 * (o funil de uma bota preso na perna, só a íris em vez do olho) e sem estender a região sobre o que
 * não foi pintado (a bota abaixo de uma canela pintada).
 */

let w: Wasm;
beforeAll(async () => {
  w = await getManifold();
});

const split = (mesh: IndexedMesh, labels: Uint16Array, precise = true) =>
  splitByRegions(w, { geometry: geometryFromMesh(mesh), labels, separate: [1], baseLabel: 0, mode: "auto", firstCutId: 1, precise }, wasmTriangulator(w));

/** Primitivas de origem das faces de uma peça (as tampas dos cortes não contam). */
const tagsOf = (fig: Tracked, g: PartGeometry) => new Set(Array.from(g.src).filter((s) => s >= 0).map((s) => fig.tag[s]));

/** Altura (z do centro) das faces de origem de uma peça que vieram da primitiva `tag`. */
const heightsOf = (fig: Tracked, g: PartGeometry, tag: string) =>
  Array.from(g.src)
    .filter((s) => s >= 0 && fig.tag[s] === tag)
    .map((s) => {
      const p = fig.mesh.positions;
      const i = fig.mesh.indices;
      return (p[i[s * 3] * 3 + 2] + p[i[s * 3 + 1] * 3 + 2] + p[i[s * 3 + 2] * 3 + 2]) / 3;
    });

describe("pintura à mão", () => {
  it("bota pintada só por fora: o funil vai inteiro com a bota e as duas ganham pino", () => {
    // Como na foto do cliente: o lado de dentro do funil (onde a perna entra) ficou sem tinta, e a
    // fronteira pintada corre pela borda do funil. Antes um plano inclinado cortava o funil e deixava
    // um pedaço dele preso na perna.
    const fig = bootsFigure(w);
    const res = split(fig.mesh, paint(fig, ["pe", "cano", "funil-fora"]));
    const cuts = res.islands.filter((i) => i.method !== "componente");
    expect(cuts.map((i) => i.method)).toEqual(["contorno", "contorno"]);
    const boots = res.parts.find((p) => p.label === 1)!.geometry;
    const body = res.parts.find((p) => p.label === 0)!.geometry;
    // Nada da bota (nem o lado de dentro do funil) fica no corpo; a perna acima do funil fica nele.
    for (const t of ["pe", "cano", "funil-fora", "funil-dentro"]) expect(tagsOf(fig, body).has(t), t).toBe(false);
    // Da perna, a bota só leva (no máximo) o trecho escondido dentro do funil, abaixo da borda dele.
    expect(Math.max(0, ...heightsOf(fig, boots, "perna"))).toBeLessThan(23.2);
    for (const g of [boots, body]) expect(analyzeMesh(g.mesh).watertight).toBe(true);
    const total = signedVolume(fig.mesh);
    expect(Math.abs(signedVolume(boots.mesh) + signedVolume(body.mesh) - total) / total).toBeLessThan(1e-3);
    // Um pino em cada bota, ao longo da perna, validado.
    const parts = res.parts.map((p) => ({ id: p.label ? "botas" : "corpo", geometry: p.geometry }));
    const ifaces = computeInterfaces(w, parts, res.cuts);
    expect(ifaces).toHaveLength(2);
    const byId = new Map(parts.map((p) => [p.id, p.geometry]));
    const plans = ifaces.map((iface) => planConnectors(w, { iface, front: byId.get(iface.front)!, back: byId.get(iface.back)!, settings: defaultConnectorSettings }));
    for (const plan of plans) expect(plan.points.length, plan.warnings.join(" | ")).toBeGreaterThan(0);
    const applied = applyConnectors(w, parts, ifaces, plans);
    expect(applied.checks.map((c) => c.ok)).toEqual([true, true]);
  });

  it("canela pintada: a bota abaixo dela vira peça própria, não vai junto com a canela", () => {
    const fig = bootsFigure(w);
    const labels = paint(fig, ["perna"], (c) => c[2] > 26 && c[2] < 40);
    const res = split(fig.mesh, labels);
    expect(res.islands.some((i) => i.method === "falhou")).toBe(false);
    const shins = res.parts.find((p) => p.label === 1)!.geometry;
    // A canela é só a faixa pintada da perna (um corte plano fiel leva no máximo a ponta dos
    // triângulos da borda): nada da bota nem do quadril.
    expect([...tagsOf(fig, shins)]).toEqual(["perna"]);
    const z = heightsOf(fig, shins, "perna");
    expect(Math.min(...z)).toBeGreaterThan(25.3);
    expect(Math.max(...z)).toBeLessThan(40.7);
    // As partes sem pintura que ficaram soltas do corpo (quadril em cima, botas embaixo) viram peças.
    expect(res.detached.length).toBeGreaterThan(0);
    for (const label of res.detached) expect(res.parts.some((p) => p.label === label)).toBe(true);
    const bootPart = res.parts.find((p) => tagsOf(fig, p.geometry).has("pe"))!;
    expect(bootPart.label).not.toBe(1);
    // Na segmentação automática (fronteira aproximada) o trecho solto acompanha a região vizinha.
    const auto = split(fig.mesh, labels, false);
    expect(auto.detached).toEqual([]);
  });

  it("olho afundado com íris em relevo: sai o olho inteiro como peça embutida", () => {
    // Antes o plano pela borda do olho pegava só a íris (o que sobe acima dele): 2 × 0,4 × 2,6 mm.
    const head = eyeHead(w);
    const labels = paint(head, ["olho", "iris"]);
    const res = split(head.mesh, labels);
    expect(res.islands[0].method).toBe("contorno");
    expect(res.islands[0].message).toMatch(/embutida/);
    expect(res.cuts).toHaveLength(1);
    expect(res.cuts[0].inlay).toBeGreaterThanOrEqual(0.6);
    const painted = new Set<number>();
    res.cleanedLabels.forEach((l, f) => l === 1 && painted.add(f));
    const eye = res.parts.find((p) => p.label === 1)!.geometry;
    const rest = res.parts.find((p) => p.label === 0)!.geometry;
    // O contorno da peça é o pintado: ela tem todas as faces pintadas e o resto nenhuma.
    const eyeFaces = new Set(Array.from(eye.src).filter((s) => s >= 0));
    expect(eyeFaces.size).toBe(painted.size);
    expect(Array.from(rest.src).some((s) => painted.has(s))).toBe(false);
    for (const g of [eye, rest]) expect(analyzeMesh(g.mesh).watertight).toBe(true);
    const total = signedVolume(head.mesh);
    expect(Math.abs(signedVolume(eye.mesh) + signedVolume(rest.mesh) - total) / total).toBeLessThan(1e-3);
    // O encaixe é o próprio rebaixo: sem pino, com folga aberta em volta da peça embutida.
    const parts = [
      { id: "olho", geometry: eye },
      { id: "cabeca", geometry: rest },
    ];
    const [iface] = computeInterfaces(w, parts, res.cuts);
    expect(iface.inlay).toBe(res.cuts[0].inlay);
    const plan = planConnectors(w, { iface, front: iface.front === "olho" ? eye : rest, back: iface.back === "olho" ? eye : rest, settings: defaultConnectorSettings });
    expect(plan.embedded).toBe(true);
    expect(plan.points).toHaveLength(0);
    expect(plan.clearance).toBeGreaterThan(0);
    const applied = applyConnectors(w, parts, [iface], [plan]);
    expect(applied.checks[0]).toMatchObject({ ok: true });
    expect(signedVolume(applied.parts.get("cabeca")!.mesh)).toBeLessThan(signedVolume(rest.mesh) - 0.1);
    expect(signedVolume(applied.parts.get("olho")!.mesh)).toBeCloseTo(signedVolume(eye.mesh), 3);
  });

  it("com pintura à mão, um plano que não segue a pintura nunca é usado", () => {
    // Bota pintada só por fora, no modo "Contorno" desligado da reserva: o resultado é contorno ou
    // falha com explicação, nunca um plano que corta o funil.
    const fig = bootsFigure(w);
    const res = split(fig.mesh, paint(fig, ["pe", "cano", "funil-fora"]));
    expect(res.islands.some((i) => i.method === "plano")).toBe(false);
  });
});
