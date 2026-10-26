import type { IndexedMesh } from "../mesh";
import { NO_COLOR, type ParsedModel } from "./types";

/** Leitor OBJ: vértices (com cor opcional), faces poligonais, materiais (usemtl) e objetos (o/g). */
export function parseOBJ(text: string): ParsedModel {
  const pos: number[] = [];
  const col: number[] = [];
  let hasVertexColors = false;
  const soup: number[] = [];
  const faceMat: number[] = [];
  const faceObj: number[] = [];
  const faceColor: number[] = [];
  const materials = new Map<string, number>();
  const objects = new Map<string, number>();
  let currentMat = 0;
  let currentObj = 0;
  materials.set("(sem material)", 0);
  objects.set("(objeto)", 0);
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line[0] === "#") continue;
    const parts = line.split(/\s+/);
    const tag = parts[0];
    if (tag === "v") {
      pos.push(+parts[1], +parts[2], +parts[3]);
      if (parts.length >= 7) {
        hasVertexColors = true;
        const s = Math.max(+parts[4], +parts[5], +parts[6]) > 1 ? 1 : 255;
        col.push(
          (Math.round(+parts[4] * s) << 16) | (Math.round(+parts[5] * s) << 8) | Math.round(+parts[6] * s),
        );
      } else col.push(NO_COLOR);
    } else if (tag === "f") {
      const nv = pos.length / 3;
      const idx = parts.slice(1).map((p) => {
        const i = Number.parseInt(p.split("/")[0], 10);
        return i < 0 ? nv + i : i - 1;
      });
      if (idx.some((i) => !(i >= 0 && i < nv))) continue;
      for (let k = 1; k + 1 < idx.length; k++) {
        for (const v of [idx[0], idx[k], idx[k + 1]]) soup.push(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
        faceMat.push(currentMat);
        faceObj.push(currentObj);
        if (hasVertexColors) {
          // Cor da face = média das cores dos 3 vértices.
          let r = 0;
          let g = 0;
          let b = 0;
          for (const v of [idx[0], idx[k], idx[k + 1]]) {
            const c = col[v] === NO_COLOR ? 0xcccccc : col[v];
            r += (c >> 16) & 255;
            g += (c >> 8) & 255;
            b += c & 255;
          }
          faceColor.push((Math.round(r / 3) << 16) | (Math.round(g / 3) << 8) | Math.round(b / 3));
        }
      }
    } else if (tag === "usemtl") {
      const name = parts.slice(1).join(" ") || "material";
      if (!materials.has(name)) materials.set(name, materials.size);
      currentMat = materials.get(name)!;
    } else if (tag === "o" || tag === "g") {
      const name = parts.slice(1).join(" ") || "objeto";
      if (!objects.has(name)) objects.set(name, objects.size);
      currentObj = objects.get(name)!;
    }
  }
  const out: ParsedModel = { soup: new Float32Array(soup), upAxis: "y", notes: [] };
  const usedMats = new Set(faceMat);
  if (usedMats.size > 1) {
    out.faceMaterials = Uint16Array.from(faceMat);
    out.materialNames = [...materials.keys()];
    out.notes.push(`${usedMats.size} materiais encontrados (seleção por material disponível).`);
  }
  const usedObjs = new Set(faceObj);
  if (usedObjs.size > 1) {
    out.faceObjects = Uint16Array.from(faceObj);
    out.objectNames = [...objects.keys()];
    out.notes.push(`${usedObjs.size} objetos/grupos encontrados.`);
  }
  if (hasVertexColors && faceColor.length) {
    out.faceColors = Uint32Array.from(faceColor);
    out.notes.push("Cores por vértice encontradas.");
  }
  return out;
}

export function writeOBJ(objects: { name: string; mesh: IndexedMesh }[]): string {
  const chunks: string[] = ["# Exportado pelo OmniSlice\n"];
  let base = 1;
  for (const o of objects) {
    chunks.push(`o ${o.name}\n`);
    const p = o.mesh.positions;
    const lines: string[] = [];
    for (let i = 0; i < p.length; i += 3) lines.push(`v ${fmt(p[i])} ${fmt(p[i + 1])} ${fmt(p[i + 2])}`);
    const idx = o.mesh.indices;
    for (let i = 0; i < idx.length; i += 3) lines.push(`f ${idx[i] + base} ${idx[i + 1] + base} ${idx[i + 2] + base}`);
    chunks.push(lines.join("\n"), "\n");
    base += p.length / 3;
  }
  return chunks.join("");
}

export function fmt(v: number): string {
  return String(Math.round(v * 1e5) / 1e5);
}
