/** Cor por face ausente. */
export const NO_COLOR = 0xffffffff;

/** Resultado de uma importação: triângulos soltos (9 floats cada) e atributos por face. */
export interface ParsedModel {
  soup: Float32Array;
  /** Cor RGB (0xRRGGBB) por face, ou NO_COLOR. */
  faceColors?: Uint32Array;
  /** Grupo (material) por face e seus nomes. */
  faceMaterials?: Uint16Array;
  materialNames?: string[];
  /** Objeto de origem por face e seus nomes. */
  faceObjects?: Uint16Array;
  objectNames?: string[];
  /** Eixo vertical do formato de origem. */
  upAxis: "z" | "y";
  notes: string[];
}

export function rgbToHex(rgb: number): string {
  return `#${(rgb & 0xffffff).toString(16).padStart(6, "0")}`;
}

export function hexToRgb(hex: string): number {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.replace(/(.)/g, "$1$1") : h.slice(0, 6);
  const v = Number.parseInt(full, 16);
  return Number.isNaN(v) ? NO_COLOR : v;
}
