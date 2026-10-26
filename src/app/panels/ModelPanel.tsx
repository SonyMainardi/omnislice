import { useState } from "react";
import { type RepairOptions, defaultRepairOptions } from "../../core/repair";
import { checkIntersections, mirrorModel, remeshModel, repairModel, rotateModel, scaleModel } from "../actions";
import { setUi, useApp } from "../state";
import { Field, Hint, NumberInput, Section, Segmented, Stat, Toggle, fmt, fmtSize } from "../ui";

const severityIcon = { erro: "✖", aviso: "⚠", info: "ℹ" } as const;

export function ModelPanel() {
  const model = useApp((s) => s.doc.model);
  const busy = useApp((s) => s.ui.busy !== null);
  const [repair, setRepair] = useState<RepairOptions>(defaultRepairOptions);
  const [resolution, setResolution] = useState("200");
  if (!model) return null;
  const r = model.report;
  const height = r.size[2];
  const setR = (p: Partial<RepairOptions>) => setRepair((o) => ({ ...o, ...p }));

  return (
    <div className="panel">
      <Section title="Arquivo">
        <div className="stats-grid">
          <Stat label="Formato" value={model.format} />
          <Stat label="Triângulos" value={r.triangles.toLocaleString("pt-BR")} />
          <Stat label="Dimensões" value={fmtSize(r.size)} />
          <Stat label="Volume" value={`${fmt(r.volume / 1000, 2)} cm³`} />
          <Stat label="Área" value={`${fmt(r.area / 100, 1)} cm²`} />
          <Stat label="Cascas" value={r.components} />
        </div>
        {model.notes.map((n) => (
          <Hint key={n}>{n}</Hint>
        ))}
      </Section>

      <Section title="Diagnóstico da malha" aside={<span className={`pill ${model.manifoldOk ? "ok" : "bad"}`}>{model.manifoldOk ? "pronta" : "precisa de reparo"}</span>}>
        <ul className="issues">
          {r.issues.map((i) => (
            <li key={i.code} className={`issue-${i.severity}`}>
              <span>{severityIcon[i.severity]}</span> {i.message}
            </li>
          ))}
        </ul>
        <button type="button" disabled={busy} onClick={checkIntersections}>
          {r.selfIntersections === null ? "Verificar autointerseções" : `Autointerseções: ${r.selfIntersections}${r.selfIntersections >= 1000 ? "+" : ""} — verificar de novo`}
        </button>
        {model.repairLog.length > 0 && (
          <div className="log">
            <strong>Último reparo</strong>
            <ul>
              {model.repairLog.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          </div>
        )}
      </Section>

      <Section title="Reparo automático" open={!model.manifoldOk}>
        <Toggle label="Remover faces degeneradas" checked={repair.removeDegenerate} onChange={(v) => setR({ removeDegenerate: v })} />
        <Toggle label="Remover faces duplicadas" checked={repair.removeDuplicates} onChange={(v) => setR({ removeDuplicates: v })} />
        <Toggle label="Corrigir normais invertidas" checked={repair.fixOrientation} onChange={(v) => setR({ fixOrientation: v })} />
        <Toggle label="Fechar buracos" checked={repair.fillHoles} onChange={(v) => setR({ fillHoles: v })} />
        <Toggle
          label="Remover fragmentos minúsculos"
          checked={repair.removeSmallComponents}
          onChange={(v) => setR({ removeSmallComponents: v })}
          hint="Cascas com menos de 0,05% da área total"
        />
        <button type="button" className="primary" disabled={busy} onClick={() => repairModel(repair)}>
          Reparar malha
        </button>
        <Hint>O arquivo original nunca é alterado: o reparo cria uma nova versão (use Desfazer ou Restaurar).</Hint>
        <details className="sub">
          <summary>Reconstrução por voxels (malhas muito quebradas)</summary>
          <Hint kind="aviso">
            Refaz a superfície como um sólido fechado. Resolve arestas não-manifold e cascas sobrepostas, mas perde detalhes
            menores que a resolução e descarta cores.
          </Hint>
          <Field label="Resolução (células no maior lado)">
            <Segmented
              value={resolution}
              onChange={setResolution}
              options={[
                { value: "120", label: "Rápida" },
                { value: "200", label: "Média" },
                { value: "320", label: "Fina" },
              ]}
            />
          </Field>
          <button type="button" disabled={busy} onClick={() => remeshModel(Number(resolution))}>
            Reconstruir
          </button>
        </details>
      </Section>

      <Section title="Escala">
        <Field label="Altura (Z)">
          <NumberInput value={Number(height.toFixed(2))} min={0.01} suffix="mm" onChange={(v) => scaleModel(v / height)} />
        </Field>
        <div className="button-row">
          <button type="button" disabled={busy} onClick={() => scaleModel(0.5)}>
            ×0,5
          </button>
          <button type="button" disabled={busy} onClick={() => scaleModel(2)}>
            ×2
          </button>
          <button type="button" disabled={busy} onClick={() => scaleModel(10)} title="O arquivo estava em centímetros">
            cm → mm
          </button>
          <button type="button" disabled={busy} onClick={() => scaleModel(25.4)} title="O arquivo estava em polegadas">
            pol → mm
          </button>
          <button type="button" disabled={busy} onClick={() => scaleModel(1000)} title="O arquivo estava em metros (comum em GLB)">
            m → mm
          </button>
        </div>
      </Section>

      <Section title="Orientação">
        <div className="button-row">
          {(["x", "y", "z"] as const).map((a) => (
            <span key={a} className="rot-pair">
              <button type="button" disabled={busy} onClick={() => rotateModel(a, -90)}>
                {a.toUpperCase()} −90°
              </button>
              <button type="button" disabled={busy} onClick={() => rotateModel(a, 90)}>
                {a.toUpperCase()} +90°
              </button>
            </span>
          ))}
          <button type="button" disabled={busy} onClick={() => mirrorModel("x")}>
            Espelhar X
          </button>
        </div>
        <Hint>Z é "para cima" e a frente do personagem fica em −Y (como no Blender e nos fatiadores).</Hint>
      </Section>

      <button type="button" className="primary wide" onClick={() => setUi({ stage: "dividir" })}>
        Próximo: dividir o modelo →
      </button>
    </div>
  );
}
