import type { Manifold, ManifoldToplevel } from "manifold-3d";
import { type PlaneFrame, frameToWorldMatrix } from "./math";
import { triCount } from "./mesh";
import { CONNECTOR_TAG, NO_CUT, type PartGeometry, cutTag } from "./part";

export type Wasm = ManifoldToplevel;

let loader: (() => Promise<ManifoldToplevel>) | null = null;
let instance: Promise<ManifoldToplevel> | null = null;

/** Permite ao navegador informar a URL do .wasm empacotado. No Node o carregamento padrão funciona. */
export function configureManifold(load: () => Promise<ManifoldToplevel>): void {
  loader = load;
  instance = null;
}

export function getManifold(): Promise<ManifoldToplevel> {
  if (!instance) {
    const load =
      loader ??
      (async () => {
        const mod = await import("manifold-3d");
        return mod.default();
      });
    instance = load().then((w) => {
      w.setup();
      return w;
    });
  }
  return instance;
}

/** Objetos do WASM não são coletados pelo GC: o Arena libera tudo o que não foi entregue ao chamador. */
export class Arena {
  private items = new Set<{ delete(): void }>();

  track<T extends { delete(): void }>(x: T): T {
    this.items.add(x);
    return x;
  }

  trackAll<T extends { delete(): void }>(xs: T[]): T[] {
    for (const x of xs) this.items.add(x);
    return xs;
  }

  /** Retira o objeto do Arena: o chamador passa a ser responsável por `delete()`. */
  release<T extends { delete(): void }>(x: T): T {
    this.items.delete(x);
    return x;
  }

  dispose(): void {
    for (const x of this.items) {
      try {
        x.delete();
      } catch {
        // Objeto já liberado.
      }
    }
    this.items.clear();
  }
}

export class GeometryError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

type RunSource =
  | { kind: "input"; geometry: PartGeometry }
  | { kind: "cut"; cutId: number }
  | { kind: "connector" };

/**
 * Registro de "runs" do Manifold. Cada malha de entrada recebe um id único e faceID = índice do
 * triângulo, então qualquer triângulo de saída pode ser rastreado até a peça e a face que o geraram.
 */
export class RunRegistry {
  private runs = new Map<number, RunSource>();

  constructor(private readonly w: Wasm) {}

  /** Constrói um Manifold a partir de uma peça. Lança GeometryError se a malha não for um sólido fechado. */
  fromGeometry(g: PartGeometry): Manifold {
    const { Manifold, Mesh } = this.w;
    const n = triCount(g.mesh);
    const id = Manifold.reserveIDs(1);
    this.runs.set(id, { kind: "input", geometry: g });
    const faceID = new Uint32Array(n);
    for (let i = 0; i < n; i++) faceID[i] = i;
    const options = {
      numProp: 3,
      vertProperties: g.mesh.positions,
      triVerts: g.mesh.indices,
      faceID,
      runIndex: new Uint32Array([0, n * 3]),
      runOriginalID: new Uint32Array([id]),
    };
    try {
      return new Manifold(new Mesh(options));
    } catch (first) {
      // Tenta mesclar vértices coincidentes antes de desistir.
      const mesh = new Mesh(options);
      if (mesh.merge()) {
        try {
          return new Manifold(mesh);
        } catch {
          // Cai no erro original abaixo.
        }
      }
      const code = (first as { code?: string }).code ?? "NotManifold";
      throw new GeometryError(
        code === "NotManifold"
          ? "A malha não é um sólido fechado (manifold). Use a etapa de reparo antes de dividir."
          : `O Manifold rejeitou a malha (${code}).`,
        code,
      );
    }
  }

  /** Semi-espaço do lado positivo do plano, marcado como o corte `cutId`. */
  halfSpace(frame: PlaneFrame, size: number, cutId: number): Manifold {
    const { Manifold } = this.w;
    const cube = Manifold.cube([size, size, size]).translate([-size / 2, -size / 2, 0]);
    const original = cube.asOriginal();
    cube.delete();
    this.runs.set(original.originalID(), { kind: "cut", cutId });
    const placed = original.transform(frameToWorldMatrix(frame));
    original.delete();
    return placed;
  }

  /** Marca um sólido auxiliar (pino, furo) como geometria de encaixe. */
  connector(solid: Manifold): Manifold {
    const original = solid.asOriginal();
    this.runs.set(original.originalID(), { kind: "connector" });
    return original;
  }

  /** Converte o resultado de volta em PartGeometry, resolvendo a origem de cada triângulo. */
  toGeometry(m: Manifold): PartGeometry {
    const mesh = m.getMesh();
    const n = mesh.numTri;
    const positions = Float32Array.from(mesh.vertProperties);
    const indices = Uint32Array.from(mesh.triVerts);
    if (mesh.mergeFromVert && mesh.mergeFromVert.length > 0) {
      const to = new Uint32Array(positions.length / 3);
      for (let i = 0; i < to.length; i++) to[i] = i;
      for (let i = 0; i < mesh.mergeFromVert.length; i++) to[mesh.mergeFromVert[i]] = mesh.mergeToVert[i];
      for (let i = 0; i < indices.length; i++) indices[i] = to[indices[i]];
    }
    const src = new Int32Array(n).fill(-1);
    const cut = new Int32Array(n).fill(NO_CUT);
    for (let r = 0; r < mesh.numRun; r++) {
      const source = this.runs.get(mesh.runOriginalID[r]);
      const start = mesh.runIndex[r] / 3;
      const end = mesh.runIndex[r + 1] / 3;
      if (!source) continue;
      if (source.kind === "input") {
        const g = source.geometry;
        for (let t = start; t < end; t++) {
          const f = mesh.faceID[t];
          src[t] = g.src[f];
          cut[t] = g.cut[f];
        }
      } else if (source.kind === "cut") {
        const tag = cutTag(source.cutId, mesh.backside(r) ? 1 : 0);
        for (let t = start; t < end; t++) cut[t] = tag;
      } else {
        for (let t = start; t < end; t++) cut[t] = CONNECTOR_TAG;
      }
    }
    return { mesh: { positions, indices }, src, cut };
  }
}

/** Tamanho seguro para um semi-espaço que envolve todo o modelo. */
export function halfSpaceSize(m: Manifold): number {
  const b = m.boundingBox();
  const extent = Math.max(
    Math.abs(b.min[0]),
    Math.abs(b.min[1]),
    Math.abs(b.min[2]),
    Math.abs(b.max[0]),
    Math.abs(b.max[1]),
    Math.abs(b.max[2]),
    1,
  );
  return extent * 8;
}
