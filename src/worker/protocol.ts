import type { MeshReport } from "../core/analysis";
import type { AppliedConnectors, ConnectorPlan, ConnectorSettings } from "../core/connectors";
import type { ParsedModel } from "../core/io/types";
import type { Placement } from "../core/layout";
import type { Mat4, PlaneFrame, Vec2, Vec3 } from "../core/math";
import type { Bounds, IndexedMesh } from "../core/mesh";
import type { PartGeometry } from "../core/part";
import type { RepairOptions } from "../core/repair";
import type { CutRecord, IslandReport, Interface, PartRef, SplitMode } from "../core/split";
import type { SegmentationOptions, SegmentationResult } from "../segmentation/types";

export interface PartStats {
  triangles: number;
  volume: number;
  area: number;
  bounds: Bounds;
  size: Vec3;
  components: number;
  genus: number;
  /** Sólido fechado válido para o Manifold. */
  solid: boolean;
  /** Espessura no 10º percentil (mm): só fica baixa quando boa parte da peça é fina/frágil. */
  thinWall: number;
}

export interface FaceAttributes {
  colors?: Uint32Array;
  materials?: Uint16Array;
  materialNames?: string[];
  objects?: Uint16Array;
  objectNames?: string[];
}

export interface PreparedModel {
  mesh: IndexedMesh;
  report: MeshReport;
  manifoldOk: boolean;
  attrs: FaceAttributes;
  notes: string[];
}

export interface SplitPartResult {
  label: number;
  geometry: PartGeometry;
  stats: PartStats;
}

export interface ExportItem {
  name: string;
  mesh: IndexedMesh;
  color?: string;
  transform?: Mat4;
}

export type ExportFile = { name: string; data: Uint8Array };

export type ExportFormat = "stl" | "3mf" | "obj";

/** Conjunto de peças exportado numa pasta (ex.: montada/ ou impressao/). */
export interface ExportGroup {
  folder: string;
  title: string;
  items: ExportItem[];
  formats: ExportFormat[];
  /** 3MF separado por mesa (índice da mesa de cada item). */
  plates?: number[];
}

/** Operações do worker: argumentos e resultados. */
export interface Ops {
  parseFile: { args: { name: string; buffer: ArrayBuffer }; result: ParsedModel };
  prepareModel: { args: { parsed: ParsedModel; rotateYUp: boolean }; result: PreparedModel };
  transformModel: { args: { mesh: IndexedMesh; matrix: Mat4 }; result: { mesh: IndexedMesh; report: MeshReport; manifoldOk: boolean } };
  repair: {
    args: { mesh: IndexedMesh; options: RepairOptions };
    result: { mesh: IndexedMesh; faceMap: Int32Array; log: string[]; report: MeshReport; manifoldOk: boolean };
  };
  remesh: { args: { mesh: IndexedMesh; resolution: number }; result: { mesh: IndexedMesh; report: MeshReport; manifoldOk: boolean } };
  selfIntersections: { args: { mesh: IndexedMesh; limit: number }; result: { count: number } };
  sample: { args: { detail: number }; result: IndexedMesh };
  partStats: { args: { geometry: PartGeometry }; result: PartStats };
  segment: {
    args: {
      mesh: IndexedMesh;
      attrs: FaceAttributes;
      providerId: string;
      options: SegmentationOptions;
      remote?: { url: string; token?: string };
    };
    result: SegmentationResult;
  };
  splitRegions: {
    args: { geometry: PartGeometry; labels: Uint16Array; separate: number[]; baseLabel: number; mode: SplitMode; firstCutId: number; precise: boolean };
    result: { parts: SplitPartResult[]; cuts: CutRecord[]; islands: IslandReport[]; nextCutId: number };
  };
  cutPlane: {
    args: { geometry: PartGeometry; frame: PlaneFrame; cutId: number; separateComponents: boolean };
    result: { front: { geometry: PartGeometry; stats: PartStats }[]; back: { geometry: PartGeometry; stats: PartStats }[] };
  };
  autoFit: {
    args: { geometry: PartGeometry; bed: Vec3; firstCutId: number; maxPieces: number };
    result: { pieces: { geometry: PartGeometry; stats: PartStats }[]; cuts: CutRecord[]; nextCutId: number; fits: boolean };
  };
  separateComponents: { args: { geometry: PartGeometry }; result: { geometry: PartGeometry; stats: PartStats }[] };
  mergeParts: { args: { geometries: PartGeometry[] }; result: { geometry: PartGeometry; stats: PartStats } };
  interfaces: { args: { parts: PartRef[]; cuts: CutRecord[] }; result: Interface[] };
  planConnectors: {
    args: {
      items: { iface: Interface; front: PartGeometry; back: PartGeometry; settings: ConnectorSettings; manualPoints?: Vec2[] }[];
    };
    result: ConnectorPlan[];
  };
  applyConnectors: {
    args: { parts: PartRef[]; interfaces: Interface[]; plans: ConnectorPlan[] };
    result: Pick<AppliedConnectors, "checks"> & {
      parts: { id: string; geometry: PartGeometry; stats: PartStats }[];
      extras: { name: string; geometry: PartGeometry; stats: PartStats; interfaceId: string }[];
    };
  };
  layout: {
    args: { parts: { id: string; geometry: PartGeometry; maleTags: number[]; rotation?: Mat4 }[]; bed: Vec3 };
    result: { placements: Placement[]; plates: number };
  };
  exportFiles: {
    args: { groups: ExportGroup[]; texts: { name: string; text: string }[]; zipName?: string };
    result: ExportFile[];
  };
}

export type OpName = keyof Ops;

export interface Request<K extends OpName = OpName> {
  id: number;
  op: K;
  args: Ops[K]["args"];
}

export type Response =
  | { id: number; type: "result"; result: unknown }
  | { id: number; type: "error"; message: string; code?: string }
  | { id: number; type: "progress"; fraction: number; label: string };
