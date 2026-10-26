import { type IndexedMesh, triCount } from "./mesh";

/** Triângulo que não nasceu de um corte. */
export const NO_CUT = -1;
/** Triângulo criado por um encaixe (pino ou furo). */
export const CONNECTOR_TAG = -2;

/**
 * Geometria de uma peça. Além da malha, cada triângulo guarda:
 * - `src`: índice da face do modelo importado de onde veio (para cor/material), ou -1;
 * - `cut`: marca do corte que criou a face (`cutId * 2 + lado`), NO_CUT ou CONNECTOR_TAG.
 * O lado 0 é a frente do corte (lado para onde a normal do plano aponta) e o lado 1 é o verso.
 */
export interface PartGeometry {
  mesh: IndexedMesh;
  src: Int32Array;
  cut: Int32Array;
}

export const cutTag = (cutId: number, side: 0 | 1): number => cutId * 2 + side;
export const tagCutId = (tag: number): number => tag >> 1;
export const tagSide = (tag: number): 0 | 1 => (tag & 1) as 0 | 1;

export function geometryFromMesh(mesh: IndexedMesh, src?: Int32Array): PartGeometry {
  const n = triCount(mesh);
  return {
    mesh,
    src: src ?? Int32Array.from({ length: n }, (_, i) => i),
    cut: new Int32Array(n).fill(NO_CUT),
  };
}

