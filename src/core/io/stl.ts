import type { IndexedMesh } from "../mesh";
import { NO_COLOR, type ParsedModel } from "./types";

function isBinarySTL(buf: ArrayBuffer): boolean {
  if (buf.byteLength < 84) return false;
  const n = new DataView(buf).getUint32(80, true);
  if (84 + n * 50 === buf.byteLength) return true;
  const head = new TextDecoder().decode(new Uint8Array(buf, 0, Math.min(buf.byteLength, 512))).trimStart();
  return !(head.startsWith("solid") && head.includes("facet"));
}

export function parseSTL(buf: ArrayBuffer): ParsedModel {
  return isBinarySTL(buf) ? parseBinarySTL(buf) : parseAsciiSTL(new TextDecoder().decode(buf));
}

function parseBinarySTL(buf: ArrayBuffer): ParsedModel {
  const dv = new DataView(buf);
  const n = Math.min(dv.getUint32(80, true), Math.floor((buf.byteLength - 84) / 50));
  const soup = new Float32Array(n * 9);
  // Convenção VisCAM/SolidView: cabeçalho com "COLOR=" e cor 5-5-5 por face (bit 15 = 0).
  const header = new Uint8Array(buf, 0, 80);
  let colorIdx = -1;
  for (let i = 0; i < 74; i++)
    if (
      header[i] === 0x43 &&
      header[i + 1] === 0x4f &&
      header[i + 2] === 0x4c &&
      header[i + 3] === 0x4f &&
      header[i + 4] === 0x52 &&
      header[i + 5] === 0x3d
    )
      colorIdx = i;
  const colors = colorIdx >= 0 ? new Uint32Array(n) : undefined;
  const defaultColor =
    colorIdx >= 0 ? (header[colorIdx + 6] << 16) | (header[colorIdx + 7] << 8) | header[colorIdx + 8] : NO_COLOR;
  let anyColor = false;
  for (let f = 0; f < n; f++) {
    const o = 84 + f * 50 + 12;
    for (let k = 0; k < 9; k++) soup[f * 9 + k] = dv.getFloat32(o + k * 4, true);
    if (colors) {
      const attr = dv.getUint16(84 + f * 50 + 48, true);
      if ((attr & 0x8000) === 0) {
        const r = Math.round(((attr & 31) / 31) * 255);
        const g = Math.round((((attr >> 5) & 31) / 31) * 255);
        const b = Math.round((((attr >> 10) & 31) / 31) * 255);
        colors[f] = (r << 16) | (g << 8) | b;
        anyColor = true;
      } else colors[f] = defaultColor;
    }
  }
  return {
    soup,
    faceColors: anyColor ? colors : undefined,
    upAxis: "z",
    notes: anyColor ? ["Cores por face (STL colorido) detectadas."] : [],
  };
}

function parseAsciiSTL(text: string): ParsedModel {
  const values: number[] = [];
  const re = /vertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) values.push(+m[1], +m[2], +m[3]);
  const usable = values.length - (values.length % 9);
  return { soup: new Float32Array(values.slice(0, usable)), upAxis: "z", notes: [] };
}

/** STL binário. */
export function writeSTL(mesh: IndexedMesh, name = "omnislice"): Uint8Array {
  const n = mesh.indices.length / 3;
  const buf = new ArrayBuffer(84 + n * 50);
  const dv = new DataView(buf);
  const header = new TextEncoder().encode(`OmniSlice ${name}`.slice(0, 79));
  new Uint8Array(buf, 0, 80).set(header);
  dv.setUint32(80, n, true);
  const p = mesh.positions;
  for (let f = 0; f < n; f++) {
    const o = 84 + f * 50;
    const a = mesh.indices[f * 3] * 3;
    const b = mesh.indices[f * 3 + 1] * 3;
    const c = mesh.indices[f * 3 + 2] * 3;
    const ux = p[b] - p[a];
    const uy = p[b + 1] - p[a + 1];
    const uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a];
    const vy = p[c + 1] - p[a + 1];
    const vz = p[c + 2] - p[a + 2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    dv.setFloat32(o, nx, true);
    dv.setFloat32(o + 4, ny, true);
    dv.setFloat32(o + 8, nz, true);
    let k = o + 12;
    for (const v of [a, b, c]) {
      dv.setFloat32(k, p[v], true);
      dv.setFloat32(k + 4, p[v + 1], true);
      dv.setFloat32(k + 8, p[v + 2], true);
      k += 12;
    }
    dv.setUint16(o + 48, 0, true);
  }
  return new Uint8Array(buf);
}
