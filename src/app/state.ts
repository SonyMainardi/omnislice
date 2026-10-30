import { useSyncExternalStore } from "react";
import type { MeshReport } from "../core/analysis";
import { type ConnectorPlan, type ConnectorSettings, type MaterialKind, defaultConnectorSettings } from "../core/connectors";
import { bedPresets } from "../core/layout";
import type { Mat4, PlaneFrame, Vec2, Vec3 } from "../core/math";
import type { IndexedMesh } from "../core/mesh";
import type { PartGeometry } from "../core/part";
import type { CutRecord, IslandReport, Interface, SplitMode } from "../core/split";
import type { AppliedConnectorsResult } from "./types";
import type { FaceAttributes, PartStats } from "../worker/protocol";

export type Stage = "modelo" | "dividir" | "encaixes" | "impressao" | "exportar";

export type Tool = "orbitar" | "pincel" | "borracha" | "inteligente" | "balde" | "casca" | "atributo" | "plano";

export interface Part {
  id: string;
  name: string;
  color: string;
  visible: boolean;
  geometry: PartGeometry;
  stats: PartStats;
}

export interface Region {
  id: number;
  name: string;
  color: string;
  separate: boolean;
}

/** Pintura de regiões sobre uma peça (rótulo por triângulo). */
export interface RegionSession {
  partId: string;
  labels: Uint16Array;
  regions: Region[];
  /** Região que recebe o restante (corpo principal). */
  baseId: number;
  source: string;
  notes: string[];
}

export interface ModelState {
  fileName: string;
  format: string;
  mesh: IndexedMesh;
  report: MeshReport;
  manifoldOk: boolean;
  attrs: FaceAttributes;
  notes: string[];
  repairLog: string[];
}

export interface ConnectorOverride {
  settings?: Partial<ConnectorSettings>;
  points?: Vec2[];
}

export interface PrintSettings {
  bedId: string;
  bed: Vec3;
  material: MaterialKind;
  /** Peças muito pequenas (mm) geram aviso. */
  minFeature: number;
  /** Orientação escolhida à mão para algumas peças (rotação sem translação). */
  rotations: Record<string, Mat4>;
}

export interface Doc {
  model: ModelState | null;
  /** Modelo como foi importado, para "Restaurar". */
  original: ModelState | null;
  parts: Part[];
  cuts: CutRecord[];
  nextCutId: number;
  interfaces: Interface[];
  regions: RegionSession | null;
  connectors: { defaults: ConnectorSettings; overrides: Record<string, ConnectorOverride> };
  print: PrintSettings;
  splitReport: IslandReport[] | null;
}

export interface Busy {
  label: string;
  fraction: number;
  cancellable: boolean;
}

export interface Toast {
  id: number;
  kind: "info" | "sucesso" | "aviso" | "erro";
  text: string;
}

export interface UiState {
  stage: Stage;
  tool: Tool;
  brushRadius: number;
  frontOnly: boolean;
  fillAngle: number;
  colorTolerance: number;
  attributeKind: "cor" | "material" | "objeto";
  selectedPartId: string | null;
  selectedInterfaceId: string | null;
  /** Região que o pincel pinta. */
  activeRegion: number;
  explode: number;
  splitMode: SplitMode;
  planeFrame: PlaneFrame | null;
  planeSeparate: boolean;
  plans: ConnectorPlan[];
  plansStale: boolean;
  final: AppliedConnectorsResult | null;
  layoutMode: "montada" | "mesa";
  busy: Busy | null;
  toasts: Toast[];
  segmentation: { providerId: string; sensitivity: number; maxSegments: number; remoteUrl: string };
  showConnectors: boolean;
  wireframe: boolean;
}

export interface AppState {
  doc: Doc;
  past: Doc[];
  future: Doc[];
  ui: UiState;
}

const defaultBed = bedPresets[0];

export const emptyDoc: Doc = {
  model: null,
  original: null,
  parts: [],
  cuts: [],
  nextCutId: 1,
  interfaces: [],
  regions: null,
  connectors: { defaults: defaultConnectorSettings, overrides: {} },
  print: { bedId: defaultBed.id, bed: defaultBed.size, material: "pla", minFeature: 4, rotations: {} },
  splitReport: null,
};

export const initialUi: UiState = {
  stage: "modelo",
  tool: "orbitar",
  brushRadius: 4,
  frontOnly: true,
  fillAngle: 25,
  colorTolerance: 30,
  attributeKind: "cor",
  selectedPartId: null,
  selectedInterfaceId: null,
  activeRegion: 1,
  explode: 0,
  splitMode: "auto",
  planeFrame: null,
  planeSeparate: false,
  plans: [],
  plansStale: true,
  final: null,
  layoutMode: "montada",
  busy: null,
  toasts: [],
  segmentation: { providerId: "geometrica", sensitivity: 0.5, maxSegments: 12, remoteUrl: "" },
  showConnectors: true,
  wireframe: false,
};

type Listener = () => void;

function createStore(initial: AppState) {
  let state = initial;
  const listeners = new Set<Listener>();
  return {
    get: () => state,
    set(next: AppState) {
      state = next;
      for (const l of listeners) l();
    },
    subscribe(l: Listener) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

export const store = createStore({ doc: emptyDoc, past: [], future: [], ui: initialUi });

const HISTORY_LIMIT = 40;

/** Nova versão do documento (entra no histórico de desfazer). */
export function commit(update: (doc: Doc) => Doc) {
  const s = store.get();
  const next = update(s.doc);
  if (next === s.doc) return;
  store.set({ ...s, doc: next, past: [...s.past, s.doc].slice(-HISTORY_LIMIT), future: [] });
}

/** Ajuste do documento atual sem criar passo de histórico (dados derivados). */
export function patchDoc(update: (doc: Doc) => Doc) {
  const s = store.get();
  store.set({ ...s, doc: update(s.doc) });
}

export function setUi(update: Partial<UiState> | ((ui: UiState) => Partial<UiState>)) {
  const s = store.get();
  const partial = typeof update === "function" ? update(s.ui) : update;
  store.set({ ...s, ui: { ...s.ui, ...partial } });
}

export function undo() {
  const s = store.get();
  if (!s.past.length) return;
  const prev = s.past[s.past.length - 1];
  store.set({ ...s, doc: prev, past: s.past.slice(0, -1), future: [s.doc, ...s.future], ui: { ...s.ui, plansStale: true, final: null } });
}

export function redo() {
  const s = store.get();
  if (!s.future.length) return;
  const [next, ...rest] = s.future;
  store.set({ ...s, doc: next, past: [...s.past, s.doc], future: rest, ui: { ...s.ui, plansStale: true, final: null } });
}

export function useApp<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(store.subscribe, () => selector(store.get()));
}

let toastSeq = 0;
export function toast(kind: Toast["kind"], text: string, ms = 5000) {
  const id = ++toastSeq;
  setUi((ui) => ({ toasts: [...ui.toasts, { id, kind, text }].slice(-5) }));
  if (ms > 0) setTimeout(() => setUi((ui) => ({ toasts: ui.toasts.filter((t) => t.id !== id) })), ms);
}

let partSeq = 0;
export const newPartId = () => `p${++partSeq}_${Date.now().toString(36)}`;
