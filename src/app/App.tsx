import { useEffect, useRef, useState } from "react";
import { cancelBusy, cancelPlaneTool, loadSample, openFile } from "./actions";
import { APP_NAME, APP_TAGLINE } from "./brand";
import { Header } from "./Header";
import { ACCEPTED } from "./importers";
import { PartsPanel } from "./PartsPanel";
import { ConnectorPanel } from "./panels/ConnectorPanel";
import { ExportPanel } from "./panels/ExportPanel";
import { ModelPanel } from "./panels/ModelPanel";
import { PrintPanel } from "./panels/PrintPanel";
import { SplitPanel } from "./panels/SplitPanel";
import { type Tool, redo, setUi, store, undo, useApp } from "./state";
import { fmtSize } from "./ui";
import { ViewerPane } from "./ViewerPane";

const SHORTCUTS: Record<string, Tool> = { o: "orbitar", b: "pincel", e: "borracha", s: "inteligente", g: "balde", c: "casca", m: "atributo" };

export function App() {
  const hasModel = useApp((s) => s.doc.model !== null);
  const stage = useApp((s) => s.ui.stage);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT") return;
      const s = store.get();
      if (s.ui.busy) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
      } else if (s.ui.stage === "dividir" && !e.ctrlKey && !e.metaKey) {
        const tool = SHORTCUTS[e.key.toLowerCase()];
        if (tool) setUi({ tool, planeFrame: null });
        if (e.key === "[") setUi({ brushRadius: Math.max(0.5, s.ui.brushRadius / 1.25) });
        if (e.key === "]") setUi({ brushRadius: Math.min(40, s.ui.brushRadius * 1.25) });
        if (e.key === "Escape" && s.ui.tool === "plano") cancelPlaneTool();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div
      className={`app ${dragging ? "dragging" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const f = e.dataTransfer.files?.[0];
        if (f) openFile(f);
      }}
    >
      <Header />
      {hasModel ? (
        <main className="workspace">
          <PartsPanel />
          <section className="center">
            <ViewerPane />
            <StatusBar />
          </section>
          <aside className="side-panel">
            {stage === "modelo" && <ModelPanel />}
            {stage === "dividir" && <SplitPanel />}
            {stage === "encaixes" && <ConnectorPanel />}
            {stage === "impressao" && <PrintPanel />}
            {stage === "exportar" && <ExportPanel />}
          </aside>
        </main>
      ) : (
        <Landing />
      )}
      <BusyOverlay />
      <Toasts />
      {dragging && <div className="drop-overlay">Solte o arquivo para abrir ({ACCEPTED.join(", ")})</div>}
    </div>
  );
}

function Landing() {
  const input = useRef<HTMLInputElement>(null);
  const busy = useApp((s) => s.ui.busy !== null);
  return (
    <main className="landing">
      <section className="hero">
        <h1>
          {APP_NAME}
          <span>{APP_TAGLINE}</span>
        </h1>
        <p>
          Importe um STL, OBJ, 3MF, GLB ou PLY de qualquer origem. Separe cabeça, braços, pernas, acessórios e base, feche os cortes
          com tampas, crie pinos e furos que se encaixam e baixe tudo pronto para o fatiador.
        </p>
        <div
          className="drop-zone"
          role="button"
          tabIndex={0}
          onClick={() => input.current?.click()}
          onKeyDown={(e) => e.key === "Enter" && input.current?.click()}
        >
          <strong>Arraste o arquivo para cá</strong>
          <span>ou clique para escolher · {ACCEPTED.join(" ")}</span>
        </div>
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
        <button type="button" className="link-button" disabled={busy} onClick={loadSample}>
          Sem arquivo? Carregue o boneco de exemplo →
        </button>
      </section>
      <section className="features">
        {[
          ["Divisão inteligente", "Sugere cabeça, tronco, braços, pernas e base pela espessura e pelas juntas do modelo. Você escolhe o que separar."],
          ["Pintura e corte manual", "Pincel, balde, seleção por casca, cor ou material e plano de corte com alças para corrigir qualquer região."],
          ["Cortes fechados", "Cada peça sai estanque: as faces de corte são tampadas e validadas como sólidos (manifold)."],
          ["Encaixes que encaixam", "Pinos, cavilhas e ímãs dimensionados pela seção do corte, com folga por material e checagem de colisão."],
          ["Pronto para a mesa", "Verifica o volume da impressora, deita as peças na face plana, distribui em mesas e estima o material."],
          ["Privado", "Tudo roda no navegador. Seus modelos não saem do computador."],
        ].map(([t, d]) => (
          <article key={t}>
            <h3>{t}</h3>
            <p>{d}</p>
          </article>
        ))}
      </section>
    </main>
  );
}

function StatusBar() {
  const model = useApp((s) => s.doc.model);
  const parts = useApp((s) => s.doc.parts.length);
  const ifaces = useApp((s) => s.doc.interfaces.length);
  const tool = useApp((s) => s.ui.tool);
  const stage = useApp((s) => s.ui.stage);
  if (!model) return null;
  return (
    <footer className="status-bar">
      <span>{model.report.triangles.toLocaleString("pt-BR")} triângulos</span>
      <span>{fmtSize(model.report.size)}</span>
      <span className={model.manifoldOk ? "ok" : "bad"}>{model.manifoldOk ? "● sólido fechado" : "● malha com defeitos"}</span>
      <span>
        {parts} peça{parts > 1 ? "s" : ""} · {ifaces} corte{ifaces === 1 ? "" : "s"}
      </span>
      {stage === "dividir" && tool !== "orbitar" && <span className="tool-hint">Ferramenta: {tool} · botão direito gira a vista</span>}
    </footer>
  );
}

function BusyOverlay() {
  const busy = useApp((s) => s.ui.busy);
  if (!busy) return null;
  return (
    <div className="busy" role="status">
      <div className="busy-card">
        <div className="spinner" />
        <div>
          <strong>{busy.label}</strong>
          <div className="progress">
            <div style={{ width: `${Math.round(Math.min(1, Math.max(0.03, busy.fraction)) * 100)}%` }} />
          </div>
        </div>
        {busy.cancellable && (
          <button type="button" onClick={cancelBusy}>
            Cancelar
          </button>
        )}
      </div>
    </div>
  );
}

function Toasts() {
  const toasts = useApp((s) => s.ui.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast toast-${t.kind}`}
          onClick={() => setUi((ui) => ({ toasts: ui.toasts.filter((x) => x.id !== t.id) }))}
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}
