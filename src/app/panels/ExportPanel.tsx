import { useEffect, useState } from "react";
import { baseName, slugify, uniqueSlugs } from "../../core/io/names";
import { type ExportOptions, buildFinal, exportProject } from "../actions";
import { store, useApp } from "../state";
import { Hint, Section, Toggle } from "../ui";

export function ExportPanel() {
  const d = useApp((s) => s.doc);
  const final = useApp((s) => s.ui.final);
  const busy = useApp((s) => s.ui.busy !== null);
  const [opts, setOpts] = useState<ExportOptions>({
    stl: true,
    threeMF: true,
    obj: false,
    assembled: true,
    printReady: true,
    includeDowels: true,
  });
  useEffect(() => {
    if (!store.get().ui.final && !store.get().ui.busy && d.parts.length) buildFinal();
  }, [d.parts, d.interfaces, d.connectors, d.print]);
  const set = (p: Partial<ExportOptions>) => setOpts((o) => ({ ...o, ...p }));
  const title = slugify(baseName(d.model?.fileName ?? "projeto"));
  const names = uniqueSlugs([...d.parts.map((p) => p.name), ...(opts.includeDowels ? (final?.extras ?? []).map((e) => e.name) : [])]);
  const plates = final?.layout?.plates ?? 1;
  const files: string[] = [];
  for (const folder of [opts.assembled ? "montada" : null, opts.printReady ? "impressao" : null]) {
    if (!folder) continue;
    if (opts.stl) for (const n of names) files.push(`${folder}/${n}.stl`);
    if (opts.threeMF) {
      if (folder === "impressao" && plates > 1)
        for (let i = 1; i <= plates; i++) files.push(`${folder}/${title}_impressao_mesa_${i}.3mf`);
      else files.push(`${folder}/${title}_${folder === "montada" ? "montado" : "impressao"}.3mf`);
    }
    if (opts.obj) files.push(`${folder}/${title}_${folder === "montada" ? "montado" : "impressao"}.obj`);
  }
  files.push("LEIAME.txt");
  const problems = final?.checks.filter((c) => !c.ok).length ?? 0;
  // Cortes sem nenhum encaixe aplicado (escolheram "sem encaixe" ou nada coube).
  const withoutConnector = final ? Math.max(0, d.interfaces.length - final.checks.length) : 0;

  return (
    <div className="panel">
      <Section title="Formatos">
        <Toggle label="STL (um arquivo por peça)" checked={opts.stl} onChange={(v) => set({ stl: v })} />
        <Toggle label="3MF (projeto com cada peça como objeto)" checked={opts.threeMF} onChange={(v) => set({ threeMF: v })} />
        <Toggle label="OBJ (todas as peças, com nomes)" checked={opts.obj} onChange={(v) => set({ obj: v })} />
      </Section>
      <Section title="Versões">
        <Toggle label="Montada (posição original)" checked={opts.assembled} onChange={(v) => set({ assembled: v })} />
        <Toggle label="Organizada para impressão (por mesa)" checked={opts.printReady} onChange={(v) => set({ printReady: v })} />
        <Toggle label="Incluir cavilhas avulsas" checked={opts.includeDowels} onChange={(v) => set({ includeDowels: v })} />
      </Section>
      <Section title="Arquivos do ZIP" aside={<span className="badge">{files.length}</span>}>
        <ul className="file-list">
          {files.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      </Section>
      {problems > 0 && <Hint kind="aviso">{problems} encaixe(s) com problema. Revise na etapa Encaixes antes de imprimir.</Hint>}
      {withoutConnector > 0 && (
        <Hint kind="aviso">
          {withoutConnector} corte(s) vão sair sem pino nem furo. Se não foi de propósito, veja os avisos na etapa Encaixes.
        </Hint>
      )}
      {!final && <Hint>Gerando as peças finais com encaixes…</Hint>}
      <button
        type="button"
        className="primary wide"
        disabled={busy || (!opts.assembled && !opts.printReady)}
        onClick={() => exportProject(opts)}
      >
        Baixar ZIP
      </button>
      <Hint>Os arquivos são gerados no seu computador; nada é enviado para servidores.</Hint>
    </div>
  );
}
