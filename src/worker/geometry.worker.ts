import Module from "manifold-3d";
import wasmUrl from "manifold-3d/manifold.wasm?url";
import { strToU8, zipSync } from "fflate";
import { analyzeMesh } from "../core/analysis";
import { autoFitSplit } from "../core/autofit";
import { countSelfIntersections } from "../core/bvh";
import { applyConnectors, femaleHints, planConnectors, resolveConnectorConflicts } from "../core/connectors";
import { decimateManifold } from "../core/decimate";
import { slugify, uniqueSlugs } from "../core/io/names";
import { parseOBJ, writeOBJ } from "../core/io/obj";
import { parseSTL, writeSTL } from "../core/io/stl";
import { parse3MF, write3MF } from "../core/io/threemf";
import { layoutPlates } from "../core/layout";
import { GeometryError, RunRegistry, type Wasm, configureManifold, getManifold } from "../core/manifoldBridge";
import { type Mat4, rotationAxisAngle, translation } from "../core/math";
import {
  type IndexedMesh,
  computeBounds,
  faceComponents,
  signedVolume,
  surfaceArea,
  transformMesh,
  triCount,
  weldSoup,
} from "../core/mesh";
import { CONNECTOR_TAG, type PartGeometry } from "../core/part";
import { voxelRemesh } from "../core/remesh";
import { orientConsistently, repairMesh } from "../core/repair";
import { buildSampleFigure } from "../core/sample";
import { computeInterfaces, cutByPlane, splitByRegions, splitComponents, unionParts, wasmTriangulator } from "../core/split";
import { localProviders, remoteProvider } from "../segmentation/providers";
import { runSegmentation } from "../segmentation/run";
import { sampleThickness } from "../segmentation/sdf";
import type { OpName, Ops, PartStats, Request, Response } from "./protocol";

configureManifold(() => Module({ locateFile: () => wasmUrl }));

const ctx = self as unknown as {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  onmessage: ((ev: MessageEvent<Request>) => void) | null;
};

function post(msg: Response, transfer: Transferable[] = []) {
  ctx.postMessage(msg, transfer);
}

function manifoldOk(w: Wasm, mesh: IndexedMesh): boolean {
  try {
    const m = new w.Manifold(new w.Mesh({ numProp: 3, vertProperties: mesh.positions, triVerts: mesh.indices }));
    m.delete();
    return true;
  } catch {
    return false;
  }
}

/** Centraliza em XY e apoia o modelo em Z = 0. */
function normalizePlacement(mesh: IndexedMesh): IndexedMesh {
  const b = computeBounds(mesh.positions);
  const t = translation(-(b.min[0] + b.max[0]) / 2, -(b.min[1] + b.max[1]) / 2, -b.min[2]);
  return transformMesh(mesh, t);
}

function statsOf(w: Wasm, g: PartGeometry): PartStats {
  const bounds = computeBounds(g.mesh.positions);
  let solid = false;
  let genus = 0;
  try {
    const m = new RunRegistry(w).fromGeometry(g);
    genus = m.genus();
    m.delete();
    solid = true;
  } catch {
    solid = false;
  }
  const n = triCount(g.mesh);
  return {
    triangles: n,
    volume: Math.abs(signedVolume(g.mesh)),
    area: surfaceArea(g.mesh),
    bounds,
    size: [bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]],
    components: faceComponents(g.mesh).count,
    genus,
    solid,
    thinWall: n ? sampleThickness(g.mesh, Math.min(1500, n), (f) => g.cut[f] === CONNECTOR_TAG).p10 : 0,
  };
}

type Handler<K extends OpName> = (args: Ops[K]["args"], progress: (f: number, label: string) => void) => Promise<Ops[K]["result"]>;

const handlers: { [K in OpName]: Handler<K> } = {
  async parseFile({ name, buffer }) {
    const ext = name.toLowerCase().split(".").pop();
    if (ext === "stl") return parseSTL(buffer);
    if (ext === "obj") return parseOBJ(new TextDecoder().decode(buffer));
    if (ext === "3mf") return parse3MF(buffer);
    throw new GeometryError(`Formato .${ext} não é lido pelo processador de geometria.`, "formato");
  },

  async prepareModel({ parsed, rotateYUp }) {
    const w = await getManifold();
    let mesh = weldSoup(parsed.soup);
    // Formatos Y-para-cima (OBJ, GLB) são girados para Z-para-cima, a convenção das impressoras.
    if (rotateYUp) mesh = transformMesh(mesh, rotationAxisAngle([1, 0, 0], 90));
    mesh = normalizePlacement(mesh);
    let report = analyzeMesh(mesh);
    const notes = [...parsed.notes];
    // Poucas faces invertidas (comum em GLB de IA) impedem o Manifold de cortar; corrigir não muda a forma.
    if (report.inconsistentEdges > 0) {
      const oriented = orientConsistently(mesh);
      if (oriented.flipped) {
        mesh = oriented.mesh;
        report = analyzeMesh(mesh);
        notes.push(`${oriented.flipped} face(s) com orientação invertida foram corrigidas automaticamente.`);
      }
    }
    return {
      mesh,
      report,
      manifoldOk: manifoldOk(w, mesh),
      attrs: {
        colors: parsed.faceColors,
        materials: parsed.faceMaterials,
        materialNames: parsed.materialNames,
        objects: parsed.faceObjects,
        objectNames: parsed.objectNames,
      },
      notes,
    };
  },

  async transformModel({ mesh, matrix }) {
    const w = await getManifold();
    const out = normalizePlacement(transformMesh(mesh, matrix));
    return { mesh: out, report: analyzeMesh(out), manifoldOk: manifoldOk(w, out) };
  },

  async repair({ mesh, options }) {
    const w = await getManifold();
    const r = repairMesh(mesh, options, wasmTriangulator(w));
    const report = analyzeMesh(r.mesh);
    return { mesh: r.mesh, faceMap: r.faceMap, log: r.log, report, manifoldOk: manifoldOk(w, r.mesh) };
  },

  async remesh({ mesh, resolution }, progress) {
    const w = await getManifold();
    const out = normalizePlacement(voxelRemesh(w, mesh, resolution, (f) => progress(f, "Reconstruindo por voxels")));
    if (!triCount(out))
      throw new GeometryError(
        "A reconstrução não encontrou um interior fechado. Feche os buracos maiores (reparo) e tente de novo.",
        "remesh-vazio",
      );
    return { mesh: out, report: analyzeMesh(out), manifoldOk: manifoldOk(w, out) };
  },

  async selfIntersections({ mesh, limit }) {
    return { count: countSelfIntersections(mesh, limit) };
  },

  async sample({ detail }) {
    const w = await getManifold();
    return normalizePlacement(buildSampleFigure(w, detail));
  },

  async partStats({ geometry }) {
    return statsOf(await getManifold(), geometry);
  },

  async segment({ mesh, attrs, providerId, options, remote }, progress) {
    const w = await getManifold();
    const providers = remote?.url ? [...localProviders, remoteProvider(remote.url, remote.token)] : localProviders;
    const provider = providers.find((p) => p.id === providerId);
    if (!provider) throw new GeometryError("Método de divisão automática desconhecido.", "provedor");
    const input = {
      mesh,
      faceColors: attrs.colors,
      faceMaterials: attrs.materials,
      materialNames: attrs.materialNames,
      faceObjects: attrs.objects,
      objectNames: attrs.objectNames,
    };
    if (!provider.available(input)) throw new GeometryError("Este método não se aplica a este modelo.", "indisponivel");
    return runSegmentation(provider, input, options, { decimate: (m, t) => decimateManifold(w, m, t) }, progress);
  },

  async splitRegions(args, progress) {
    const w = await getManifold();
    progress(0.05, "Preparando a divisão");
    const r = splitByRegions(w, args, wasmTriangulator(w), (f, label) => progress(0.05 + 0.85 * f, label));
    progress(0.9, "Conferindo as peças");
    return {
      parts: r.parts.map((p) => ({ label: p.label, geometry: p.geometry, stats: statsOf(w, p.geometry) })),
      cuts: r.cuts,
      islands: r.islands,
      nextCutId: r.nextCutId,
    };
  },

  async cutPlane({ geometry, frame, cutId, separateComponents }) {
    const w = await getManifold();
    const r = cutByPlane(w, geometry, frame, cutId, separateComponents);
    const wrap = (g: PartGeometry) => ({ geometry: g, stats: statsOf(w, g) });
    return { front: r.front.map(wrap), back: r.back.map(wrap) };
  },

  async autoFit({ geometry, bed, firstCutId, maxPieces }) {
    const w = await getManifold();
    const r = autoFitSplit(w, geometry, bed, firstCutId, maxPieces);
    return { ...r, pieces: r.pieces.map((g) => ({ geometry: g, stats: statsOf(w, g) })) };
  },

  async separateComponents({ geometry }) {
    const w = await getManifold();
    return splitComponents(w, geometry).map((g) => ({ geometry: g, stats: statsOf(w, g) }));
  },

  async mergeParts({ geometries }) {
    const w = await getManifold();
    const g = unionParts(w, geometries);
    return { geometry: g, stats: statsOf(w, g) };
  },

  async interfaces({ parts, cuts }) {
    return computeInterfaces(await getManifold(), parts, cuts);
  },

  async planConnectors({ items }) {
    const w = await getManifold();
    const hints = femaleHints(items);
    const withHints = items.map((it, i) => ({ ...it, femaleHint: hints[i] }));
    return resolveConnectorConflicts(w, withHints, withHints.map((it) => planConnectors(w, it)));
  },

  async applyConnectors({ parts, interfaces, plans }, progress) {
    const w = await getManifold();
    progress(0.2, "Aplicando pinos e furos");
    const r = applyConnectors(w, parts, interfaces, plans);
    return {
      checks: r.checks,
      extras: r.extras.map((e) => ({ ...e, stats: statsOf(w, e.geometry) })),
      parts: [...r.parts].map(([id, geometry]) => ({ id, geometry, stats: statsOf(w, geometry) })),
    };
  },

  async layout({ parts, bed }) {
    return layoutPlates(
      parts.map((p) => ({ id: p.id, geometry: p.geometry, maleTags: new Set(p.maleTags), rotation: p.rotation })),
      bed,
    );
  },

  async exportFiles({ groups, texts, zipName }, progress) {
    const files: { name: string; data: Uint8Array }[] = [];
    groups.forEach((group, gi) => {
      const names = uniqueSlugs(group.items.map((i) => i.name));
      const dir = group.folder ? `${group.folder}/` : "";
      const placed = (i: number): IndexedMesh => {
        const t = group.items[i].transform;
        return t ? transformMesh(group.items[i].mesh, t as Mat4) : group.items[i].mesh;
      };
      if (group.formats.includes("stl"))
        group.items.forEach((_, i) => files.push({ name: `${dir}${names[i]}.stl`, data: writeSTL(placed(i), names[i]) }));
      if (group.formats.includes("obj"))
        files.push({
          name: `${dir}${slugify(group.title)}.obj`,
          data: strToU8(writeOBJ(group.items.map((_, i) => ({ name: names[i], mesh: placed(i) })))),
        });
      if (group.formats.includes("3mf")) {
        const plates = group.plates ? [...new Set(group.plates)].sort((x, y) => x - y) : [0];
        for (const plate of plates) {
          const items = group.items.filter((_, i) => !group.plates || group.plates[i] === plate);
          const suffix = group.plates && plates.length > 1 ? `_mesa_${plate + 1}` : "";
          files.push({
            name: `${dir}${slugify(group.title)}${suffix}.3mf`,
            data: write3MF(items.map((it) => ({ name: it.name, mesh: it.mesh, color: it.color, transform: it.transform })), group.title),
          });
        }
      }
      progress((gi + 1) / groups.length, "Gerando arquivos");
    });
    for (const t of texts) files.push({ name: t.name, data: strToU8(t.text) });
    if (zipName) {
      const entries: Record<string, Uint8Array> = {};
      for (const f of files) entries[f.name] = f.data;
      return [{ name: zipName, data: zipSync(entries, { level: 6 }) }];
    }
    return files;
  },
};

ctx.onmessage = async (ev: MessageEvent<Request>) => {
  const { id, op, args } = ev.data;
  const progress = (fraction: number, label: string) => post({ id, type: "progress", fraction, label });
  try {
    const handler = handlers[op] as Handler<typeof op>;
    const result = await handler(args as never, progress);
    post({ id, type: "result", result });
  } catch (e) {
    const err = e as Error & { code?: string };
    post({ id, type: "error", message: err.message || String(e), code: err.code });
  }
};

