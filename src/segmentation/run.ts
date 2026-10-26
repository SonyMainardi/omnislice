import { cleanLabels } from "../core/labels";
import { type IndexedMesh, faceNeighbors, faceNormalsAndAreas, triCount } from "../core/mesh";
import { describeSegments } from "./naming";
import { transferLabels } from "./sdf";
import type { ProgressFn, SegmentationInput, SegmentationOptions, SegmentationProvider, SegmentationResult } from "./types";

export interface SegmentationTools {
  /** Simplifica a malha para `target` triângulos (ou devolve null). */
  decimate?: (mesh: IndexedMesh, target: number) => IndexedMesh | null;
}

/** Malhas acima disto são segmentadas em uma versão simplificada (resultado independe da densidade). */
export const SEGMENTATION_TARGET_TRIS = 30000;

/**
 * Executa um provedor. Para a segmentação geométrica de malhas densas, trabalha numa cópia
 * simplificada e transfere os rótulos de volta, o que mantém tempo e resultado estáveis.
 */
export async function runSegmentation(
  provider: SegmentationProvider,
  input: SegmentationInput,
  options: SegmentationOptions,
  tools: SegmentationTools = {},
  progress?: ProgressFn,
): Promise<SegmentationResult> {
  const n = triCount(input.mesh);
  if (provider.id !== "geometrica" || n <= SEGMENTATION_TARGET_TRIS * 1.3 || !tools.decimate)
    return provider.segment(input, options, progress);
  progress?.(0.01, "Simplificando para analisar");
  const simple = tools.decimate(input.mesh, SEGMENTATION_TARGET_TRIS);
  if (!simple || triCount(simple) >= n) return provider.segment(input, options, progress);
  const coarse = await provider.segment({ mesh: simple }, options, (f, label) => progress?.(0.05 + f * 0.85, label));
  progress?.(0.92, "Transferindo para a malha original");
  const neighbors = faceNeighbors(input.mesh);
  const { areas } = faceNormalsAndAreas(input.mesh);
  let total = 0;
  for (let f = 0; f < areas.length; f++) total += areas[f];
  // A transferência por proximidade deixa pontinhos e serrilhado nas fronteiras: limpa.
  const labels = cleanLabels(transferLabels(simple, coarse.labels, input.mesh), neighbors, areas, {
    minIslandArea: total * 0.002,
    minIslandFaces: 16,
    smoothIterations: 6,
  });
  const stats = describeSegments(input.mesh, neighbors, labels);
  const segments = coarse.segments.map((s) => ({
    ...s,
    area: stats[s.id]?.area ?? 0,
    centroid: stats[s.id]?.centroid ?? s.centroid,
    faceCount: stats[s.id]?.faces ?? 0,
  }));
  progress?.(1, "Pronto");
  return {
    ...coarse,
    labels,
    segments,
    notes: [...coarse.notes, `Análise feita numa cópia simplificada (${triCount(simple)} de ${n} triângulos).`],
  };
}
