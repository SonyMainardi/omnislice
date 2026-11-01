import { useEffect } from "react";
import {
  type ConnectorKind,
  type ConnectorSettings,
  type FitKind,
  autoClearance,
  connectorKindNames,
  materialNames,
} from "../../core/connectors";
import { buildFinal, computePlans, effectiveSettings, setManualPoints, updateConnectorDefaults, updateConnectorOverride } from "../actions";
import { setUi, store, useApp } from "../state";
import { AutoNumber, Field, Hint, Section, Segmented, Slider, Toggle, fmt } from "../ui";
import { SectionEditor } from "./SectionEditor";

function SettingsEditor({ value, onChange, autoSize, autoLength }: { value: ConnectorSettings; onChange: (p: Partial<ConnectorSettings>) => void; autoSize?: number; autoLength?: number }) {
  const isMagnet = value.kind === "magnet";
  return (
    <>
      <Field label="Tipo">
        <select value={value.kind} onChange={(e) => onChange({ kind: e.target.value as ConnectorKind })}>
          {(Object.keys(connectorKindNames) as ConnectorKind[]).map((k) => (
            <option key={k} value={k}>
              {connectorKindNames[k]}
            </option>
          ))}
        </select>
      </Field>
      {value.kind !== "none" && (
        <>
          <Field label={isMagnet ? "Diâmetro do ímã" : value.kind === "square" ? "Largura" : "Diâmetro"}>
            <AutoNumber value={value.size} autoValue={autoSize} min={1} max={40} suffix="mm" onChange={(v) => onChange({ size: v })} />
          </Field>
          <Field label={isMagnet ? "Espessura do ímã" : value.kind === "dowel" ? "Comprimento da cavilha" : "Comprimento do pino"}>
            <AutoNumber value={value.length} autoValue={autoLength} min={1} max={60} suffix="mm" onChange={(v) => onChange({ length: v })} />
          </Field>
          <Field label="Quantidade por corte">
            <Slider value={value.count} min={1} max={8} onChange={(v) => onChange({ count: v })} />
          </Field>
          <Field label="Ajuste" hint="Justo: encaixe sob pressão. Folgado: para colar.">
            <Segmented
              value={value.fit}
              onChange={(v: FitKind) => onChange({ fit: v })}
              options={[
                { value: "justo", label: "Justo" },
                { value: "normal", label: "Normal" },
                { value: "folgado", label: "Folgado" },
              ]}
            />
          </Field>
          <Field label="Folga radial" hint="Espaço entre o pino e o furo, por lado">
            <AutoNumber
              value={value.clearance}
              autoValue={autoClearance(value, value.size ?? autoSize ?? 5)}
              min={0}
              max={1.5}
              suffix="mm"
              onChange={(v) => onChange({ clearance: v })}
            />
          </Field>
          {!isMagnet && value.kind !== "dowel" && (
            <Field label="Pino fica em">
              <Segmented
                value={value.maleSide}
                onChange={(v) => onChange({ maleSide: v })}
                options={[
                  { value: "auto", label: "Auto", hint: "Furo na peça com mais material" },
                  { value: "front", label: "Frente" },
                  { value: "back", label: "Verso" },
                ]}
              />
            </Field>
          )}
          <Field label="Parede mínima ao redor" hint="Evita encaixes perto das bordas">
            <Slider value={value.edgeMargin} min={0.8} max={5} step={0.1} format={(v) => `${fmt(v)} mm`} onChange={(v) => onChange({ edgeMargin: v })} />
          </Field>
          {value.kind !== "magnet" && <Toggle label="Chanfro na ponta" checked={value.chamfer} onChange={(v) => onChange({ chamfer: v })} />}
        </>
      )}
    </>
  );
}

export function ConnectorPanel() {
  const d = useApp((s) => s.doc);
  const plans = useApp((s) => s.ui.plans);
  const stale = useApp((s) => s.ui.plansStale);
  const busy = useApp((s) => s.ui.busy !== null);
  const selectedId = useApp((s) => s.ui.selectedInterfaceId);
  const showConnectors = useApp((s) => s.ui.showConnectors);
  const final = useApp((s) => s.ui.final);

  useEffect(() => {
    if (stale && !store.get().ui.busy) computePlans().catch(() => undefined);
  }, [stale, d.interfaces, d.connectors]);
  useEffect(() => {
    if (store.get().ui.explode < 0.3) setUi({ explode: 0.45 });
  }, []);

  const names = new Map(d.parts.map((p) => [p.id, p]));
  const selected = d.interfaces.find((i) => i.id === selectedId) ?? null;
  const selectedPlan = plans.find((p) => p.interfaceId === selectedId);
  const override = selected ? d.connectors.overrides[selected.id] : undefined;
  const firstPlan = plans.find((p) => p.points.length);

  if (!d.interfaces.length)
    return (
      <div className="panel">
        <Hint>Ainda não há cortes. Divida o modelo na etapa anterior para criar faces de encaixe.</Hint>
        <button type="button" onClick={() => setUi({ stage: "dividir" })}>
          ← Voltar para Dividir
        </button>
      </div>
    );

  return (
    <div className="panel">
      <Section title="Padrão para todos os cortes">
        <SettingsEditor
          value={d.connectors.defaults}
          onChange={(p) => updateConnectorDefaults(p)}
          autoSize={firstPlan?.size}
          autoLength={firstPlan?.length}
        />
        <Hint>
          Vale para todos os cortes; onde um tamanho escolhido não couber, o encaixe é reduzido só naquele corte. Para mudar um corte só,
          clique nele na lista abaixo e ative "Configuração própria para este corte".
        </Hint>
        <Hint>
          Material: {materialNames[d.connectors.defaults.material]} (mude na etapa Impressão). As folgas automáticas são pontos de
          partida: imprima um teste de encaixe.
        </Hint>
      </Section>

      <Section title="Cortes" aside={<span className="badge">{d.interfaces.length}</span>}>
        <Toggle label="Mostrar encaixes no modelo" checked={showConnectors} onChange={(v) => setUi({ showConnectors: v })} />
        <ul className="interfaces">
          {d.interfaces.map((iface) => {
            const plan = plans.find((p) => p.interfaceId === iface.id);
            const check = final?.checks.find((c) => c.interfaceId === iface.id);
            const a = names.get(iface.front);
            const b = names.get(iface.back);
            return (
              <li
                key={iface.id}
                className={iface.id === selectedId ? "selected" : ""}
                onClick={() => setUi({ selectedInterfaceId: iface.id === selectedId ? null : iface.id })}
              >
                <div className="iface-title">
                  <span style={{ color: a?.color }}>{a?.name}</span> ↔ <span style={{ color: b?.color }}>{b?.name}</span>
                </div>
                <small>
                  {fmt(iface.area, 0)} mm² · {iface.kind === "plane" ? "plano" : "contorno"}
                  {plan && plan.points.length > 0 && ` · ${plan.points.length}× Ø${plan.size} × ${plan.length} mm`}
                  {plan && plan.points.length === 0 && " · sem encaixe"}
                  {d.connectors.overrides[iface.id]?.settings && " · ajuste próprio"}
                </small>
                {plan?.warnings.map((w) => (
                  <small key={w} className="warn">
                    ⚠ {w}
                  </small>
                ))}
                {check && (
                  <small className={check.ok ? "ok" : "warn"}>
                    {check.ok ? "✓ encaixe validado, sem colisão" : check.brokeThrough ? "✖ um furo atravessou a parede" : `✖ colisão de ${fmt(check.collision, 2)} mm³`}
                  </small>
                )}
              </li>
            );
          })}
        </ul>
        {stale && <Hint>Calculando…</Hint>}
      </Section>

      {selected && (
        <Section title="Corte selecionado">
          <SectionEditor
            iface={selected}
            plan={selectedPlan}
            frontColor={names.get(selected.front)?.color ?? "#4f8cff"}
            backColor={names.get(selected.back)?.color ?? "#ff7a45"}
          />
          <div className="button-row">
            <button type="button" disabled={!override?.points} onClick={() => setManualPoints(selected.id, undefined)}>
              Posição automática
            </button>
          </div>
          <Toggle
            label="Configuração própria para este corte"
            checked={!!override?.settings}
            onChange={(v) => updateConnectorOverride(selected.id, v ? {} : null)}
          />
          {override?.settings && (
            <SettingsEditor
              value={effectiveSettings(d, selected.id)}
              onChange={(p) => updateConnectorOverride(selected.id, p)}
              autoSize={selectedPlan?.size}
              autoLength={selectedPlan?.length}
            />
          )}
        </Section>
      )}

      <Section title="Validação">
        <Hint>Aplica pinos e furos de verdade e confere se as peças montadas não colidem e se nenhum furo vaza a parede.</Hint>
        <button type="button" className="primary" disabled={busy} onClick={() => buildFinal()}>
          Validar encaixes
        </button>
        {final && (
          <Hint kind={final.checks.every((c) => c.ok) && final.checks.length === d.interfaces.length ? "sucesso" : "aviso"}>
            {final.checks.filter((c) => c.ok).length} de {d.interfaces.length} cortes com encaixe validado
            {final.extras.length ? ` · ${final.extras.length} cavilha(s) avulsa(s)` : ""}.
            {d.interfaces.length > final.checks.length &&
              ` ${d.interfaces.length - final.checks.length} corte(s) ficaram sem encaixe: veja os avisos na lista acima.`}
          </Hint>
        )}
      </Section>

      <button type="button" className="primary wide" onClick={() => setUi({ stage: "impressao" })}>
        Próximo: preparar a impressão →
      </button>
    </div>
  );
}
