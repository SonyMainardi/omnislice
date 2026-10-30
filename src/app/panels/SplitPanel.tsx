import { useMemo, useState } from "react";
import type { SplitMode } from "../../core/split";
import { colorProvider, componentsProvider, geometricProvider, materialProvider, objectProvider } from "../../segmentation/providers";
import {
  addRegion,
  applyPlaneCut,
  applyRegionSplit,
  autoFitAll,
  cancelPlaneTool,
  commitLabels,
  discardRegions,
  ensureRegionSession,
  flipPlane,
  mergeRegion,
  planeFraction,
  planePosition,
  presetSeparate,
  regionAreas,
  renameRegion,
  runAutoSegmentation,
  setBaseRegion,
  setPlaneNormal,
  setRegionColor,
  startPlaneTool,
  toggleRegionSeparate,
} from "../actions";
import { paintContext, smoothRegionLabels } from "../painting";
import { type Tool, setUi, store, useApp } from "../state";
import { Field, Hint, Section, Segmented, Slider, Toggle } from "../ui";

const TOOLS: { id: Tool; label: string; key: string; hint: string }[] = [
  { id: "orbitar", label: "Navegar", key: "O", hint: "Girar e aproximar a vista (botão esquerdo)" },
  { id: "pincel", label: "Pincel", key: "B", hint: "Pinta a região ativa. Botão direito gira a vista." },
  { id: "borracha", label: "Borracha", key: "E", hint: "Devolve as faces para o corpo principal" },
  {
    id: "inteligente",
    label: "Seleção inteligente",
    key: "S",
    hint: "Clique numa parte (cabeça, braço, perna...): detecta os vincos em volta e pinta a parte inteira",
  },
  { id: "balde", label: "Balde", key: "G", hint: "Preenche até encontrar arestas vivas. Em modelos orgânicos, sem arestas vivas, pinta tudo" },
  { id: "casca", label: "Casca", key: "C", hint: "Seleciona uma casca solta inteira (só separa peças modeladas à parte)" },
  { id: "atributo", label: "Cor/Material", key: "M", hint: "Seleciona faces pela cor, material ou objeto do arquivo" },
];

export function SplitPanel() {
  const parts = useApp((s) => s.doc.parts);
  const model = useApp((s) => s.doc.model);
  const regions = useApp((s) => s.doc.regions);
  const report = useApp((s) => s.doc.splitReport);
  const selected = useApp((s) => s.ui.selectedPartId);
  const tool = useApp((s) => s.ui.tool);
  const busy = useApp((s) => s.ui.busy !== null);
  const seg = useApp((s) => s.ui.segmentation);
  const splitMode = useApp((s) => s.ui.splitMode);
  const activeRegion = useApp((s) => s.ui.activeRegion);
  const brushRadius = useApp((s) => s.ui.brushRadius);
  const frontOnly = useApp((s) => s.ui.frontOnly);
  const fillAngle = useApp((s) => s.ui.fillAngle);
  const attributeKind = useApp((s) => s.ui.attributeKind);
  const colorTolerance = useApp((s) => s.ui.colorTolerance);
  const planeFrame = useApp((s) => s.ui.planeFrame);
  const planeSeparate = useApp((s) => s.ui.planeSeparate);
  const [planeMode, setPlaneMode] = useState<"translate" | "rotate">("translate");

  const part = parts.find((p) => p.id === (regions?.partId ?? selected)) ?? parts[0];
  const attrs = model?.attrs ?? {};
  const providers = useMemo(() => {
    const input = {
      mesh: part?.geometry.mesh ?? { positions: new Float32Array(), indices: new Uint32Array() },
      faceColors: attrs.colors,
      faceMaterials: attrs.materials,
      faceObjects: attrs.objects,
    };
    const list = [geometricProvider];
    if ((part?.stats.components ?? 1) > 1) list.push(componentsProvider);
    if (attrs.colors && colorProvider.available(input)) list.push(colorProvider);
    if (attrs.materials && materialProvider.available(input)) list.push(materialProvider);
    if (attrs.objects && objectProvider.available(input)) list.push(objectProvider);
    return list;
  }, [part, attrs]);
  const areas = useMemo(() => (regions && part ? regionAreas(regions, part) : new Map<number, number>()), [regions, part]);
  if (!part) return null;

  const setTool = (t: Tool) => {
    if (t !== "orbitar" && t !== "plano" && !store.get().doc.regions) ensureRegionSession();
    setUi({ tool: t, planeFrame: t === "plano" ? store.get().ui.planeFrame : null });
  };
  const provider = providers.find((p) => p.id === seg.providerId) ?? providers[0];

  return (
    <div className="panel">
      <div className="target">
        Peça em edição: <strong style={{ color: part.color }}>{part.name}</strong>
        <small>Selecione outra na lista ou clique no modelo (ferramenta Navegar).</small>
      </div>

      {tool === "plano" && planeFrame ? (
        <Section title="Corte por plano">
          <Hint>Arraste as setas para mover e os anéis para girar. Azul: frente do corte; laranja: verso.</Hint>
          <Field label="Orientação">
            <div className="button-row">
              <button type="button" onClick={() => setPlaneNormal([0, 0, 1])}>
                Horizontal
              </button>
              <button type="button" onClick={() => setPlaneNormal([1, 0, 0])}>
                Vertical (X)
              </button>
              <button type="button" onClick={() => setPlaneNormal([0, 1, 0])}>
                Vertical (Y)
              </button>
              <button type="button" onClick={flipPlane}>
                Inverter
              </button>
            </div>
          </Field>
          <Field label="Posição">
            <Slider
              value={Math.round(planeFraction(planeFrame, part) * 1000) / 10}
              min={0}
              max={100}
              step={0.5}
              format={(v) => `${v.toFixed(1)}%`}
              onChange={(v) => planePosition(v / 100)}
            />
          </Field>
          <Field label="Alças">
            <Segmented
              value={planeMode}
              onChange={(m) => {
                setPlaneMode(m);
                (window as unknown as { __viewer?: { setPlaneMode(m: string): void } }).__viewer?.setPlaneMode(m);
              }}
              options={[
                { value: "translate", label: "Mover" },
                { value: "rotate", label: "Girar" },
              ]}
            />
          </Field>
          <Toggle
            label="Separar pedaços soltos"
            checked={planeSeparate}
            onChange={(v) => setUi({ planeSeparate: v })}
            hint="Se o plano cruzar o modelo em vários lugares, cada pedaço vira uma peça"
          />
          <div className="button-row">
            <button type="button" className="primary" disabled={busy} onClick={applyPlaneCut}>
              Cortar
            </button>
            <button type="button" onClick={cancelPlaneTool}>
              Cancelar
            </button>
          </div>
        </Section>
      ) : (
        <>
          <Section title="1. Divisão automática">
            <Field label="Método">
              <select value={provider.id} onChange={(e) => setUi({ segmentation: { ...seg, providerId: e.target.value } })}>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
                {seg.remoteUrl && <option value="remoto">Serviço de IA (remoto)</option>}
              </select>
            </Field>
            <Hint>{seg.providerId === "remoto" ? "Envia a peça para o serviço configurado abaixo." : provider.description}</Hint>
            {provider.id === "geometrica" && (
              <>
                <Field label="Quantidade de partes">
                  <Slider
                    value={seg.sensitivity}
                    min={0}
                    max={1}
                    step={0.05}
                    format={(v) => (v < 0.34 ? "Poucas" : v < 0.67 ? "Equilibrado" : "Muitas")}
                    onChange={(v) => setUi({ segmentation: { ...seg, sensitivity: v } })}
                  />
                </Field>
                <Field label="Máximo de partes">
                  <Slider value={seg.maxSegments} min={2} max={24} onChange={(v) => setUi({ segmentation: { ...seg, maxSegments: v } })} />
                </Field>
              </>
            )}
            <button type="button" className="primary" disabled={busy} onClick={runAutoSegmentation}>
              Analisar e sugerir partes
            </button>
            <details className="sub">
              <summary>Serviço de IA externo (opcional)</summary>
              <Hint>
                O módulo de divisão automática é independente: um serviço de segmentação por IA pode ser ligado aqui. Ele recebe a peça
                em STL e devolve um rótulo por triângulo. Nada é enviado sem uma URL configurada.
              </Hint>
              <input
                type="url"
                placeholder="https://seu-servico/segmentar"
                value={seg.remoteUrl}
                onChange={(e) => setUi({ segmentation: { ...seg, remoteUrl: e.target.value.trim() } })}
              />
            </details>
          </Section>

          <Section title="2. Regiões" aside={regions ? <span className="badge">{regions.regions.length}</span> : undefined}>
            {!regions ? (
              <>
                <Hint>Use a análise automática acima ou pinte regiões manualmente com as ferramentas abaixo.</Hint>
                <button type="button" onClick={() => ensureRegionSession()}>
                  Começar a pintar regiões
                </button>
              </>
            ) : (
              <>
                <div className="button-row presets">
                  <span>Separar:</span>
                  <button type="button" onClick={() => presetSeparate("cabeca")} title="Somente cabeça (e pescoço)">
                    só a cabeça
                  </button>
                  <button type="button" onClick={() => presetSeparate("membros")}>
                    cabeça e membros
                  </button>
                  <button type="button" onClick={() => presetSeparate("tudo")}>
                    tudo
                  </button>
                  <button type="button" onClick={() => presetSeparate("nada")}>
                    nada
                  </button>
                </div>
                <ul className="regions">
                  {regions.regions.map((r) => {
                    const isBase = r.id === regions.baseId;
                    return (
                      <li key={r.id} className={`${r.id === activeRegion ? "active" : ""} ${isBase ? "base" : ""}`}>
                        <label className="swatch" style={{ background: r.color }} title="Trocar a cor">
                          <input type="color" value={r.color} onChange={(e) => setRegionColor(r.id, e.target.value)} />
                        </label>
                        <input className="region-name" value={r.name} onChange={(e) => renameRegion(r.id, e.target.value)} />
                        <span className="area">{((areas.get(r.id) ?? 0) * 100).toFixed(1)}%</span>
                        {isBase ? (
                          <span className="pill" title="As regiões não separadas ficam unidas a esta">
                            principal
                          </span>
                        ) : (
                          <label className="sep" title="Vira uma peça separada">
                            <input type="checkbox" checked={r.separate} onChange={() => toggleRegionSeparate(r.id)} />
                            separar
                          </label>
                        )}
                        <button
                          type="button"
                          className={`icon ${r.id === activeRegion ? "on" : ""}`}
                          title="Pintar com esta região"
                          onClick={() => {
                            setUi({ activeRegion: r.id });
                            if (tool === "orbitar") setTool("pincel");
                          }}
                        >
                          ✎
                        </button>
                        <select
                          className="icon-select"
                          value=""
                          title="Mais ações"
                          onChange={(e) => {
                            const v = e.target.value;
                            if (v === "base") setBaseRegion(r.id);
                            else if (v.startsWith("merge:")) mergeRegion(r.id, Number(v.slice(6)));
                          }}
                        >
                          <option value="">⋯</option>
                          {!isBase && <option value="base">Tornar principal</option>}
                          {!isBase &&
                            regions.regions
                              .filter((o) => o.id !== r.id)
                              .map((o) => (
                                <option key={o.id} value={`merge:${o.id}`}>
                                  Juntar com {o.name}
                                </option>
                              ))}
                        </select>
                      </li>
                    );
                  })}
                </ul>
                <div className="button-row">
                  <button type="button" onClick={() => addRegion()}>
                    + Nova região
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const s = store.get().doc.regions;
                      if (s) commitLabels(smoothRegionLabels(paintContext(part.geometry.mesh), s.labels));
                    }}
                    title="Remove ilhas minúsculas e serrilhados das bordas"
                  >
                    Suavizar bordas
                  </button>
                  <button type="button" className="danger" onClick={discardRegions}>
                    Descartar
                  </button>
                </div>
                {regions.notes.map((n) => (
                  <Hint key={n}>{n}</Hint>
                ))}
              </>
            )}
          </Section>

          <Section title="Ferramentas de seleção">
            <div className="tool-grid">
              {TOOLS.map((t) => (
                <button key={t.id} type="button" className={tool === t.id ? "on" : ""} title={`${t.hint} (${t.key})`} onClick={() => setTool(t.id)}>
                  {t.label}
                  <kbd>{t.key}</kbd>
                </button>
              ))}
            </div>
            {(tool === "pincel" || tool === "borracha") && (
              <>
                <Field label="Raio do pincel">
                  <Slider value={brushRadius} min={0.5} max={40} step={0.5} format={(v) => `${v} mm`} onChange={(v) => setUi({ brushRadius: v })} />
                </Field>
                <Toggle label="Só faces visíveis" checked={frontOnly} onChange={(v) => setUi({ frontOnly: v })} />
              </>
            )}
            {tool === "inteligente" && (
              <Hint>
                Clique na parte que quer separar. A seleção para nos vincos onde ela encontra o resto do modelo; ajuste o resultado
                com o pincel ou a borracha.
              </Hint>
            )}
            {tool === "balde" && (
              <Field label="Parar em arestas acima de">
                <Slider value={fillAngle} min={5} max={90} format={(v) => `${v}°`} onChange={(v) => setUi({ fillAngle: v })} />
              </Field>
            )}
            {tool === "atributo" && (
              <>
                <Segmented
                  value={attributeKind}
                  onChange={(v) => setUi({ attributeKind: v })}
                  options={[
                    { value: "cor", label: "Cor" },
                    { value: "material", label: "Material" },
                    { value: "objeto", label: "Objeto" },
                  ]}
                />
                {attributeKind === "cor" && (
                  <Field label="Tolerância de cor">
                    <Slider value={colorTolerance} min={0} max={120} onChange={(v) => setUi({ colorTolerance: v })} />
                  </Field>
                )}
                {!attrs.colors && !attrs.materials && !attrs.objects && (
                  <Hint kind="aviso">Este arquivo não tem cores, materiais nem objetos (STL simples).</Hint>
                )}
              </>
            )}
            {tool !== "orbitar" && <Hint>Botão esquerdo pinta · direito gira · roda aproxima · Ctrl+Z desfaz a pincelada.</Hint>}
          </Section>

          <Section title="3. Gerar peças">
            <Field label="Como cortar nas junções">
              <select value={splitMode} onChange={(e) => setUi({ splitMode: e.target.value as SplitMode })}>
                <option value="auto">Automático: plano na junção, contorno quando necessário</option>
                <option value="plane">Sempre plano (face de corte plana)</option>
                <option value="seam">Seguir o contorno pintado</option>
              </select>
            </Field>
            <Hint>
              Cortes planos geram faces retas, ideais para pinos e para apoiar na mesa. Se o plano atravessar outra parte do modelo,
              o modo automático segue o contorno pintado.
            </Hint>
            <button type="button" className="primary wide" disabled={busy || !regions} onClick={() => applyRegionSplit(splitMode)}>
              Gerar peças
            </button>
            {report && report.length > 0 && (
              <ul className="report">
                {report.map((r, i) => (
                  <li key={i} className={r.method === "falhou" ? "bad" : ""}>
                    <span className="pill">{r.method}</span>
                    {r.method === "plano" && <small>{(r.purity * 100).toFixed(1)}% de acerto</small>}
                    {r.message && <small>{r.message}</small>}
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="Corte por plano e ajustes">
            <div className="button-row">
              <button type="button" disabled={busy} onClick={startPlaneTool}>
                Cortar com plano
              </button>
              <button type="button" disabled={busy} onClick={autoFitAll} title="Divide as peças maiores que a mesa escolhida na etapa Impressão">
                Dividir para caber na mesa
              </button>
            </div>
          </Section>

          <button type="button" className="primary wide" onClick={() => setUi({ stage: "encaixes", tool: "orbitar" })}>
            Próximo: encaixes →
          </button>
        </>
      )}
    </div>
  );
}
