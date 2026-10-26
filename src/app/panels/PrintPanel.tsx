import { useEffect, useState } from "react";
import { type MaterialKind, materialNames } from "../../core/connectors";
import { bedPresets, fitsBed } from "../../core/layout";
import { autoFitAll, buildFinal, estimateMass, relayout, resetPartRotation, rotatePartOnBed, setBedPreset, setCustomBed, setMaterial } from "../actions";
import { setUi, store, useApp } from "../state";
import { Field, Hint, NumberInput, Section, Segmented, Slider, Stat, fmt, fmtSize } from "../ui";

export function PrintPanel() {
  const d = useApp((s) => s.doc);
  const final = useApp((s) => s.ui.final);
  const busy = useApp((s) => s.ui.busy !== null);
  const layoutMode = useApp((s) => s.ui.layoutMode);
  const [infill, setInfill] = useState(15);

  useEffect(() => {
    if (!store.get().ui.final && !store.get().ui.busy && d.parts.length) buildFinal();
  }, [d.parts, d.print.bed, d.interfaces, d.connectors]);

  const names = new Map(d.parts.map((p) => [p.id, p]));
  const placements = new Map((final?.layout?.placements ?? []).map((p) => [p.id, p]));
  const rows = final
    ? [
        ...final.parts.map((p) => ({ id: p.id, name: names.get(p.id)?.name ?? p.id, color: names.get(p.id)?.color ?? "#999", stats: p.stats })),
        ...final.extras.map((e) => ({ id: e.id, name: e.name, color: "#ffd166", stats: e.stats })),
      ]
    : d.parts.map((p) => ({ id: p.id, name: p.name, color: p.color, stats: p.stats }));
  const totalVolume = rows.reduce((s, r) => s + r.stats.volume, 0);
  const totalMass = rows.reduce((s, r) => s + estimateMass(r.stats.volume, r.stats.area, d.print.material, infill / 100), 0);
  const oversize = rows.filter((r) => {
    const p = placements.get(r.id);
    return p ? !p.fits : !fitsBed(r.stats.size, d.print.bed);
  });
  const small = rows.filter((r) => Math.max(...r.stats.size) < d.print.minFeature || r.stats.volume < 30);
  const thin = rows.filter((r) => r.stats.thinWall > 0 && r.stats.thinWall < (d.print.material === "resina" ? 0.6 : 1.0));

  return (
    <div className="panel">
      <Section title="Impressora">
        <Field label="Modelo">
          <select value={d.print.bedId} onChange={(e) => setBedPreset(e.target.value)}>
            {bedPresets.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
                {b.id !== "custom" ? ` — ${b.size.join(" × ")} mm` : ""}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Volume de impressão (X × Y × Z)">
          <div className="bed-dims">
            {[0, 1, 2].map((k) => (
              <NumberInput
                key={k}
                value={d.print.bed[k]}
                min={10}
                max={2000}
                suffix={k === 2 ? "mm" : undefined}
                onChange={(v) => {
                  const b = [...d.print.bed] as [number, number, number];
                  b[k] = v;
                  setCustomBed(b);
                }}
              />
            ))}
          </div>
        </Field>
        <Field label="Material">
          <select value={d.print.material} onChange={(e) => setMaterial(e.target.value as MaterialKind)}>
            {(Object.keys(materialNames) as MaterialKind[]).map((m) => (
              <option key={m} value={m}>
                {materialNames[m]}
              </option>
            ))}
          </select>
        </Field>
        <Hint>Confira o volume útil no manual da sua impressora. O material também ajusta a folga dos encaixes.</Hint>
      </Section>

      <Section title="Disposição">
        <Segmented
          value={layoutMode}
          onChange={(v) => setUi({ layoutMode: v })}
          options={[
            { value: "montada", label: "Montada", hint: "Peças na posição original" },
            { value: "mesa", label: "Organizada na mesa", hint: "Peças deitadas na face de corte e distribuídas" },
          ]}
        />
        {final?.layout && (
          <Hint>
            {final.layout.plates} mesa{final.layout.plates > 1 ? "s" : ""} de impressão. Peças apoiadas na face de corte plana sempre que
            possível (menos suporte, melhor aderência).
          </Hint>
        )}
        <button type="button" disabled={busy} onClick={() => relayout()}>
          Recalcular disposição
        </button>
      </Section>

      <Section title="Verificações">
        <div className="stats-grid">
          <Stat label="Peças" value={rows.length} />
          <Stat label="Volume total" value={`${fmt(totalVolume / 1000, 1)} cm³`} />
          <Stat label={`Massa (≈${infill}% preench.)`} value={`${fmt(totalMass, 0)} g`} />
        </div>
        <Field label="Preenchimento (para a estimativa)">
          <Slider value={infill} min={5} max={100} step={5} format={(v) => `${v}%`} onChange={setInfill} />
        </Field>
        {oversize.length > 0 ? (
          <Hint kind="erro">
            {oversize.length} peça(s) não cabem na mesa: {oversize.map((r) => r.name).join(", ")}.{" "}
            <button type="button" className="link" disabled={busy} onClick={autoFitAll}>
              Dividir automaticamente
            </button>
          </Hint>
        ) : (
          <Hint kind="sucesso">Todas as peças cabem na mesa.</Hint>
        )}
        {small.length > 0 && <Hint kind="aviso">Peças muito pequenas (difíceis de imprimir e montar): {small.map((r) => r.name).join(", ")}.</Hint>}
        {thin.length > 0 && (
          <Hint kind="aviso">
            Paredes finas/frágeis detectadas em: {thin.map((r) => `${r.name} (${fmt(r.stats.thinWall, 1)} mm)`).join(", ")}.
          </Hint>
        )}
        <table className="parts-table">
          <thead>
            <tr>
              <th>Peça</th>
              <th>Dimensões na mesa</th>
              <th>Massa</th>
              <th title="Girar 90° na mesa">Girar</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const p = placements.get(r.id);
              const fits = p ? p.fits : fitsBed(r.stats.size, d.print.bed);
              return (
                <tr key={r.id} title={p?.reason}>
                  <td>
                    <span className="dot" style={{ background: r.color }} />
                    {r.name}
                  </td>
                  <td>{fmtSize(p?.size ?? r.stats.size)}</td>
                  <td>{fmt(estimateMass(r.stats.volume, r.stats.area, d.print.material, infill / 100), 0)} g</td>
                  <td className="rotate-cell">
                    {(["x", "y", "z"] as const).map((a) => (
                      <button key={a} type="button" disabled={busy || !final} title={`Girar 90° em ${a.toUpperCase()}`} onClick={() => rotatePartOnBed(r.id, a)}>
                        {a.toUpperCase()}
                      </button>
                    ))}
                    {d.print.rotations[r.id] && (
                      <button type="button" disabled={busy} title="Voltar à orientação automática" onClick={() => resetPartRotation(r.id)}>
                        auto
                      </button>
                    )}
                  </td>
                  <td className={fits ? "ok" : "bad"}>{fits ? "✓" : "✖"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Section>

      <button type="button" className="primary wide" onClick={() => setUi({ stage: "exportar" })}>
        Próximo: exportar →
      </button>
    </div>
  );
}
