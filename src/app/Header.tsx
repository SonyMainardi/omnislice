import { useRef } from "react";
import { APP_NAME } from "./brand";
import { closeModel, openFile, restoreOriginal } from "./actions";
import { ACCEPTED } from "./importers";
import { type Stage, redo, setUi, undo, useApp } from "./state";

export const STAGES: { id: Stage; label: string; hint: string }[] = [
  { id: "modelo", label: "Modelo", hint: "Importar, conferir e reparar" },
  { id: "dividir", label: "Dividir", hint: "Divisão automática, por seleção ou manual" },
  { id: "encaixes", label: "Encaixes", hint: "Pinos, furos e folgas" },
  { id: "impressao", label: "Impressão", hint: "Mesa, orientação e verificações" },
  { id: "exportar", label: "Exportar", hint: "STL, 3MF, OBJ e ZIP" },
];

export function Header() {
  const stage = useApp((s) => s.ui.stage);
  const hasModel = useApp((s) => s.doc.model !== null);
  const canUndo = useApp((s) => s.past.length > 0);
  const canRedo = useApp((s) => s.future.length > 0);
  const busy = useApp((s) => s.ui.busy !== null);
  const fileName = useApp((s) => s.doc.model?.fileName);
  const input = useRef<HTMLInputElement>(null);

  return (
    <header className="app-header">
      <div className="brand">
        <svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true">
          <path d="M16 3 28 10v12L16 29 4 22V10z" fill="none" stroke="currentColor" strokeWidth="2" />
          <path d="M16 3v26M4 10l24 12M28 10 4 22" stroke="currentColor" strokeWidth="1.2" opacity=".55" />
        </svg>
        <strong>{APP_NAME}</strong>
        {fileName && <span className="file-name" title={fileName}>{fileName}</span>}
      </div>
      {hasModel && (
        <nav className="stages">
          {STAGES.map((s, i) => (
            <button
              key={s.id}
              type="button"
              className={s.id === stage ? "active" : ""}
              title={s.hint}
              onClick={() => setUi(s.id === "dividir" ? { stage: s.id } : { stage: s.id, tool: "orbitar", planeFrame: null })}
            >
              <span className="step">{i + 1}</span>
              {s.label}
            </button>
          ))}
        </nav>
      )}
      <div className="header-actions">
        {hasModel && (
          <>
            <button type="button" disabled={!canUndo || busy} onClick={undo} title="Desfazer (Ctrl+Z)">
              ↶ Desfazer
            </button>
            <button type="button" disabled={!canRedo || busy} onClick={redo} title="Refazer (Ctrl+Y)">
              ↷ Refazer
            </button>
            <button type="button" disabled={busy} onClick={restoreOriginal} title="Volta ao arquivo como foi importado">
              Restaurar
            </button>
            <button type="button" disabled={busy} onClick={() => setUi({ stage: "exportar", tool: "orbitar", planeFrame: null })} title="STL, 3MF, OBJ e ZIP">
              Exportar
            </button>
            <button type="button" disabled={busy} onClick={closeModel} title="Fecha este modelo para abrir outro">
              ✕ Fechar modelo
            </button>
          </>
        )}
        <button type="button" className="primary" disabled={busy} onClick={() => input.current?.click()}>
          Abrir arquivo
        </button>
        <input
          ref={input}
          type="file"
          accept={ACCEPTED.join(",")}
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) openFile(f);
            e.target.value = "";
          }}
        />
      </div>
    </header>
  );
}
