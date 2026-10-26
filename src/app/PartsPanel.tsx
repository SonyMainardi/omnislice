import { useState } from "react";
import {
  deletePart,
  exportSinglePart,
  isolatePart,
  mergeSelected,
  renamePart,
  selectPart,
  separateLoose,
  setPartColor,
  showAllParts,
  togglePartVisible,
} from "./actions";
import { useApp } from "./state";
import { fmt, fmtSize } from "./ui";

export function PartsPanel() {
  const parts = useApp((s) => s.doc.parts);
  const selected = useApp((s) => s.ui.selectedPartId);
  const busy = useApp((s) => s.ui.busy !== null);
  const interfaces = useApp((s) => s.doc.interfaces);
  const [multi, setMulti] = useState<string[]>([]);
  const [editing, setEditing] = useState<string | null>(null);

  const toggleMulti = (id: string) => setMulti((m) => (m.includes(id) ? m.filter((x) => x !== id) : [...m, id]));
  const totalVolume = parts.reduce((s, p) => s + p.stats.volume, 0);

  return (
    <aside className="parts-panel">
      <header>
        <h2>Peças</h2>
        <span className="badge">{parts.length}</span>
      </header>
      <ul className="parts-list">
        {parts.map((p) => {
          const links = interfaces.filter((i) => i.front === p.id || i.back === p.id).length;
          return (
            <li
              key={p.id}
              className={`${p.id === selected ? "selected" : ""} ${p.visible ? "" : "hidden-part"}`}
              onClick={(e) => (e.ctrlKey || e.metaKey ? toggleMulti(p.id) : selectPart(p.id))}
            >
              <input
                type="checkbox"
                className="multi"
                title="Selecionar para juntar"
                checked={multi.includes(p.id)}
                onClick={(e) => e.stopPropagation()}
                onChange={() => toggleMulti(p.id)}
              />
              <label className="swatch" style={{ background: p.color }} title="Trocar a cor" onClick={(e) => e.stopPropagation()}>
                <input type="color" value={p.color} onChange={(e) => setPartColor(p.id, e.target.value)} />
              </label>
              <div className="part-info">
                {editing === p.id ? (
                  <input
                    autoFocus
                    defaultValue={p.name}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={(e) => {
                      if (e.target.value.trim()) renamePart(p.id, e.target.value.trim());
                      setEditing(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                      if (e.key === "Escape") setEditing(null);
                    }}
                  />
                ) : (
                  <span className="part-name" onDoubleClick={() => setEditing(p.id)} title="Clique duplo para renomear">
                    {p.name}
                  </span>
                )}
                <small>
                  {fmtSize(p.stats.size)}
                  {links ? ` · ${links} encaixe${links > 1 ? "s" : ""}` : ""}
                  {!p.stats.solid ? " · não fechada" : ""}
                  {p.stats.components > 1 ? ` · ${p.stats.components} cascas` : ""}
                </small>
              </div>
              <button
                type="button"
                className="icon"
                title={p.visible ? "Ocultar" : "Mostrar"}
                onClick={(e) => {
                  e.stopPropagation();
                  togglePartVisible(p.id);
                }}
              >
                {p.visible ? "👁" : "–"}
              </button>
            </li>
          );
        })}
      </ul>
      {parts.length > 0 && (
        <div className="parts-actions">
          {selected && (
            <>
              <button type="button" disabled={busy} onClick={() => isolatePart(selected)}>
                Isolar
              </button>
              <button type="button" disabled={busy} onClick={() => showAllParts()}>
                Mostrar todas
              </button>
              <button type="button" disabled={busy} onClick={() => setEditing(selected)}>
                Renomear
              </button>
              <button type="button" disabled={busy} onClick={() => separateLoose(selected)} title="Cada casca solta vira uma peça">
                Separar cascas
              </button>
              <button type="button" disabled={busy} onClick={() => exportSinglePart(selected)}>
                Baixar STL
              </button>
              {parts.length > 1 && (
                <button type="button" className="danger" disabled={busy} onClick={() => deletePart(selected)}>
                  Excluir
                </button>
              )}
            </>
          )}
          {multi.length >= 2 && (
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => {
                mergeSelected(multi);
                setMulti([]);
              }}
            >
              Juntar {multi.length} peças
            </button>
          )}
        </div>
      )}
      <footer className="parts-footer">
        Volume total: <strong>{fmt(totalVolume / 1000, 1)} cm³</strong>
        <br />
        <small>Ctrl+clique ou caixa de seleção para juntar peças.</small>
      </footer>
    </aside>
  );
}
