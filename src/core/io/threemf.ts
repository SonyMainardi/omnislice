import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type { Mat4 } from "../math";
import type { IndexedMesh } from "../mesh";
import { fmt } from "./obj";
import { NO_COLOR, type ParsedModel, hexToRgb } from "./types";

type Attrs = Record<string, string>;

interface XmlTag {
  name: string;
  attrs: Attrs;
  closing: boolean;
  selfClosing: boolean;
}

const tagRe = /<(\/?)([A-Za-z_][\w:.-]*)([^>]*?)(\/?)>/g;
const attrRe = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function unescapeXml(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (m, e: string) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return entities[e] ?? m;
  });
}

/** Varredura mínima de XML (suficiente para arquivos 3MF gerados por software). */
function* scanXml(text: string): Generator<XmlTag> {
  tagRe.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(text))) {
    if (m[2].startsWith("?") || m[2].startsWith("!")) continue;
    const attrs: Attrs = {};
    const body = m[3];
    if (body) {
      attrRe.lastIndex = 0;
      let a: RegExpExecArray | null;
      while ((a = attrRe.exec(body))) attrs[a[1]] = unescapeXml(a[2] ?? a[3] ?? "");
    }
    yield { name: m[2], attrs, closing: m[1] === "/", selfClosing: m[4] === "/" || body.trimEnd().endsWith("/") };
  }
}

const local = (name: string) => name.slice(name.indexOf(":") + 1);

/** Matriz 3MF "m00 m01 m02 m10 … m32" (vetor-linha) para column-major. */
function parseTransform(s: string | undefined): Mat4 | null {
  if (!s) return null;
  const v = s.trim().split(/\s+/).map(Number);
  if (v.length !== 12 || v.some((x) => Number.isNaN(x))) return null;
  return [v[0], v[1], v[2], 0, v[3], v[4], v[5], 0, v[6], v[7], v[8], 0, v[9], v[10], v[11], 1];
}

function mul(a: Mat4, b: Mat4): Mat4 {
  const r = new Array(16).fill(0) as Mat4;
  for (let c = 0; c < 4; c++)
    for (let row = 0; row < 4; row++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + row] * b[c * 4 + k];
      r[c * 4 + row] = s;
    }
  return r;
}

const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

interface MeshObject {
  kind: "mesh";
  name: string;
  vertices: number[];
  triangles: number[];
  /** Estado de pintura multicolor (extrusor) por triângulo, 0 = não pintado. */
  paint: number[];
  /** Cor RGB explícita por triângulo (materiais 3MF). */
  colors: number[];
  defaultColor: number;
}

interface ComponentsObject {
  kind: "components";
  name: string;
  components: { path: string; objectid: string; transform: Mat4 }[];
}

type ObjectDef = MeshObject | ComponentsObject;

/**
 * Decodifica o estado dominante de uma string de pintura do Bambu Studio / PrusaSlicer
 * (`paint_color` / `slic3rpe:mmu_segmentation`). O formato é uma árvore de subdivisões do triângulo
 * serializada em nibbles hexadecimais lidos do fim para o começo.
 */
export function decodePaintState(code: string): number {
  if (!code) return 0;
  const nibbles: number[] = [];
  for (let i = code.length - 1; i >= 0; i--) {
    const v = Number.parseInt(code[i], 16);
    if (!Number.isNaN(v)) nibbles.push(v);
  }
  let pos = 0;
  const weight = new Map<number, number>();
  const visit = (area: number, depth: number) => {
    if (pos >= nibbles.length || depth > 16) return;
    const n = nibbles[pos++];
    const split = n & 0b11;
    if (split === 0) {
      let state = n >> 2;
      if (state === 3 && pos < nibbles.length) state = nibbles[pos++] + 3;
      weight.set(state, (weight.get(state) ?? 0) + area);
      return;
    }
    const children = split + 1;
    for (let c = 0; c < children; c++) visit(area / children, depth + 1);
  };
  visit(1, 0);
  let best = 0;
  let bestW = -1;
  for (const [s, w] of weight)
    if (w > bestW) {
      best = s;
      bestW = w;
    }
  return best;
}

function readFilamentColors(files: Record<string, Uint8Array>): number[] {
  const cfg = files["Metadata/project_settings.config"];
  if (cfg) {
    try {
      const json = JSON.parse(strFromU8(cfg)) as { filament_colour?: string[] };
      if (Array.isArray(json.filament_colour)) return json.filament_colour.map(hexToRgb);
    } catch {
      // Arquivo de configuração em outro formato.
    }
  }
  const prusa = files["Metadata/Slic3r_PE.config"];
  if (prusa) {
    const m = /;\s*extruder_colour\s*=\s*(.+)/.exec(strFromU8(prusa));
    if (m) return m[1].split(";").map((s) => hexToRgb(s.trim().replace(/"/g, "")));
  }
  return [];
}

const PAINT_FALLBACK = [0xe4572e, 0x29335c, 0xf3a712, 0x669bbc, 0xa8c686, 0x8e5572, 0x2a9d8f, 0xf4a261];

/**
 * Nome e filamento de cada objeto do projeto, que o Bambu Studio / OrcaSlicer e o PrusaSlicer
 * guardam fora do modelo (`model_settings.config`, `Slic3r_PE_model.config`), pelo id do objeto
 * do arquivo principal.
 */
function readObjectSettings(files: Record<string, Uint8Array>): Map<string, { name?: string; extruder?: number }> {
  const out = new Map<string, { name?: string; extruder?: number }>();
  const data = files["Metadata/model_settings.config"] ?? files["Metadata/Slic3r_PE_model.config"];
  if (!data) return out;
  let current: { name?: string; extruder?: number } | null = null;
  let depth = 0;
  for (const tag of scanXml(strFromU8(data))) {
    const name = local(tag.name);
    if (name === "object") {
      if (tag.closing) current = null;
      else {
        current = {};
        out.set(tag.attrs.id, current);
        depth = 0;
      }
      continue;
    }
    // Metadados de partes (volumes) ficam um nível abaixo: só os do objeto contam aqui.
    if (name === "part" || name === "volume") {
      if (!tag.selfClosing) depth += tag.closing ? -1 : 1;
      continue;
    }
    if (!current || depth > 0 || name !== "metadata" || tag.closing) continue;
    const key = tag.attrs.key ?? tag.attrs.type;
    if (key === "name" && tag.attrs.value) current.name = tag.attrs.value;
    if (key === "extruder") {
      const e = Number(tag.attrs.value);
      if (Number.isInteger(e) && e > 0) current.extruder = e;
    }
  }
  return out;
}

export function parse3MF(buf: ArrayBuffer): ParsedModel {
  const files = unzipSync(new Uint8Array(buf));
  const notes: string[] = [];
  let rootPath = "3D/3dmodel.model";
  const rels = files["_rels/.rels"];
  if (rels) {
    for (const tag of scanXml(strFromU8(rels)))
      if (local(tag.name) === "Relationship" && /3dmodel$/.test(tag.attrs.Type ?? ""))
        rootPath = (tag.attrs.Target ?? rootPath).replace(/^\//, "");
  }
  const docs = new Map<string, { objects: Map<string, ObjectDef>; build: { objectid: string; transform: Mat4; path: string }[] }>();
  const loadDoc = (path: string) => {
    const key = path.replace(/^\//, "");
    if (docs.has(key)) return docs.get(key)!;
    const data = files[key] ?? files[Object.keys(files).find((k) => k.toLowerCase() === key.toLowerCase()) ?? ""];
    if (!data) throw new Error(`Arquivo interno ausente no 3MF: ${key}`);
    const doc = parseModelXml(strFromU8(data), key);
    docs.set(key, doc);
    return doc;
  };
  const root = loadDoc(rootPath);
  const filament = readFilamentColors(files);
  const settings = readObjectSettings(files);

  const soup: number[] = [];
  const faceColors: number[] = [];
  const faceObjects: number[] = [];
  const objectNames: string[] = [];
  let painted = false;
  let colored = false;

  const emit = (docPath: string, objectid: string, transform: Mat4, depth: number, nameHint: string, colorHint: number) => {
    if (depth > 16) return;
    const doc = loadDoc(docPath);
    const obj = doc.objects.get(objectid);
    if (!obj) return;
    if (obj.kind === "components") {
      for (const c of obj.components)
        emit(c.path || docPath, c.objectid, mul(transform, c.transform), depth + 1, nameHint || obj.name, colorHint);
      return;
    }
    const objIndex = objectNames.length;
    objectNames.push(nameHint || obj.name || `Objeto ${objIndex + 1}`);
    const v = obj.vertices;
    const t = transform;
    for (let i = 0; i < obj.triangles.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const vi = obj.triangles[i + k] * 3;
        const x = v[vi];
        const y = v[vi + 1];
        const z = v[vi + 2];
        soup.push(
          t[0] * x + t[4] * y + t[8] * z + t[12],
          t[1] * x + t[5] * y + t[9] * z + t[13],
          t[2] * x + t[6] * y + t[10] * z + t[14],
        );
      }
      const tri = i / 3;
      let color = obj.colors[tri] ?? NO_COLOR;
      const state = obj.paint[tri] ?? 0;
      if (state > 0) {
        painted = true;
        color = filament[state - 1] ?? PAINT_FALLBACK[(state - 1) % PAINT_FALLBACK.length];
      } else if (color === NO_COLOR) color = obj.defaultColor !== NO_COLOR ? obj.defaultColor : colorHint;
      if (color !== NO_COLOR) colored = true;
      faceColors.push(color);
      faceObjects.push(objIndex);
    }
  };
  for (const item of root.build) {
    // Nome e filamento do projeto valem para o objeto da cena (o item do build).
    const cfg = item.path === rootPath || !item.path ? settings.get(item.objectid) : undefined;
    const color = cfg?.extruder ? (filament[cfg.extruder - 1] ?? NO_COLOR) : NO_COLOR;
    emit(item.path || rootPath, item.objectid, item.transform, 0, cfg?.name ?? "", color);
  }

  const out: ParsedModel = { soup: new Float32Array(soup), upAxis: "z", notes };
  if (objectNames.length > 1) {
    out.faceObjects = Uint16Array.from(faceObjects);
    out.objectNames = objectNames;
    notes.push(`${objectNames.length} objetos no projeto 3MF.`);
  }
  if (painted || colored) {
    // Faces sem cor recebem a do primeiro filamento para a seleção por cor funcionar.
    const fallback = filament[0] ?? 0xdddddd;
    out.faceColors = Uint32Array.from(faceColors, (c) => (c === NO_COLOR ? fallback : c));
    notes.push(painted ? "Pintura multicolor (Bambu/Prusa) importada: selecione regiões por cor." : "Cores do 3MF importadas.");
  }
  return out;
}

function parseModelXml(text: string, path: string) {
  const objects = new Map<string, ObjectDef>();
  const build: { objectid: string; transform: Mat4; path: string }[] = [];
  const baseMaterials = new Map<string, number[]>();
  const colorGroups = new Map<string, number[]>();
  let current: ObjectDef | null = null;
  let currentGroup: { id: string; list: number[] } | null = null;
  let unit = 1;
  const resolveColor = (pid: string | undefined, index: string | undefined): number => {
    if (!pid) return NO_COLOR;
    const list = baseMaterials.get(pid) ?? colorGroups.get(pid);
    if (!list) return NO_COLOR;
    return list[Number(index ?? 0)] ?? NO_COLOR;
  };
  for (const tag of scanXml(text)) {
    const name = local(tag.name);
    const a = tag.attrs;
    if (tag.closing) {
      if (name === "object") current = null;
      if (name === "basematerials" || name === "colorgroup") currentGroup = null;
      continue;
    }
    switch (name) {
      case "model": {
        const u = a.unit ?? "millimeter";
        unit = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 }[u] ?? 1;
        break;
      }
      case "basematerials":
        currentGroup = { id: a.id, list: [] };
        baseMaterials.set(a.id, currentGroup.list);
        break;
      case "colorgroup":
        currentGroup = { id: a.id, list: [] };
        colorGroups.set(a.id, currentGroup.list);
        break;
      case "base":
        currentGroup?.list.push(hexToRgb(a.displaycolor ?? "#cccccc"));
        break;
      case "color":
        currentGroup?.list.push(hexToRgb(a.color ?? "#cccccc"));
        break;
      case "object": {
        const id = a.id;
        const def: MeshObject = {
          kind: "mesh",
          name: a.name ?? "",
          vertices: [],
          triangles: [],
          paint: [],
          colors: [],
          defaultColor: resolveColor(a.pid, a.pindex),
        };
        current = def;
        objects.set(id, def);
        if (tag.selfClosing) current = null;
        break;
      }
      case "components":
        if (current) {
          const comp: ComponentsObject = { kind: "components", name: current.name, components: [] };
          for (const [k, v] of objects) if (v === current) objects.set(k, comp);
          current = comp;
        }
        break;
      case "component":
        if (current?.kind === "components")
          current.components.push({
            objectid: a.objectid,
            path: (a["p:path"] ?? a.path ?? "").replace(/^\//, ""),
            transform: parseTransform(a.transform) ?? IDENTITY,
          });
        break;
      case "vertex":
        if (current?.kind === "mesh") current.vertices.push(+a.x * unit, +a.y * unit, +a.z * unit);
        break;
      case "triangle":
        if (current?.kind === "mesh") {
          current.triangles.push(+a.v1, +a.v2, +a.v3);
          const paintCode = a.paint_color ?? a["slic3rpe:mmu_segmentation"] ?? a.mmu_segmentation;
          current.paint.push(paintCode ? decodePaintState(paintCode) : 0);
          current.colors.push(resolveColor(a.pid, a.p1));
        }
        break;
      case "item":
        build.push({
          objectid: a.objectid,
          transform: parseTransform(a.transform) ?? IDENTITY,
          path: (a["p:path"] ?? "").replace(/^\//, "") || path,
        });
        break;
    }
  }
  return { objects, build };
}

export interface ThreeMFObject {
  name: string;
  mesh: IndexedMesh;
  color?: string;
  transform?: Mat4;
}

/** Projeto 3MF com cada peça como objeto independente (com nome e cor). */
export function write3MF(objects: ThreeMFObject[], title = "OmniSlice"): Uint8Array {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  const parts: string[] = [];
  parts.push(
    '<?xml version="1.0" encoding="UTF-8"?>\n',
    '<model unit="millimeter" xml:lang="pt-BR" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n',
    `<metadata name="Title">${esc(title)}</metadata>\n`,
    '<metadata name="Application">OmniSlice</metadata>\n',
    "<resources>\n",
    '<basematerials id="1">\n',
  );
  for (const o of objects) parts.push(`<base name="${esc(o.name)}" displaycolor="${(o.color ?? "#CCCCCC").toUpperCase()}FF"/>\n`);
  parts.push("</basematerials>\n");
  objects.forEach((o, i) => {
    parts.push(`<object id="${i + 2}" type="model" name="${esc(o.name)}" pid="1" pindex="${i}">\n<mesh>\n<vertices>\n`);
    const p = o.mesh.positions;
    const verts: string[] = [];
    for (let k = 0; k < p.length; k += 3) verts.push(`<vertex x="${fmt(p[k])}" y="${fmt(p[k + 1])}" z="${fmt(p[k + 2])}"/>`);
    parts.push(verts.join("\n"), "\n</vertices>\n<triangles>\n");
    const idx = o.mesh.indices;
    const tris: string[] = [];
    for (let k = 0; k < idx.length; k += 3) tris.push(`<triangle v1="${idx[k]}" v2="${idx[k + 1]}" v3="${idx[k + 2]}"/>`);
    parts.push(tris.join("\n"), "\n</triangles>\n</mesh>\n</object>\n");
  });
  parts.push("</resources>\n<build>\n");
  objects.forEach((o, i) => {
    const t = o.transform;
    const tr = t
      ? ` transform="${[t[0], t[1], t[2], t[4], t[5], t[6], t[8], t[9], t[10], t[12], t[13], t[14]].map(fmt).join(" ")}"`
      : "";
    parts.push(`<item objectid="${i + 2}"${tr}/>\n`);
  });
  parts.push("</build>\n</model>\n");
  return zipSync(
    {
      "[Content_Types].xml": strToU8(
        '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>',
      ),
      "_rels/.rels": strToU8(
        '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>',
      ),
      "3D/3dmodel.model": strToU8(parts.join("")),
    },
    { level: 6 },
  );
}
