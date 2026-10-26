import { describeIssues } from "../core/analysis";
import { type ConnectorPlan, type ConnectorSettings, connectorKindNames, materialNames } from "../core/connectors";
import { baseName, slugify } from "../core/io/names";
import type { ParsedModel } from "../core/io/types";
import { bedPresets } from "../core/layout";
import {
  type Mat4,
  type PlaneFrame,
  type Vec2,
  type Vec3,
  dot,
  frameFromNormal,
  identity,
  multiply as multiplyMat,
  rotationAxisAngle,
  scaling,
} from "../core/math";
import { geometryFromMesh, cutTag } from "../core/part";
import type { RepairOptions } from "../core/repair";
import type { CutRecord, SplitMode } from "../core/split";
import { CancelledError, geometry } from "../worker/client";
import type { ExportGroup, ExportItem, FaceAttributes } from "../worker/protocol";
import { parseGLTF, parsePLY } from "./importers";
import { paintContext } from "./painting";
import { NEUTRAL, nextColor, paletteColor } from "./palette";
import {
  type Doc,
  type ModelState,
  type Part,
  type Region,
  type RegionSession,
  commit,
  emptyDoc,
  newPartId,
  patchDoc,
  setUi,
  store,
  toast,
} from "./state";
import type { AppliedConnectorsResult } from "./types";

// ---------------------------------------------------------------------------------------------
// Execução com progresso, cancelamento e mensagens de erro compreensíveis
// ---------------------------------------------------------------------------------------------

async function run<T>(label: string, fn: (progress: (f: number, l?: string) => void) => Promise<T>): Promise<T | undefined> {
  setUi({ busy: { label, fraction: 0, cancellable: true } });
  try {
    return await fn((fraction, l) => setUi({ busy: { label: l || label, fraction, cancellable: true } }));
  } catch (e) {
    if (e instanceof CancelledError) toast("aviso", "Operação cancelada.");
    else {
      console.error(e);
      toast("erro", (e as Error).message || String(e), 10000);
    }
    return undefined;
  } finally {
    setUi({ busy: null });
  }
}

export function cancelBusy() {
  geometry.cancelAll();
}

const doc = () => store.get().doc;
const ui = () => store.get().ui;

function invalidateDerived() {
  setUi({ plansStale: true, final: null });
}

// ---------------------------------------------------------------------------------------------
// Modelo
// ---------------------------------------------------------------------------------------------

export function remapAttrs(attrs: FaceAttributes, faceMap: Int32Array): FaceAttributes {
  const pick = <T extends Uint32Array | Uint16Array>(arr: T | undefined, make: (n: number) => T, none: number) => {
    if (!arr) return undefined;
    const out = make(faceMap.length);
    for (let i = 0; i < faceMap.length; i++) out[i] = faceMap[i] >= 0 ? arr[faceMap[i]] : none;
    return out;
  };
  return {
    colors: pick(attrs.colors, (n) => new Uint32Array(n), 0xcccccc),
    materials: pick(attrs.materials, (n) => new Uint16Array(n), 0),
    materialNames: attrs.materialNames,
    objects: pick(attrs.objects, (n) => new Uint16Array(n), 0),
    objectNames: attrs.objectNames,
  };
}

/** Atributos (cor/material/objeto) por face de uma peça, via a origem de cada triângulo. */
export function partAttributes(part: Part, attrs: FaceAttributes): FaceAttributes {
  const src = part.geometry.src;
  const map = Int32Array.from(src);
  return remapAttrs(attrs, map);
}

async function wholePart(model: ModelState, name: string): Promise<Part> {
  const g = geometryFromMesh(model.mesh);
  const stats = await geometry.call("partStats", { geometry: g });
  return { id: newPartId(), name, color: paletteColor(0), visible: true, geometry: g, stats };
}

async function installModel(model: ModelState, fresh: boolean) {
  const part = await wholePart(model, baseName(model.fileName));
  const s = store.get();
  const nextDoc: Doc = {
    ...(fresh ? emptyDoc : s.doc),
    model,
    original: fresh ? model : s.doc.original,
    parts: [part],
    cuts: [],
    nextCutId: 1,
    interfaces: [],
    regions: null,
    splitReport: null,
    connectors: fresh ? emptyDoc.connectors : { ...s.doc.connectors, overrides: {} },
  };
  if (fresh) store.set({ ...s, doc: nextDoc, past: [], future: [] });
  else commit(() => nextDoc);
  setUi({ selectedPartId: part.id, selectedInterfaceId: null, tool: "orbitar", planeFrame: null, explode: 0, layoutMode: "montada" });
  invalidateDerived();
}

export async function openFile(file: File) {
  const ext = file.name.toLowerCase().split(".").pop() ?? "";
  await run(`Abrindo ${file.name}`, async (progress) => {
    const buffer = await file.arrayBuffer();
    let parsed: ParsedModel;
    if (ext === "glb" || ext === "gltf") parsed = await parseGLTF(buffer);
    else if (ext === "ply") parsed = parsePLY(buffer);
    else if (["stl", "obj", "3mf"].includes(ext)) parsed = await geometry.call("parseFile", { name: file.name, buffer });
    else throw new Error(`Formato .${ext} não suportado. Use STL, OBJ, 3MF, GLB ou PLY.`);
    if (!parsed.soup.length) throw new Error("O arquivo não contém triângulos.");
    progress(0.5, "Analisando a malha");
    const prepared = await geometry.call("prepareModel", { parsed, rotateYUp: parsed.upAxis === "y" });
    progress(0.8, "Preparando a visualização");
    await installModel(
      {
        fileName: file.name,
        format: ext.toUpperCase(),
        mesh: prepared.mesh,
        report: prepared.report,
        manifoldOk: prepared.manifoldOk,
        attrs: prepared.attrs,
        notes: prepared.notes,
        repairLog: [],
      },
      true,
    );
    const r = prepared.report;
    toast(
      r.watertight ? "sucesso" : "aviso",
      r.watertight
        ? `${file.name}: ${r.triangles.toLocaleString("pt-BR")} triângulos, malha fechada.`
        : `${file.name} tem defeitos na malha. Veja a etapa Modelo e use "Reparar".`,
    );
  });
}

export async function loadSample() {
  await run("Gerando o boneco de exemplo", async () => {
    const mesh = await geometry.call("sample", { detail: 64 });
    const t = await geometry.call("transformModel", { mesh, matrix: identity() });
    await installModel(
      {
        fileName: "boneco_exemplo.stl",
        format: "STL",
        mesh: t.mesh,
        report: t.report,
        manifoldOk: t.manifoldOk,
        attrs: {},
        notes: ["Modelo de exemplo gerado no navegador: todas as partes fundidas em uma casca só."],
        repairLog: [],
      },
      true,
    );
  });
}

export async function repairModel(options: RepairOptions) {
  const m = doc().model;
  if (!m) return;
  await run("Reparando a malha", async () => {
    const r = await geometry.call("repair", { mesh: m.mesh, options });
    await installModel(
      { ...m, mesh: r.mesh, report: r.report, manifoldOk: r.manifoldOk, attrs: remapAttrs(m.attrs, r.faceMap), repairLog: r.log },
      false,
    );
    toast(r.manifoldOk ? "sucesso" : "aviso", r.manifoldOk ? "Malha reparada e fechada." : "Reparo parcial: ainda há defeitos. Tente a reconstrução por voxels.");
  });
}

export async function remeshModel(resolution: number) {
  const m = doc().model;
  if (!m) return;
  await run("Reconstruindo por voxels", async (progress) => {
    const r = await geometry.call("remesh", { mesh: m.mesh, resolution }, (f, l) => progress(f, l));
    await installModel(
      {
        ...m,
        mesh: r.mesh,
        report: r.report,
        manifoldOk: r.manifoldOk,
        attrs: {},
        repairLog: [`Malha reconstruída por voxels (${resolution} células no maior lado). Cores e materiais foram descartados.`],
      },
      false,
    );
    toast("sucesso", "Malha reconstruída como sólido fechado.");
  });
}

export async function checkIntersections() {
  const m = doc().model;
  if (!m) return;
  await run("Procurando autointerseções", async () => {
    const { count } = await geometry.call("selfIntersections", { mesh: m.mesh, limit: 1000 });
    patchDoc((d) => {
      if (!d.model || d.model.mesh !== m.mesh) return d;
      const report = { ...d.model.report, selfIntersections: count };
      report.issues = describeIssues(report);
      return { ...d, model: { ...d.model, report } };
    });
    toast(count ? "aviso" : "sucesso", count ? `${count}${count >= 1000 ? "+" : ""} pares de triângulos se cruzam.` : "Nenhuma autointerseção encontrada.");
  });
}

export async function transformModel(matrix: Mat4, label: string) {
  const m = doc().model;
  if (!m) return;
  await run(label, async () => {
    const r = await geometry.call("transformModel", { mesh: m.mesh, matrix });
    await installModel({ ...m, mesh: r.mesh, report: r.report, manifoldOk: r.manifoldOk }, false);
  });
}

export function rotateModel(axis: "x" | "y" | "z", degrees: number) {
  const v: Vec3 = axis === "x" ? [1, 0, 0] : axis === "y" ? [0, 1, 0] : [0, 0, 1];
  return transformModel(rotationAxisAngle(v, degrees), "Girando o modelo");
}

export function scaleModel(factor: number) {
  if (!(factor > 0) || Math.abs(factor - 1) < 1e-9) return;
  return transformModel(scaling(factor), "Ajustando a escala");
}

export function mirrorModel(axis: "x" | "y") {
  const m = identity();
  m[axis === "x" ? 0 : 5] = -1;
  return transformModel(m, "Espelhando o modelo");
}

export async function restoreOriginal() {
  const o = doc().original;
  if (!o) return;
  await run("Restaurando o modelo original", async () => {
    await installModel(o, false);
    toast("info", "Modelo original restaurado (desfazer volta ao estado anterior).");
  });
}

// ---------------------------------------------------------------------------------------------
// Peças
// ---------------------------------------------------------------------------------------------

export function selectPart(id: string | null) {
  setUi({ selectedPartId: id });
}

export function renamePart(id: string, name: string) {
  commit((d) => ({ ...d, parts: d.parts.map((p) => (p.id === id ? { ...p, name } : p)) }));
}

export function setPartColor(id: string, color: string) {
  commit((d) => ({ ...d, parts: d.parts.map((p) => (p.id === id ? { ...p, color } : p)) }));
}

export function togglePartVisible(id: string) {
  patchDoc((d) => ({ ...d, parts: d.parts.map((p) => (p.id === id ? { ...p, visible: !p.visible } : p)) }));
}

export function showAllParts() {
  patchDoc((d) => ({ ...d, parts: d.parts.map((p) => ({ ...p, visible: true })) }));
}

export function isolatePart(id: string) {
  patchDoc((d) => ({ ...d, parts: d.parts.map((p) => ({ ...p, visible: p.id === id })) }));
}

export async function refreshInterfaces() {
  const d = doc();
  if (!d.parts.length) return;
  const ifaces = await geometry.call("interfaces", {
    parts: d.parts.map((p) => ({ id: p.id, geometry: p.geometry })),
    cuts: d.cuts,
  });
  patchDoc((cur) => (cur.parts === d.parts ? { ...cur, interfaces: ifaces } : cur));
  invalidateDerived();
}

function replacePart(d: Doc, id: string, replacements: Part[]): Part[] {
  const i = d.parts.findIndex((p) => p.id === id);
  if (i < 0) return d.parts;
  return [...d.parts.slice(0, i), ...replacements, ...d.parts.slice(i + 1)];
}

export async function separateLoose(id: string) {
  const part = doc().parts.find((p) => p.id === id);
  if (!part) return;
  await run("Separando cascas soltas", async () => {
    const pieces = await geometry.call("separateComponents", { geometry: part.geometry });
    if (pieces.length < 2) {
      toast("info", "Esta peça já é uma casca única.");
      return;
    }
    const used = doc().parts.map((p) => p.color);
    const parts = pieces.map((p, i) => ({
      id: newPartId(),
      name: `${part.name} ${i + 1}`,
      color: i === 0 ? part.color : nextColor([...used, ...pieces.slice(0, i).map(() => "")]),
      visible: true,
      geometry: p.geometry,
      stats: p.stats,
    }));
    parts.forEach((p, i) => {
      if (i > 0) p.color = nextColor([...used, ...parts.slice(0, i).map((x) => x.color)]);
    });
    commit((d) => ({ ...d, parts: replacePart(d, id, parts), regions: d.regions?.partId === id ? null : d.regions }));
    await refreshInterfaces();
    toast("sucesso", `${parts.length} peças separadas.`);
  });
}

export async function mergeSelected(ids: string[]) {
  const parts = doc().parts.filter((p) => ids.includes(p.id));
  if (parts.length < 2) return;
  await run("Juntando peças", async () => {
    const r = await geometry.call("mergeParts", { geometries: parts.map((p) => p.geometry) });
    const merged: Part = { id: newPartId(), name: parts[0].name, color: parts[0].color, visible: true, geometry: r.geometry, stats: r.stats };
    commit((d) => {
      const first = d.parts.findIndex((p) => p.id === parts[0].id);
      const rest = d.parts.filter((p) => !ids.includes(p.id));
      rest.splice(Math.min(first, rest.length), 0, merged);
      return { ...d, parts: rest, regions: d.regions && ids.includes(d.regions.partId) ? null : d.regions };
    });
    setUi({ selectedPartId: merged.id });
    await refreshInterfaces();
  });
}

export function deletePart(id: string) {
  commit((d) => ({
    ...d,
    parts: d.parts.filter((p) => p.id !== id),
    regions: d.regions?.partId === id ? null : d.regions,
  }));
  if (ui().selectedPartId === id) setUi({ selectedPartId: doc().parts[0]?.id ?? null });
  refreshInterfaces();
}

// ---------------------------------------------------------------------------------------------
// Regiões (divisão automática, por seleção e manual)
// ---------------------------------------------------------------------------------------------

function targetPart(): Part | undefined {
  const d = doc();
  const id = d.regions?.partId ?? ui().selectedPartId ?? d.parts[0]?.id;
  return d.parts.find((p) => p.id === id);
}

/** Garante uma sessão de pintura na peça selecionada (com uma região nova pronta para pintar). */
export function ensureRegionSession(): RegionSession | null {
  const d = doc();
  const part = d.parts.find((p) => p.id === (ui().selectedPartId ?? d.parts[0]?.id));
  if (!part) return null;
  if (d.regions?.partId === part.id) return d.regions;
  const regions: Region[] = [
    { id: 0, name: part.name, color: NEUTRAL, separate: false },
    { id: 1, name: "Região 1", color: paletteColor(1), separate: true },
  ];
  const session: RegionSession = {
    partId: part.id,
    labels: new Uint16Array(part.stats.triangles),
    regions,
    baseId: 0,
    source: "manual",
    notes: [],
  };
  commit((cur) => ({ ...cur, regions: session }));
  setUi({ activeRegion: 1 });
  return session;
}

export async function runAutoSegmentation() {
  const part = targetPart();
  const model = doc().model;
  if (!part || !model) return;
  const seg = ui().segmentation;
  await run("Analisando o modelo", async (progress) => {
    const result = await geometry.call(
      "segment",
      {
        mesh: part.geometry.mesh,
        attrs: partAttributes(part, model.attrs),
        providerId: seg.providerId,
        options: { maxSegments: seg.maxSegments, sensitivity: seg.sensitivity, minAreaFraction: 0.01 },
        remote: seg.providerId === "remoto" ? { url: seg.remoteUrl } : undefined,
      },
      (f, l) => progress(f, l),
    );
    const base = result.segments.find((s) => !s.suggestedSeparate)?.id ?? 0;
    const regions: Region[] = result.segments.map((s, i) => ({
      id: s.id,
      name: s.name,
      color: s.id === base ? NEUTRAL : paletteColor(i),
      separate: s.suggestedSeparate,
    }));
    commit((d) => ({
      ...d,
      regions: { partId: part.id, labels: result.labels, regions, baseId: base, source: seg.providerId, notes: result.notes },
    }));
    setUi({ activeRegion: regions.find((r) => r.separate)?.id ?? base });
    toast("sucesso", `${regions.length} região(ões) encontradas. Revise, ajuste e clique em "Gerar peças".`);
  });
}

export function discardRegions() {
  commit((d) => ({ ...d, regions: null }));
}

function updateSession(update: (s: RegionSession) => RegionSession) {
  commit((d) => (d.regions ? { ...d, regions: update(d.regions) } : d));
}

export function commitLabels(labels: Uint16Array) {
  updateSession((s) => ({ ...s, labels }));
}

export function addRegion(name?: string) {
  const s = doc().regions ?? ensureRegionSession();
  if (!s) return;
  const id = Math.max(...s.regions.map((r) => r.id)) + 1;
  const region: Region = {
    id,
    name: name ?? `Região ${s.regions.length}`,
    color: nextColor(s.regions.map((r) => r.color)),
    separate: true,
  };
  updateSession((cur) => ({ ...cur, regions: [...cur.regions, region] }));
  setUi({ activeRegion: id });
}

export function renameRegion(id: number, name: string) {
  updateSession((s) => ({ ...s, regions: s.regions.map((r) => (r.id === id ? { ...r, name } : r)) }));
}

export function setRegionColor(id: number, color: string) {
  updateSession((s) => ({ ...s, regions: s.regions.map((r) => (r.id === id ? { ...r, color } : r)) }));
}

export function toggleRegionSeparate(id: number) {
  updateSession((s) => ({
    ...s,
    regions: s.regions.map((r) => (r.id === id && id !== s.baseId ? { ...r, separate: !r.separate } : r)),
  }));
}

export function setBaseRegion(id: number) {
  updateSession((s) => ({ ...s, baseId: id, regions: s.regions.map((r) => (r.id === id ? { ...r, separate: false } : r)) }));
}

/** Junta a região `from` em `into` (as faces passam a ser de `into`). */
export function mergeRegion(from: number, into: number) {
  updateSession((s) => {
    if (from === s.baseId) return s;
    const labels = s.labels.slice();
    for (let f = 0; f < labels.length; f++) if (labels[f] === from) labels[f] = into;
    return { ...s, labels, regions: s.regions.filter((r) => r.id !== from) };
  });
  if (ui().activeRegion === from) setUi({ activeRegion: into });
}

/** Seleções rápidas: quais regiões viram peças, pelo nome sugerido. */
export function presetSeparate(kind: "cabeca" | "membros" | "tudo" | "nada") {
  updateSession((s) => ({
    ...s,
    regions: s.regions.map((r) => {
      if (r.id === s.baseId) return r;
      const n = r.name.toLowerCase();
      // Pescoço e acessórios não marcados acompanham a peça vizinha (ver attachDetachedBase).
      const head = n.startsWith("cabeça");
      const limb = /^(braço|perna|mão|pé)/.test(n);
      const separate = kind === "tudo" ? true : kind === "nada" ? false : kind === "cabeca" ? head : head || limb;
      return { ...r, separate };
    }),
  }));
}

/** Fração da área da peça em cada região. */
export function regionAreas(s: RegionSession, part: Part): Map<number, number> {
  const { areas } = paintContext(part.geometry.mesh);
  const sums = new Map<number, number>();
  let total = 0;
  for (let f = 0; f < s.labels.length; f++) {
    sums.set(s.labels[f], (sums.get(s.labels[f]) ?? 0) + areas[f]);
    total += areas[f];
  }
  const out = new Map<number, number>();
  for (const [k, a] of sums) out.set(k, total > 0 ? a / total : 0);
  return out;
}

export async function applyRegionSplit(mode: SplitMode) {
  const d = doc();
  const s = d.regions;
  const part = s && d.parts.find((p) => p.id === s.partId);
  if (!s || !part) return;
  const separate = s.regions.filter((r) => r.separate && r.id !== s.baseId).map((r) => r.id);
  const present = new Set(s.labels);
  const missing = separate.filter((id) => !present.has(id));
  const effective = separate.filter((id) => present.has(id));
  if (!effective.length) {
    toast("aviso", missing.length ? "As regiões marcadas ainda não têm faces pintadas." : "Marque ao menos uma região para separar.");
    return;
  }
  await run("Dividindo em peças", async (progress) => {
    const res = await geometry.call(
      "splitRegions",
      { geometry: part.geometry, labels: s.labels, separate: effective, baseLabel: s.baseId, mode, firstCutId: d.nextCutId },
      (f, l) => progress(f, l),
    );
    const regionOf = new Map(s.regions.map((r) => [r.id, r]));
    const used = d.parts.filter((p) => p.id !== part.id).map((p) => p.color);
    const parts: Part[] = res.parts.map((p) => {
      const region = regionOf.get(p.label);
      const isBase = p.label === s.baseId;
      const color = isBase ? part.color : region && region.color !== NEUTRAL ? region.color : nextColor(used);
      used.push(color);
      return {
        id: newPartId(),
        name: isBase ? (region?.name ?? part.name) : (region?.name ?? `Parte ${p.label}`),
        color,
        visible: true,
        geometry: p.geometry,
        stats: p.stats,
      };
    });
    commit((cur) => ({
      ...cur,
      parts: replacePart(cur, part.id, parts),
      cuts: [...cur.cuts, ...res.cuts],
      nextCutId: res.nextCutId,
      regions: null,
      splitReport: res.islands.map((i) => ({ ...i, message: i.message ? `${regionOf.get(i.label)?.name ?? ""}: ${i.message}` : undefined })),
    }));
    setUi({ selectedPartId: parts[0]?.id ?? null, explode: 0.35, tool: "orbitar" });
    await refreshInterfaces();
    const failed = res.islands.filter((i) => i.method === "falhou").length;
    const seams = res.islands.filter((i) => i.method === "contorno").length;
    toast(
      failed ? "aviso" : "sucesso",
      `${parts.length} peças geradas` +
        (seams ? `; ${seams} corte(s) seguiram o contorno pintado` : "") +
        (failed ? `; ${failed} região(ões) não puderam ser separadas` : "") +
        ".",
    );
  });
}

// ---------------------------------------------------------------------------------------------
// Corte por plano
// ---------------------------------------------------------------------------------------------

export function startPlaneTool() {
  const part = targetPart();
  if (!part) return;
  const b = part.stats.bounds;
  const c: Vec3 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
  setUi({ tool: "plano", planeFrame: frameFromNormal(c, [0, 0, 1]), selectedPartId: part.id });
}

export function setPlaneNormal(normal: Vec3) {
  const f = ui().planeFrame;
  if (!f) return;
  setUi({ planeFrame: frameFromNormal(f.origin, normal) });
}

export function flipPlane() {
  const f = ui().planeFrame;
  if (!f) return;
  setUi({ planeFrame: frameFromNormal(f.origin, [-f.normal[0], -f.normal[1], -f.normal[2]]) });
}

/** Posição do plano ao longo da normal, de 0 a 1 dentro da caixa da peça. */
export function planePosition(fraction: number) {
  const f = ui().planeFrame;
  const part = targetPart();
  if (!f || !part) return;
  const b = part.stats.bounds;
  const corners: Vec3[] = [];
  for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) corners.push([x, y, z]);
  const ds = corners.map((p) => dot(p, f.normal));
  const lo = Math.min(...ds);
  const hi = Math.max(...ds);
  const target = lo + (hi - lo) * fraction;
  const shift = target - dot(f.origin, f.normal);
  setUi({
    planeFrame: {
      ...f,
      origin: [f.origin[0] + f.normal[0] * shift, f.origin[1] + f.normal[1] * shift, f.origin[2] + f.normal[2] * shift],
    },
  });
}

export function planeFraction(frame: PlaneFrame, part: Part): number {
  const b = part.stats.bounds;
  const corners: Vec3[] = [];
  for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) corners.push([x, y, z]);
  const ds = corners.map((p) => dot(p, frame.normal));
  const lo = Math.min(...ds);
  const hi = Math.max(...ds);
  return hi > lo ? (dot(frame.origin, frame.normal) - lo) / (hi - lo) : 0.5;
}

function sideNames(n: Vec3): [string, string] {
  if (n[2] > 0.7) return ["superior", "inferior"];
  if (n[2] < -0.7) return ["inferior", "superior"];
  if (Math.abs(n[0]) >= Math.abs(n[1])) return n[0] > 0 ? ["direita", "esquerda"] : ["esquerda", "direita"];
  return n[1] > 0 ? ["trás", "frente"] : ["frente", "trás"];
}

export async function applyPlaneCut() {
  const f = ui().planeFrame;
  const part = targetPart();
  if (!f || !part) return;
  const d = doc();
  await run("Cortando com o plano", async () => {
    const res = await geometry.call("cutPlane", {
      geometry: part.geometry,
      frame: f,
      cutId: d.nextCutId,
      separateComponents: ui().planeSeparate,
    });
    const [a, b] = sideNames(f.normal);
    const used = d.parts.filter((p) => p.id !== part.id).map((p) => p.color);
    const make = (list: typeof res.front, suffix: string, keepColor: boolean): Part[] =>
      list.map((x, i) => {
        const color = keepColor && i === 0 ? part.color : nextColor(used);
        used.push(color);
        return {
          id: newPartId(),
          name: `${part.name} – ${suffix}${list.length > 1 ? ` ${i + 1}` : ""}`,
          color,
          visible: true,
          geometry: x.geometry,
          stats: x.stats,
        };
      });
    const parts = [...make(res.back, b, true), ...make(res.front, a, false)];
    commit((cur) => ({
      ...cur,
      parts: replacePart(cur, part.id, parts),
      cuts: [...cur.cuts, { id: cur.nextCutId, kind: "plane", frame: f }],
      nextCutId: cur.nextCutId + 1,
      regions: cur.regions?.partId === part.id ? null : cur.regions,
    }));
    setUi({ tool: "orbitar", planeFrame: null, selectedPartId: parts[parts.length - 1].id, explode: Math.max(ui().explode, 0.25) });
    await refreshInterfaces();
    toast("sucesso", `Peça cortada em ${parts.length}.`);
  });
}

export function cancelPlaneTool() {
  setUi({ tool: "orbitar", planeFrame: null });
}

/** Divide automaticamente as peças que não cabem na mesa. */
export async function autoFitAll() {
  const d = doc();
  const bed = d.print.bed;
  const big = d.parts.filter((p) => {
    const s = [...p.stats.size].sort((x, y) => x - y);
    const b = [...bed].sort((x, y) => x - y);
    return s[0] > b[0] - 1 || s[1] > b[1] - 1 || s[2] > b[2] - 1;
  });
  if (!big.length) {
    toast("info", "Todas as peças já cabem na mesa (em alguma orientação).");
    return;
  }
  await run("Dividindo para caber na mesa", async (progress) => {
    let nextCutId = d.nextCutId;
    const newCuts: CutRecord[] = [];
    let parts = d.parts;
    for (const [i, part] of big.entries()) {
      progress(i / big.length, `Dividindo ${part.name}`);
      const r = await geometry.call("autoFit", { geometry: part.geometry, bed, firstCutId: nextCutId, maxPieces: 24 });
      nextCutId = r.nextCutId;
      newCuts.push(...r.cuts);
      const used = parts.map((p) => p.color);
      const pieces: Part[] = r.pieces.map((x, k) => {
        const color = k === 0 ? part.color : nextColor(used);
        used.push(color);
        return { id: newPartId(), name: `${part.name} ${k + 1}`, color, visible: true, geometry: x.geometry, stats: x.stats };
      });
      const idx = parts.findIndex((p) => p.id === part.id);
      parts = [...parts.slice(0, idx), ...pieces, ...parts.slice(idx + 1)];
      if (!r.fits) toast("aviso", `${part.name}: mesmo dividida, alguma parte ainda não coube.`);
    }
    commit((cur) => ({ ...cur, parts, cuts: [...cur.cuts, ...newCuts], nextCutId, regions: null }));
    await refreshInterfaces();
    toast("sucesso", "Peças grandes divididas para caber na mesa.");
  });
}

// ---------------------------------------------------------------------------------------------
// Encaixes
// ---------------------------------------------------------------------------------------------

export function effectiveSettings(d: Doc, interfaceId: string): ConnectorSettings {
  return { ...d.connectors.defaults, ...(d.connectors.overrides[interfaceId]?.settings ?? {}) };
}

export function updateConnectorDefaults(partial: Partial<ConnectorSettings>) {
  commit((d) => ({ ...d, connectors: { ...d.connectors, defaults: { ...d.connectors.defaults, ...partial } } }));
  invalidateDerived();
}

export function updateConnectorOverride(interfaceId: string, partial: Partial<ConnectorSettings> | null) {
  commit((d) => {
    const cur = d.connectors.overrides[interfaceId] ?? {};
    const settings = partial === null ? undefined : { ...(cur.settings ?? {}), ...partial };
    return { ...d, connectors: { ...d.connectors, overrides: { ...d.connectors.overrides, [interfaceId]: { ...cur, settings } } } };
  });
  invalidateDerived();
}

export function setManualPoints(interfaceId: string, points: Vec2[] | undefined) {
  commit((d) => {
    const cur = d.connectors.overrides[interfaceId] ?? {};
    return { ...d, connectors: { ...d.connectors, overrides: { ...d.connectors.overrides, [interfaceId]: { ...cur, points } } } };
  });
  invalidateDerived();
}

let planSeq = 0;
export async function computePlans(): Promise<ConnectorPlan[]> {
  const d = doc();
  const seq = ++planSeq;
  const byId = new Map(d.parts.map((p) => [p.id, p]));
  const items = d.interfaces
    .filter((i) => byId.has(i.front) && byId.has(i.back))
    .map((iface) => ({
      iface,
      front: byId.get(iface.front)!.geometry,
      back: byId.get(iface.back)!.geometry,
      settings: effectiveSettings(d, iface.id),
      manualPoints: d.connectors.overrides[iface.id]?.points,
    }));
  if (!items.length) {
    setUi({ plans: [], plansStale: false });
    return [];
  }
  const plans = await geometry.call("planConnectors", { items });
  if (seq === planSeq && doc() === d) setUi({ plans, plansStale: false });
  return plans;
}

export async function refreshPlans() {
  await run("Planejando encaixes", () => computePlans());
}

function maleTags(d: Doc, plans: ConnectorPlan[]): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const plan of plans) {
    if (!plan.points.length || plan.kind === "dowel" || plan.kind === "magnet" || plan.kind === "none") continue;
    const iface = d.interfaces.find((i) => i.id === plan.interfaceId);
    if (!iface) continue;
    const id = plan.maleSide === "front" ? iface.front : iface.back;
    const tag = cutTag(iface.cutId, plan.maleSide === "front" ? 0 : 1);
    out.set(id, [...(out.get(id) ?? []), tag]);
  }
  return out;
}

/** Aplica os encaixes e organiza as peças nas mesas (resultado usado na impressão e exportação). */
export async function buildFinal(): Promise<AppliedConnectorsResult | undefined> {
  return run("Gerando as peças finais", async (progress) => {
    const d = doc();
    const plans = ui().plansStale ? await computePlans() : ui().plans;
    progress(0.2, "Aplicando pinos e furos");
    const res = await geometry.call("applyConnectors", {
      parts: d.parts.map((p) => ({ id: p.id, geometry: p.geometry })),
      interfaces: d.interfaces,
      plans,
    });
    const extras = res.extras.map((e, i) => ({ ...e, id: `cavilha_${i}`, name: `Cavilha ${i + 1}` }));
    progress(0.75, "Organizando nas mesas");
    const tags = maleTags(d, plans);
    const layout = await geometry.call("layout", {
      parts: [
        ...res.parts.map((p) => ({ id: p.id, geometry: p.geometry, maleTags: tags.get(p.id) ?? [], rotation: d.print.rotations[p.id] })),
        ...extras.map((e) => ({ id: e.id, geometry: e.geometry, maleTags: [], rotation: d.print.rotations[e.id] })),
      ],
      bed: d.print.bed,
    });
    const final: AppliedConnectorsResult = { parts: res.parts, extras, checks: res.checks, layout };
    if (doc() === d) setUi({ final });
    const bad = res.checks.filter((c) => !c.ok);
    if (bad.length) toast("aviso", `${bad.length} encaixe(s) com problema: veja a lista de encaixes.`);
    return final;
  });
}

// ---------------------------------------------------------------------------------------------
// Impressão
// ---------------------------------------------------------------------------------------------

/** Refaz só a distribuição nas mesas (sem reaplicar encaixes). */
export async function relayout() {
  const final = ui().final;
  if (!final) {
    await buildFinal();
    return;
  }
  await run("Organizando nas mesas", async () => {
    const d = doc();
    const tags = maleTags(d, ui().plans);
    const layout = await geometry.call("layout", {
      parts: [
        ...final.parts.map((p) => ({ id: p.id, geometry: p.geometry, maleTags: tags.get(p.id) ?? [], rotation: d.print.rotations[p.id] })),
        ...final.extras.map((e) => ({ id: e.id, geometry: e.geometry, maleTags: [], rotation: d.print.rotations[e.id] })),
      ],
      bed: d.print.bed,
    });
    if (ui().final === final) setUi({ final: { ...final, layout } });
  });
}

/** Gira a peça 90° na mesa (a partir da orientação atual) e fixa essa orientação. */
export async function rotatePartOnBed(id: string, axis: "x" | "y" | "z") {
  const placement = ui().final?.layout?.placements.find((p) => p.id === id);
  const current = (placement ? (placement.matrix.slice() as Mat4) : identity()) as Mat4;
  current[12] = 0;
  current[13] = 0;
  current[14] = 0;
  const v: Vec3 = axis === "x" ? [1, 0, 0] : axis === "y" ? [0, 1, 0] : [0, 0, 1];
  const next = multiplyMat(rotationAxisAngle(v, 90), current);
  patchDoc((d) => ({ ...d, print: { ...d.print, rotations: { ...d.print.rotations, [id]: next } } }));
  await relayout();
}

export async function resetPartRotation(id: string) {
  patchDoc((d) => {
    const rotations = { ...d.print.rotations };
    delete rotations[id];
    return { ...d, print: { ...d.print, rotations } };
  });
  await relayout();
}

export function setBedPreset(id: string) {
  const preset = bedPresets.find((b) => b.id === id);
  if (!preset) return;
  commit((d) => ({ ...d, print: { ...d.print, bedId: id, bed: id === "custom" ? d.print.bed : preset.size } }));
  invalidateDerived();
}

export function setCustomBed(size: Vec3) {
  commit((d) => ({ ...d, print: { ...d.print, bedId: "custom", bed: size } }));
  invalidateDerived();
}

export function setMaterial(material: ConnectorSettings["material"]) {
  commit((d) => ({
    ...d,
    print: { ...d.print, material },
    connectors: { ...d.connectors, defaults: { ...d.connectors.defaults, material } },
  }));
  invalidateDerived();
}

export const densities: Record<ConnectorSettings["material"], number> = {
  pla: 1.24,
  petg: 1.27,
  abs: 1.04,
  tpu: 1.21,
  resina: 1.12,
};

/** Massa estimada (g) com paredes de 1,2 mm e preenchimento informado (aproximação grosseira). */
export function estimateMass(volume: number, area: number, material: ConnectorSettings["material"], infill: number): number {
  const shell = Math.min(volume, area * 1.2);
  const core = Math.max(0, volume - shell);
  const solid = material === "resina" ? volume : shell + core * infill;
  return (solid / 1000) * densities[material];
}

// ---------------------------------------------------------------------------------------------
// Exportação
// ---------------------------------------------------------------------------------------------

export interface ExportOptions {
  stl: boolean;
  threeMF: boolean;
  obj: boolean;
  assembled: boolean;
  printReady: boolean;
  includeDowels: boolean;
}

function download(name: string, data: Uint8Array) {
  const blob = new Blob([data.slice().buffer], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function readme(d: Doc, final: AppliedConnectorsResult, plans: ConnectorPlan[]): string {
  const lines = [
    `Projeto exportado pelo OmniSlice em ${new Date().toLocaleString("pt-BR")}`,
    `Modelo: ${d.model?.fileName ?? "-"}`,
    `Material: ${materialNames[d.print.material]}  |  Mesa: ${d.print.bed.join(" × ")} mm`,
    "",
    "PEÇAS",
  ];
  const byId = new Map(d.parts.map((p) => [p.id, p]));
  for (const p of final.parts) {
    const part = byId.get(p.id);
    const s = p.stats.size.map((v) => v.toFixed(1)).join(" × ");
    lines.push(`- ${part?.name ?? p.id}: ${s} mm, ${(p.stats.volume / 1000).toFixed(1)} cm³`);
  }
  for (const e of final.extras) lines.push(`- ${e.name}: pino avulso`);
  lines.push("", "ENCAIXES");
  for (const plan of plans) {
    const iface = d.interfaces.find((i) => i.id === plan.interfaceId);
    if (!iface || !plan.points.length) continue;
    const a = byId.get(iface.front)?.name ?? "?";
    const b = byId.get(iface.back)?.name ?? "?";
    lines.push(
      `- ${a} ↔ ${b}: ${plan.points.length} × ${connectorKindNames[plan.kind]} ${plan.size} mm, comprimento ${plan.length} mm, folga ${plan.clearance} mm`,
    );
  }
  lines.push(
    "",
    "DICAS",
    "- As folgas são valores de referência: imprima um teste de encaixe com o seu material e ajuste se precisar.",
    "- Na pasta impressao/ as peças já estão orientadas, com a face de corte apoiada na mesa quando possível.",
    "- Pinos avulsos (cavilhas) imprimem melhor em pé; ímãs devem ser colados com a polaridade conferida.",
  );
  return lines.join("\n");
}

export async function exportProject(opts: ExportOptions) {
  const d = doc();
  if (!d.parts.length) return;
  const final = ui().final ?? (await buildFinal());
  if (!final) return;
  await run("Gerando arquivos", async (progress) => {
    const formats = [...(opts.stl ? ["stl" as const] : []), ...(opts.threeMF ? ["3mf" as const] : []), ...(opts.obj ? ["obj" as const] : [])];
    if (!formats.length) throw new Error("Escolha pelo menos um formato.");
    const byId = new Map(d.parts.map((p) => [p.id, p]));
    const items: (ExportItem & { id: string })[] = final.parts.map((p) => ({
      id: p.id,
      name: byId.get(p.id)?.name ?? p.id,
      mesh: p.geometry.mesh,
      color: byId.get(p.id)?.color,
    }));
    if (opts.includeDowels)
      for (const e of final.extras) items.push({ id: e.id, name: e.name, mesh: e.geometry.mesh, color: "#ffd166" });
    const title = baseName(d.model?.fileName ?? "projeto");
    const groups: ExportGroup[] = [];
    if (opts.assembled) groups.push({ folder: "montada", title: `${title}_montado`, items, formats });
    if (opts.printReady && final.layout) {
      const place = new Map(final.layout.placements.map((p) => [p.id, p]));
      const printItems = items.filter((it) => place.has(it.id)).map((it) => ({ ...it, transform: place.get(it.id)!.matrix }));
      groups.push({
        folder: "impressao",
        title: `${title}_impressao`,
        items: printItems,
        formats,
        plates: printItems.map((it) => place.get(it.id)!.plate),
      });
    }
    const plans = ui().plans;
    const zipName = `${slugify(title)}_pecas.zip`;
    const files = await geometry.call(
      "exportFiles",
      { groups, texts: [{ name: "LEIAME.txt", text: readme(d, final, plans) }], zipName },
      (f, l) => progress(f, l),
    );
    for (const f of files) download(f.name, f.data);
    toast("sucesso", `Arquivo ${zipName} gerado com ${items.length} peça(s).`);
  });
}

/** Baixa uma peça avulsa em STL (já com encaixes, se calculados). */
export async function exportSinglePart(id: string) {
  const d = doc();
  const part = d.parts.find((p) => p.id === id);
  if (!part) return;
  const final = ui().final?.parts.find((p) => p.id === id);
  await run("Gerando STL", async () => {
    const files = await geometry.call("exportFiles", {
      groups: [{ folder: "", title: part.name, items: [{ name: part.name, mesh: (final ?? part).geometry.mesh }], formats: ["stl"] }],
      texts: [],
    });
    for (const f of files) download(f.name, f.data);
  });
}

