import type { OpName, Ops, Response } from "./protocol";

export type ProgressListener = (fraction: number, label: string) => void;

export class CancelledError extends Error {
  constructor() {
    super("Operação cancelada.");
  }
}

export class WorkerError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  onProgress?: ProgressListener;
}

/** Cliente tipado do worker de geometria. Cancelar encerra o worker e cria outro limpo. */
export class GeometryClient {
  private worker!: Worker;
  private seq = 0;
  private pending = new Map<number, Pending>();

  constructor() {
    this.spawn();
  }

  private spawn() {
    this.worker = new Worker(new URL("./geometry.worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (ev: MessageEvent<Response>) => {
      const msg = ev.data;
      const p = this.pending.get(msg.id);
      if (!p) return;
      if (msg.type === "progress") {
        p.onProgress?.(msg.fraction, msg.label);
        return;
      }
      this.pending.delete(msg.id);
      if (msg.type === "result") p.resolve(msg.result);
      else p.reject(new WorkerError(msg.message, msg.code));
    };
    this.worker.onerror = (ev) => {
      const error = new WorkerError(`Falha no processador de geometria: ${ev.message || "erro desconhecido"}`);
      for (const p of this.pending.values()) p.reject(error);
      this.pending.clear();
    };
  }

  call<K extends OpName>(op: K, args: Ops[K]["args"], onProgress?: ProgressListener): Promise<Ops[K]["result"]> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onProgress });
      this.worker.postMessage({ id, op, args });
    });
  }

  /** Interrompe tudo o que está em andamento. */
  cancelAll() {
    this.worker.terminate();
    for (const p of this.pending.values()) p.reject(new CancelledError());
    this.pending.clear();
    this.spawn();
  }

  get busy() {
    return this.pending.size > 0;
  }
}

export const geometry = new GeometryClient();
