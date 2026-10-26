import { type ReactNode, useEffect, useState } from "react";

export function Section(props: { title: string; children: ReactNode; aside?: ReactNode; open?: boolean; id?: string }) {
  return (
    <details className="section" open={props.open ?? true} id={props.id}>
      <summary>
        <span>{props.title}</span>
        {props.aside}
      </summary>
      <div className="section-body">{props.children}</div>
    </details>
  );
}

export function Field(props: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">
        {props.label}
        {props.hint && (
          <span className="hint-dot" title={props.hint}>
            ?
          </span>
        )}
      </span>
      {props.children}
    </label>
  );
}

export function Slider(props: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
  onCommit?: (v: number) => void;
}) {
  return (
    <div className="slider">
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
        onPointerUp={(e) => props.onCommit?.(Number((e.target as HTMLInputElement).value))}
        onKeyUp={(e) => props.onCommit?.(Number((e.target as HTMLInputElement).value))}
      />
      <output>{props.format ? props.format(props.value) : props.value}</output>
    </div>
  );
}

/** Número com confirmação ao sair do campo ou apertar Enter. */
export function NumberInput(props: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  disabled?: boolean;
}) {
  const [text, setText] = useState(String(props.value));
  useEffect(() => setText(String(Number(props.value.toFixed(3)))), [props.value]);
  const commit = () => {
    const v = Number(text.replace(",", "."));
    if (!Number.isFinite(v)) return setText(String(props.value));
    const clamped = Math.min(props.max ?? Infinity, Math.max(props.min ?? -Infinity, v));
    if (clamped !== props.value) props.onChange(clamped);
    else setText(String(props.value));
  };
  return (
    <span className="number-input">
      <input
        type="text"
        inputMode="decimal"
        value={text}
        disabled={props.disabled}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && commit()}
      />
      {props.suffix && <span className="suffix">{props.suffix}</span>}
    </span>
  );
}

/** Valor automático ou manual (null = automático). */
export function AutoNumber(props: {
  value: number | null;
  autoValue?: number;
  onChange: (v: number | null) => void;
  suffix?: string;
  min?: number;
  max?: number;
}) {
  const auto = props.value === null;
  return (
    <span className="auto-number">
      <button
        type="button"
        className={`chip ${auto ? "chip-on" : ""}`}
        onClick={() => props.onChange(auto ? (props.autoValue ?? props.min ?? 1) : null)}
        title="Automático: calculado pela seção do corte e espessura das peças"
      >
        auto
      </button>
      <NumberInput
        value={props.value ?? props.autoValue ?? 0}
        disabled={auto}
        onChange={(v) => props.onChange(v)}
        suffix={props.suffix}
        min={props.min}
        max={props.max}
      />
    </span>
  );
}

export function Toggle(props: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="toggle" title={props.hint}>
      <input type="checkbox" checked={props.checked} onChange={(e) => props.onChange(e.target.checked)} />
      <span className="toggle-track" />
      <span>{props.label}</span>
    </label>
  );
}

export function Segmented<T extends string>(props: {
  value: T;
  options: { value: T; label: string; hint?: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="segmented" role="radiogroup">
      {props.options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === props.value}
          className={o.value === props.value ? "on" : ""}
          title={o.hint}
          onClick={() => props.onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Hint(props: { children: ReactNode; kind?: "info" | "aviso" | "erro" | "sucesso" }) {
  return <p className={`hint hint-${props.kind ?? "info"}`}>{props.children}</p>;
}

export function Stat(props: { label: string; value: ReactNode }) {
  return (
    <div className="stat">
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}

export const fmt = (v: number, digits = 1) =>
  v.toLocaleString("pt-BR", { minimumFractionDigits: digits, maximumFractionDigits: digits });

export const fmtSize = (s: number[]) => s.map((v) => fmt(v, 1)).join(" × ") + " mm";
