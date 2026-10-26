import { useEffect, useRef, useState } from "react";
import type { Mat4, PlaneFrame } from "../core/math";
import { Viewer, type ViewerPart } from "../viewer/Viewer";
import { ensureRegionSession, commitLabels, partAttributes, selectPart } from "./actions";
import { attributeFaces, brushFaces, fillFaces, paintContext, shellFaces } from "./painting";
import { type AppState, setUi, store, useApp } from "./state";

const PAINT_TOOLS = new Set(["pincel", "borracha", "balde", "casca", "atributo"]);

function regionColorArray(s: AppState["doc"]["regions"]): string[] {
  if (!s) return [];
  const max = Math.max(...s.regions.map((r) => r.id));
  const out = new Array<string>(max + 1).fill("#888888");
  for (const r of s.regions) out[r.id] = r.color;
  return out;
}

export function ViewerPane() {
  const host = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const lastPlaneFromViewer = useRef<PlaneFrame | null>(null);
  const stroke = useRef<{ partId: string; labels: Uint16Array; changed: boolean } | null>(null);

  const parts = useApp((s) => s.doc.parts);
  const regions = useApp((s) => s.doc.regions);
  const stage = useApp((s) => s.ui.stage);
  const tool = useApp((s) => s.ui.tool);
  const brushRadius = useApp((s) => s.ui.brushRadius);
  const selected = useApp((s) => s.ui.selectedPartId);
  const explode = useApp((s) => s.ui.explode);
  const planeFrame = useApp((s) => s.ui.planeFrame);
  const plans = useApp((s) => s.ui.plans);
  const interfaces = useApp((s) => s.doc.interfaces);
  const selectedInterface = useApp((s) => s.ui.selectedInterfaceId);
  const showConnectors = useApp((s) => s.ui.showConnectors);
  const final = useApp((s) => s.ui.final);
  const layoutMode = useApp((s) => s.ui.layoutMode);
  const bed = useApp((s) => s.doc.print.bed);
  const wireframe = useApp((s) => s.ui.wireframe);
  const modelMesh = useApp((s) => s.doc.model?.mesh ?? null);

  useEffect(() => {
    if (!host.current) return;
    const v = new Viewer(host.current, {
      onPointer: (phase, hit) => handlePointer(phase, hit),
      onPlaneChange: (frameWorld) => {
        const partId = store.get().ui.selectedPartId;
        if (!partId) return;
        const frame = viewerRef.current!.toPartFrame(frameWorld, partId);
        lastPlaneFromViewer.current = frame;
        setUi({ planeFrame: frame });
      },
      onPartClick: (id) => {
        if (id) selectPart(id);
      },
    });
    viewerRef.current = v;
    setViewer(v);
    (window as unknown as { __viewer?: Viewer }).__viewer = v;
    return () => {
      v.dispose();
      viewerRef.current = null;
    };
  }, []);

  // Peças exibidas: as finais (com encaixes) nas etapas de impressão/exportação, quando calculadas.
  const showFinal = (stage === "impressao" || stage === "exportar") && final !== null;
  useEffect(() => {
    if (!viewer) return;
    let list: ViewerPart[];
    if (showFinal && final) {
      const byId = new Map(parts.map((p) => [p.id, p]));
      list = [
        ...final.parts.map((fp) => {
          const p = byId.get(fp.id);
          return { id: fp.id, color: p?.color ?? "#999", visible: p?.visible ?? true, geometry: fp.geometry };
        }),
        ...final.extras.map((e) => ({ id: e.id, color: "#ffd166", visible: true, geometry: e.geometry })),
      ];
    } else list = parts.map((p) => ({ id: p.id, color: p.color, visible: p.visible, geometry: p.geometry }));
    viewer.setParts(list);
  }, [viewer, parts, final, showFinal]);

  useEffect(() => {
    viewer?.fit("iso");
  }, [viewer, modelMesh]);

  useEffect(() => viewer?.setSelected(selected), [viewer, selected, parts]);
  useEffect(() => viewer?.setWireframe(wireframe), [viewer, wireframe, parts]);
  useEffect(() => viewer?.setBed(bed), [viewer, bed]);

  // Pintura de regiões na etapa Dividir.
  useEffect(() => {
    if (!viewer) return;
    if (stage === "dividir" && regions) viewer.setRegionColors(regions.partId, regions.labels, regionColorArray(regions));
    else viewer.setRegionColors(null, null, []);
  }, [viewer, regions, stage, parts]);

  // Foco na peça em edição (pintura ou plano).
  useEffect(() => {
    if (!viewer) return;
    const focus = stage === "dividir" && (regions || tool === "plano") ? (regions?.partId ?? selected) : null;
    viewer.setDimmed(focus ? new Set([focus]) : null);
    viewer.setPaintTarget(regions?.partId ?? selected);
  }, [viewer, stage, regions, tool, selected, parts]);

  useEffect(() => {
    viewer?.setTool(stage === "dividir" ? tool : "orbitar", brushRadius);
  }, [viewer, tool, brushRadius, stage]);

  useEffect(() => {
    if (!viewer) return;
    const layoutActive = showFinal && layoutMode === "mesa" && final?.layout;
    viewer.setExplode(layoutActive ? 0 : explode);
  }, [viewer, explode, showFinal, layoutMode, final]);

  useEffect(() => {
    if (!viewer) return;
    if (showFinal && layoutMode === "mesa" && final?.layout) {
      const matrices = new Map<string, Mat4>();
      const gap = 30;
      for (const p of final.layout.placements) {
        const m = p.matrix.slice() as Mat4;
        m[12] += p.plate * (bed[0] + gap);
        matrices.set(p.id, m);
      }
      viewer.setLayout({ matrices, plates: final.layout.plates, bed });
      viewer.fit("iso");
    } else viewer.setLayout(null);
  }, [viewer, showFinal, layoutMode, final, bed]);

  // Plano de corte.
  useEffect(() => {
    if (!viewer) return;
    if (stage === "dividir" && tool === "plano" && planeFrame && selected) {
      if (planeFrame !== lastPlaneFromViewer.current) viewer.setPlane(planeFrame, selected);
    } else viewer.setPlane(null, null);
  }, [viewer, stage, tool, planeFrame, selected, explode]);

  // Encaixes.
  useEffect(() => {
    if (!viewer) return;
    if (stage === "encaixes" && showConnectors) {
      const ifaceById = new Map(interfaces.map((i) => [i.id, i]));
      viewer.setConnectorPreview(
        plans
          .filter((p) => ifaceById.has(p.interfaceId))
          .map((plan) => ({ plan, front: ifaceById.get(plan.interfaceId)!.front, back: ifaceById.get(plan.interfaceId)!.back })),
        selectedInterface,
      );
    } else viewer.setConnectorPreview([], null);
    const iface = interfaces.find((i) => i.id === selectedInterface);
    viewer.setHighlightCut(stage === "encaixes" && iface ? iface.cutId : null);
  }, [viewer, stage, plans, interfaces, selectedInterface, showConnectors, parts]);

  return (
    <div className="viewer-host" ref={host}>
      <ViewControls viewer={viewer} />
    </div>
  );

  function handlePointer(phase: "down" | "move" | "up", hit: ReturnType<Viewer["pick"]>) {
    const s = store.get();
    const v = viewerRef.current;
    if (!v || s.ui.stage !== "dividir" || !PAINT_TOOLS.has(s.ui.tool)) return;
    if (phase === "up") {
      if (stroke.current?.changed) commitLabels(stroke.current.labels);
      stroke.current = null;
      return;
    }
    if (phase === "down") {
      const session = ensureRegionSession();
      if (!session) return;
      stroke.current = { partId: session.partId, labels: session.labels.slice(), changed: false };
    }
    const st = stroke.current;
    const session = store.get().doc.regions;
    if (!st || !hit || !session || hit.partId !== st.partId) return;
    const part = s.doc.parts.find((p) => p.id === st.partId);
    if (!part) return;
    const ctx = paintContext(part.geometry.mesh);
    const ui = store.get().ui;
    const label = ui.tool === "borracha" ? session.baseId : ui.activeRegion;
    let faces: number[] = [];
    switch (ui.tool) {
      case "pincel":
      case "borracha":
        faces = brushFaces(ctx, hit.face, hit.point, ui.brushRadius, ui.frontOnly ? hit.viewDir : undefined);
        break;
      case "balde":
        if (phase === "down") faces = fillFaces(ctx, hit.face, st.labels, ui.fillAngle);
        break;
      case "casca":
        if (phase === "down") faces = shellFaces(ctx, hit.face);
        break;
      case "atributo":
        if (phase === "down" && s.doc.model)
          faces = attributeFaces(part.geometry.src, partAttributes(part, s.doc.model.attrs), ui.attributeKind, hit.face, ui.colorTolerance);
        break;
    }
    if (!faces.length) return;
    let changed = false;
    for (const f of faces)
      if (st.labels[f] !== label) {
        st.labels[f] = label;
        changed = true;
      }
    if (!changed) return;
    st.changed = true;
    v.setRegionColors(st.partId, st.labels, regionColorArray(session), faces);
  }
}

function ViewControls({ viewer }: { viewer: Viewer | null }) {
  const explode = useApp((s) => s.ui.explode);
  const hasParts = useApp((s) => s.doc.parts.length > 1);
  const wireframe = useApp((s) => s.ui.wireframe);
  return (
    <div className="view-controls">
      <div className="view-buttons">
        {(["iso", "frente", "topo", "lado"] as const).map((v) => (
          <button key={v} type="button" onClick={() => viewer?.fit(v)} title={`Vista ${v}`}>
            {v === "iso" ? "3D" : v[0].toUpperCase() + v.slice(1)}
          </button>
        ))}
        <button type="button" className={wireframe ? "on" : ""} onClick={() => setUi({ wireframe: !wireframe })} title="Mostrar a malha (arestas)">
          Malha
        </button>
      </div>
      {hasParts && (
        <label className="explode" title="Afasta as peças para ver as faces de corte">
          <span>Explodir</span>
          <input type="range" min={0} max={1} step={0.01} value={explode} onChange={(e) => setUi({ explode: Number(e.target.value) })} />
        </label>
      )}
    </div>
  );
}
