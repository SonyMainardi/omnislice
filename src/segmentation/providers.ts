import { faceComponents, faceNeighbors, faceNormalsAndAreas, triCount } from "../core/mesh";
import { writeSTL } from "../core/io/stl";
import { rgbToHex } from "../core/io/types";
import { dualEdges, hierarchicalMerge, kmeans1D, modelDiagonal, segmentsFromLabels, smoothAssign } from "./cluster";
import { describeSegments, nameSegments } from "./naming";
import { computeSDF } from "./sdf";
import type { ProgressFn, SegmentInfo, SegmentationInput, SegmentationProvider, SegmentationResult } from "./types";

/** Segmentação geométrica local: diâmetro de forma (SDF) + agrupamento + suavização por juntas. */
export const geometricProvider: SegmentationProvider = {
  id: "geometrica",
  name: "Geométrica (espessura e juntas)",
  description:
    "Mede a espessura local do modelo (Shape Diameter Function), agrupa regiões de espessura parecida e " +
    "posiciona as fronteiras nos vincos côncavos (juntas). Roda no navegador, sem IA e sem internet.",
  local: true,
  available: (input) => triCount(input.mesh) > 0,
  async segment(input, options, progress) {
    const { mesh } = input;
    const neighbors = faceNeighbors(mesh);
    const { areas } = faceNormalsAndAreas(mesh);
    progress?.(0.02, "Medindo a espessura local");
    const sdf = computeSDF(mesh, neighbors, { samples: 7000, rays: 24, coneAngle: 120 }, (f) =>
      progress?.(0.05 + f * 0.6, "Medindo a espessura local"),
    );
    let lo = Infinity;
    let hi = -Infinity;
    for (let f = 0; f < sdf.length; f++) {
      lo = Math.min(lo, sdf[f]);
      hi = Math.max(hi, sdf[f]);
    }
    const alpha = 4;
    const norm = new Float32Array(sdf.length);
    for (let f = 0; f < sdf.length; f++)
      norm[f] = Math.log(((sdf[f] - lo) / Math.max(hi - lo, 1e-9)) * alpha + 1) / Math.log(alpha + 1);
    progress?.(0.7, "Agrupando regiões");
    const s = options.sensitivity;
    const edges = dualEdges(mesh, neighbors);
    const { means, sigmas } = kmeans1D(norm, areas, Math.round(3 + s * 4));
    const clusters = smoothAssign(mesh, neighbors, edges, norm, means, sigmas, modelDiagonal(mesh) * 0.012 * (1.5 - s));
    progress?.(0.85, "Separando partes");
    let total = 0;
    for (let f = 0; f < areas.length; f++) total += areas[f];
    const minArea = total * options.minAreaFraction;
    // 1) absorve só o ruído; 2) funde regiões parecidas (espessura e fronteira sem junta);
    // 3) partes pequenas vão para o vizinho mais parecido.
    const base = { maxRegions: options.maxSegments, threshold: 14 + (0.5 - s) * 10, contrastWeight: 60 };
    const cleaned = hierarchicalMerge(mesh, neighbors, edges, clusters, sdf, {
      ...base,
      minArea: minArea * 0.3,
      onlySmall: true,
      smallRule: "longest",
    });
    const merged = hierarchicalMerge(mesh, neighbors, edges, cleaned, sdf, { ...base, minArea: 0 });
    const tidy = hierarchicalMerge(mesh, neighbors, edges, merged, sdf, {
      ...base,
      minArea,
      onlySmall: true,
      smallRule: "similar",
    });
    const labels = segmentsFromLabels(tidy, neighbors, areas, minArea * 0.3, options.maxSegments);
    const segments = nameSegments(mesh, neighbors, labels);
    progress?.(1, "Pronto");
    return {
      labels,
      segments,
      providerId: this.id,
      notes: [
        `${segments.length} parte(s) encontradas pela geometria. Os nomes são sugestões por posição (Z para cima, frente em −Y).`,
      ],
    };
  },
};

/** Cada casca solta do arquivo vira uma parte (exato quando o modelo já vem em pedaços). */
export const componentsProvider: SegmentationProvider = {
  id: "cascas",
  name: "Cascas separadas",
  description: "Usa as cascas soltas que já existem no arquivo (acessórios modelados à parte, por exemplo).",
  local: true,
  available: (input) => faceComponents(input.mesh).count > 1,
  async segment(input, options) {
    const neighbors = faceNeighbors(input.mesh);
    const { comp } = faceComponents(input.mesh, neighbors);
    const { areas } = faceNormalsAndAreas(input.mesh);
    let total = 0;
    for (let f = 0; f < areas.length; f++) total += areas[f];
    const labels = segmentsFromLabels(comp, neighbors, areas, total * options.minAreaFraction * 0.2, options.maxSegments);
    return { labels, segments: nameSegments(input.mesh, neighbors, labels), providerId: this.id, notes: [] };
  },
};

function attributeProvider(
  id: string,
  name: string,
  description: string,
  pick: (input: SegmentationInput) => { values: ArrayLike<number>; label: (v: number) => string } | null,
): SegmentationProvider {
  return {
    id,
    name,
    description,
    local: true,
    available: (input) => {
      const p = pick(input);
      if (!p) return false;
      const set = new Set<number>();
      for (let i = 0; i < p.values.length && set.size < 2; i++) set.add(p.values[i]);
      return set.size > 1;
    },
    async segment(input, options) {
      const p = pick(input);
      if (!p) throw new Error("Este arquivo não tem esse tipo de informação.");
      const neighbors = faceNeighbors(input.mesh);
      const { areas } = faceNormalsAndAreas(input.mesh);
      // Agrupa por valor (não por conectividade): mesma cor = mesma parte.
      const ids = new Map<number, number>();
      const raw = new Uint16Array(p.values.length);
      for (let f = 0; f < raw.length; f++) {
        const v = p.values[f];
        if (!ids.has(v)) ids.set(v, ids.size);
        raw[f] = ids.get(v)!;
      }
      const areaById = new Float64Array(ids.size);
      for (let f = 0; f < raw.length; f++) areaById[raw[f]] += areas[f];
      const order = [...ids.entries()].sort((a, b) => areaById[b[1]] - areaById[a[1]]).slice(0, options.maxSegments);
      const remap = new Map(order.map(([, idx], i) => [idx, i]));
      const labels = new Uint16Array(raw.length);
      for (let f = 0; f < raw.length; f++) labels[f] = remap.get(raw[f]) ?? 0;
      const stats = describeSegments(input.mesh, neighbors, labels);
      const segments: SegmentInfo[] = order.map(([value], i) => ({
        id: i,
        name: p.label(value),
        area: stats[i]?.area ?? 0,
        centroid: stats[i]?.centroid ?? [0, 0, 0],
        faceCount: stats[i]?.faces ?? 0,
        suggestedSeparate: i > 0,
      }));
      return { labels, segments, providerId: id, notes: [] };
    },
  };
}

export const colorProvider = attributeProvider(
  "cores",
  "Por cor",
  "Uma parte por cor do arquivo (3MF pintado no Bambu Studio/PrusaSlicer, OBJ/PLY/STL coloridos).",
  (input) => (input.faceColors ? { values: input.faceColors, label: (v) => `Cor ${rgbToHex(v)}` } : null),
);

export const materialProvider = attributeProvider(
  "materiais",
  "Por material",
  "Uma parte por material (usemtl do OBJ, materiais do GLB).",
  (input) =>
    input.faceMaterials
      ? { values: input.faceMaterials, label: (v) => input.materialNames?.[v] ?? `Material ${v + 1}` }
      : null,
);

export const objectProvider = attributeProvider(
  "objetos",
  "Por objeto",
  "Uma parte por objeto/grupo do arquivo de origem.",
  (input) =>
    input.faceObjects ? { values: input.faceObjects, label: (v) => input.objectNames?.[v] ?? `Objeto ${v + 1}` } : null,
);

/**
 * Provedor remoto (opcional): envia a peça como STL binário para um serviço de segmentação por IA e
 * espera `{ "labels": number[] (um por triângulo, na ordem do STL), "names"?: string[] }`.
 * Fica desativado até que uma URL seja configurada; os dados só saem do computador nesse caso.
 */
export function remoteProvider(url: string, token?: string): SegmentationProvider {
  return {
    id: "remoto",
    name: "Serviço de IA (remoto)",
    description: `Envia a peça para ${url} e recebe a segmentação pronta.`,
    local: false,
    available: () => url.length > 0,
    async segment(input, options, progress?: ProgressFn): Promise<SegmentationResult> {
      progress?.(0.1, "Enviando modelo");
      const body = writeSTL(input.mesh, "segmentar");
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "model/stl", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: new Blob([body.slice().buffer]),
      });
      if (!res.ok) throw new Error(`O serviço respondeu ${res.status}.`);
      const json = (await res.json()) as { labels?: number[]; names?: string[] };
      const n = triCount(input.mesh);
      if (!Array.isArray(json.labels) || json.labels.length !== n)
        throw new Error("Resposta inválida: esperado um rótulo por triângulo.");
      const labels = Uint16Array.from(json.labels, (v) => Math.max(0, Math.min(options.maxSegments - 1, v | 0)));
      const neighbors = faceNeighbors(input.mesh);
      const stats = describeSegments(input.mesh, neighbors, labels);
      const named = nameSegments(input.mesh, neighbors, labels);
      const segments = stats
        .filter((s) => s.faces > 0)
        .map((s) => ({
          id: s.id,
          name: json.names?.[s.id] ?? named.find((x) => x.id === s.id)?.name ?? `Parte ${s.id + 1}`,
          area: s.area,
          centroid: s.centroid,
          faceCount: s.faces,
          suggestedSeparate: s.id !== 0,
        }));
      progress?.(1, "Pronto");
      return { labels, segments, providerId: "remoto", notes: [`Segmentação recebida de ${url}.`] };
    },
  };
}

export const localProviders: SegmentationProvider[] = [
  geometricProvider,
  componentsProvider,
  colorProvider,
  materialProvider,
  objectProvider,
];
