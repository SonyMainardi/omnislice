import type { Vec3 } from "../core/math";
import type { IndexedMesh } from "../core/mesh";

/**
 * Contrato do módulo de divisão automática. Ele é independente das ferramentas manuais: qualquer
 * provedor (geométrico local, modelo de IA local ou serviço remoto) recebe a malha e devolve um
 * rótulo por triângulo. As ferramentas de pintura e de corte consomem apenas esse resultado.
 */
export interface SegmentationInput {
  mesh: IndexedMesh;
  /** Atributos por face, quando o arquivo de origem os tinha. */
  faceColors?: Uint32Array;
  faceMaterials?: Uint16Array;
  materialNames?: string[];
  faceObjects?: Uint16Array;
  objectNames?: string[];
}

export interface SegmentationOptions {
  /** Número máximo de partes no resultado. */
  maxSegments: number;
  /** 0 = poucas partes grandes, 1 = muitas partes pequenas. */
  sensitivity: number;
  /** Área mínima de uma parte, como fração da área total. */
  minAreaFraction: number;
}

export const defaultSegmentationOptions: SegmentationOptions = {
  maxSegments: 12,
  sensitivity: 0.5,
  minAreaFraction: 0.01,
};

export interface SegmentInfo {
  id: number;
  name: string;
  area: number;
  centroid: Vec3;
  faceCount: number;
  /** Sugestão de separar esta parte (falso para o corpo principal). */
  suggestedSeparate: boolean;
}

export interface SegmentationResult {
  /** Rótulo por triângulo (índices de `segments`). */
  labels: Uint16Array;
  segments: SegmentInfo[];
  providerId: string;
  notes: string[];
}

export type ProgressFn = (fraction: number, label: string) => void;

export interface SegmentationProvider {
  id: string;
  name: string;
  description: string;
  /** Roda inteiramente no navegador (nenhum dado sai do computador). */
  local: boolean;
  /** Diz se o provedor se aplica à entrada (ex.: precisa de cores). */
  available(input: SegmentationInput): boolean;
  segment(input: SegmentationInput, options: SegmentationOptions, progress?: ProgressFn): Promise<SegmentationResult>;
}
