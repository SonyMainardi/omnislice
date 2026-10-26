import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { PLYLoader } from "three/examples/jsm/loaders/PLYLoader.js";
import { NO_COLOR, type ParsedModel } from "../core/io/types";

export const ACCEPTED = [".stl", ".obj", ".3mf", ".glb", ".gltf", ".ply"];

/** Cor de uma textura no ponto UV (para modelos de IA texturizados, como GLB do Meshy/Tripo). */
function textureSampler(texture: THREE.Texture | null | undefined): ((u: number, v: number) => number) | null {
  const image = texture?.image as (CanvasImageSource & { width: number; height: number }) | undefined;
  if (!image || !image.width || !image.height) return null;
  const w = Math.min(image.width, 1024);
  const h = Math.min(image.height, 1024);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(image, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  const flipY = texture?.flipY ?? false;
  return (u, v) => {
    const x = Math.min(w - 1, Math.max(0, Math.floor((((u % 1) + 1) % 1) * w)));
    const yy = (((v % 1) + 1) % 1) * h;
    const y = Math.min(h - 1, Math.max(0, Math.floor(flipY ? h - 1 - yy : yy)));
    const i = (y * w + x) * 4;
    return (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
  };
}

/** GLB/GLTF: junta todas as malhas (com transformações), materiais e cor amostrada das texturas. */
export async function parseGLTF(buffer: ArrayBuffer): Promise<ParsedModel> {
  const loader = new GLTFLoader();
  const gltf = await new Promise<{ scene: THREE.Group }>((resolve, reject) =>
    loader.parse(buffer, "", resolve as (g: unknown) => void, (e) =>
      reject(
        new Error(
          /draco|meshopt|KHR_mesh_quantization/i.test(String(e?.message ?? e))
            ? "GLB comprimido (Draco/Meshopt) ainda não é suportado. Exporte sem compressão ou em STL/OBJ."
            : `Não foi possível ler o GLB: ${e?.message ?? e}`,
        ),
      ),
    ),
  );
  gltf.scene.updateMatrixWorld(true);
  const soup: number[] = [];
  const mats: number[] = [];
  const objs: number[] = [];
  const colors: number[] = [];
  const materialNames: string[] = [];
  const objectNames: string[] = [];
  const matIndex = new Map<THREE.Material, number>();
  let anyColor = false;
  const v = new THREE.Vector3();
  gltf.scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry?.attributes.position) return;
    const geom = mesh.geometry;
    const pos = geom.attributes.position;
    const uv = geom.attributes.uv;
    const vcol = geom.attributes.color;
    const index = geom.index;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const objId = objectNames.length;
    objectNames.push(mesh.name || `Malha ${objId + 1}`);
    const groups = geom.groups.length ? geom.groups : [{ start: 0, count: index ? index.count : pos.count, materialIndex: 0 }];
    for (const g of groups) {
      const material = materials[g.materialIndex ?? 0] as THREE.MeshStandardMaterial;
      if (!matIndex.has(material)) {
        matIndex.set(material, materialNames.length);
        materialNames.push(material?.name || `Material ${materialNames.length + 1}`);
      }
      const mi = matIndex.get(material)!;
      const sample = uv ? textureSampler(material?.map) : null;
      const base = material?.color ? material.color.getHex() : NO_COLOR;
      for (let i = g.start; i + 2 < g.start + g.count; i += 3) {
        const ids = [0, 1, 2].map((k) => (index ? index.getX(i + k) : i + k));
        for (const id of ids) {
          v.fromBufferAttribute(pos, id).applyMatrix4(mesh.matrixWorld);
          soup.push(v.x, v.y, v.z);
        }
        mats.push(mi);
        objs.push(objId);
        let c = NO_COLOR;
        if (sample && uv) {
          const u = (uv.getX(ids[0]) + uv.getX(ids[1]) + uv.getX(ids[2])) / 3;
          const vv = (uv.getY(ids[0]) + uv.getY(ids[1]) + uv.getY(ids[2])) / 3;
          c = sample(u, vv);
        } else if (vcol) {
          const r = (vcol.getX(ids[0]) + vcol.getX(ids[1]) + vcol.getX(ids[2])) / 3;
          const gg = (vcol.getY(ids[0]) + vcol.getY(ids[1]) + vcol.getY(ids[2])) / 3;
          const b = (vcol.getZ(ids[0]) + vcol.getZ(ids[1]) + vcol.getZ(ids[2])) / 3;
          c = (Math.round(r * 255) << 16) | (Math.round(gg * 255) << 8) | Math.round(b * 255);
        } else c = base;
        if (c !== NO_COLOR && c !== base) anyColor = true;
        colors.push(c);
      }
    }
  });
  if (!soup.length) throw new Error("O arquivo GLB não contém malhas.");
  const out: ParsedModel = { soup: new Float32Array(soup), upAxis: "y", notes: [] };
  if (materialNames.length > 1) {
    out.faceMaterials = Uint16Array.from(mats);
    out.materialNames = materialNames;
  }
  if (objectNames.length > 1) {
    out.faceObjects = Uint16Array.from(objs);
    out.objectNames = objectNames;
  }
  if (anyColor) {
    out.faceColors = Uint32Array.from(colors, (c) => (c === NO_COLOR ? 0xcccccc : c));
    out.notes.push("Cores da textura amostradas por face: use a seleção por cor para separar regiões.");
  }
  out.notes.push("GLB usa metros por convenção: confira a escala na etapa Modelo.");
  return out;
}

export function parsePLY(buffer: ArrayBuffer): ParsedModel {
  const geom = new PLYLoader().parse(buffer);
  // O PLYLoader só cria índice quando o arquivo tem faces; sem ele é uma nuvem de pontos.
  if (!geom.index) throw new Error("PLY sem faces (nuvem de pontos) não é suportado: converta para malha antes.");
  const g = geom.toNonIndexed();
  const pos = g.attributes.position.array as Float32Array;
  const out: ParsedModel = { soup: Float32Array.from(pos), upAxis: "z", notes: [] };
  const col = g.attributes.color;
  if (col) {
    const n = pos.length / 9;
    const colors = new Uint32Array(n);
    for (let f = 0; f < n; f++) {
      let r = 0;
      let gg = 0;
      let b = 0;
      for (let k = 0; k < 3; k++) {
        r += col.getX(f * 3 + k);
        gg += col.getY(f * 3 + k);
        b += col.getZ(f * 3 + k);
      }
      colors[f] = (Math.round((r / 3) * 255) << 16) | (Math.round((gg / 3) * 255) << 8) | Math.round((b / 3) * 255);
    }
    out.faceColors = colors;
    out.notes.push("Cores por vértice do PLY importadas.");
  }
  return out;
}
