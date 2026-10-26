import { useMemo, useRef, useState } from "react";
import type { ConnectorPlan } from "../../core/connectors";
import type { Vec2 } from "../../core/math";
import type { Interface } from "../../core/split";
import { setManualPoints } from "../actions";

/**
 * Editor 2D da face de corte: mostra a seção (no plano do corte) e os encaixes.
 * Arraste para mover · clique duplo para adicionar · clique direito para remover.
 */
export function SectionEditor({ iface, plan, frontColor, backColor }: { iface: Interface; plan?: ConnectorPlan; frontColor: string; backColor: string }) {
  const svg = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<{ index: number; points: Vec2[] } | null>(null);
  const view = useMemo(() => {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const poly of iface.polygons)
      for (const [x, y] of poly) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    const pad = Math.max(maxX - minX, maxY - minY) * 0.08 + 1;
    return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
  }, [iface]);
  const path = useMemo(
    () => iface.polygons.map((p) => `M${p.map(([x, y]) => `${x},${-y}`).join("L")}Z`).join(""),
    [iface],
  );
  const points = drag?.points ?? plan?.points ?? [];
  const r = (plan?.size ?? 4) / 2;

  const toLocal = (ev: { clientX: number; clientY: number }): Vec2 => {
    const el = svg.current!;
    const pt = el.createSVGPoint();
    pt.x = ev.clientX;
    pt.y = ev.clientY;
    const p = pt.matrixTransform(el.getScreenCTM()!.inverse());
    return [p.x, -p.y];
  };

  const commit = (pts: Vec2[]) => setManualPoints(iface.id, pts);

  return (
    <div className="section-editor">
      <svg
        ref={svg}
        viewBox={`${view.x} ${-(view.y + view.h)} ${view.w} ${view.h}`}
        preserveAspectRatio="xMidYMid meet"
        onDoubleClick={(e) => commit([...points, toLocal(e)])}
        onPointerMove={(e) => {
          if (!drag) return;
          const pts = drag.points.slice();
          pts[drag.index] = toLocal(e);
          setDrag({ ...drag, points: pts });
        }}
        onPointerUp={() => {
          if (drag) commit(drag.points);
          setDrag(null);
        }}
        onContextMenu={(e) => e.preventDefault()}
      >
        <defs>
          <pattern id="hatch" width="2" height="2" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="2" stroke={backColor} strokeWidth="0.6" opacity="0.5" />
          </pattern>
        </defs>
        <path d={path} fill={frontColor} fillOpacity={0.28} stroke={frontColor} strokeWidth={view.w / 250} fillRule="evenodd" />
        <path d={path} fill="url(#hatch)" fillRule="evenodd" />
        {points.map((p, i) => (
          <g key={i}>
            {plan?.kind === "square" ? (
              <rect x={p[0] - r} y={-p[1] - r} width={r * 2} height={r * 2} className="pin" />
            ) : (
              <circle cx={p[0]} cy={-p[1]} r={r} className="pin" />
            )}
            <circle
              cx={p[0]}
              cy={-p[1]}
              r={Math.max(r, view.w / 40)}
              className="pin-handle"
              onPointerDown={(e) => {
                e.stopPropagation();
                if (e.button === 2) {
                  commit(points.filter((_, j) => j !== i));
                  return;
                }
                (e.target as Element).setPointerCapture(e.pointerId);
                setDrag({ index: i, points: points.slice() });
              }}
            />
          </g>
        ))}
      </svg>
      <div className="section-legend">
        <span>
          {iface.area.toFixed(0)} mm² · {iface.kind === "plane" ? "corte plano" : `contorno (desvio ${iface.deviation.toFixed(1)} mm)`}
        </span>
        <span>Arraste os pinos · clique duplo adiciona · botão direito remove</span>
      </div>
    </div>
  );
}
