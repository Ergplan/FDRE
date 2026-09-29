import React, { useRef, useState } from "react";
import { Lock, Unlock, Upload } from "lucide-react";
import * as E from "./engine";

export const HOUR_LABELS = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, "0"));

// ---------------------------------------------------------------- formatting

export const nf = (v, d = 0) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? "–" : new Intl.NumberFormat("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d }).format(Number(v)));
export const pf = (v, d = 1) => (Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : "–");

export function downloadText(name, text, type = "text/csv") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------- lockable inputs

export function LockButton({ locked, onToggle, title }) {
  return (
    <button
      type="button"
      className={`lock-btn ${locked ? "on" : ""}`}
      onClick={onToggle}
      title={title || (locked ? "Locked: click to unlock" : "Unlocked: click to lock")}
      aria-pressed={locked}
    >
      {locked ? <Lock size={12} /> : <Unlock size={12} />}
    </button>
  );
}

export function NumberInput({ value, onCommit, disabled, step = "any", scale = 1, digits = 4, min, max }) {
  const [draft, setDraft] = useState(null);
  const shown = Number.isFinite(value) ? String(Number((value * scale).toFixed(digits))) : "";
  return (
    <input
      type="number"
      step={step}
      value={draft ?? shown}
      disabled={disabled}
      onChange={(e) => {
        setDraft(e.target.value);
        const n = parseFloat(e.target.value);
        if (Number.isFinite(n)) {
          let v = n;
          if (min !== undefined) v = Math.max(min, v);
          if (max !== undefined) v = Math.min(max, v);
          onCommit(v / scale);
        }
      }}
      onBlur={() => setDraft(null)}
    />
  );
}

/** Label + number input + lock toggle. Locked fields cannot be edited. */
export function Field({ label, value, onChange, locked, onLock, unit, pct = false, step, min, max, hint, disabled, digits, lockDisables = true }) {
  return (
    <div className={`rtc-field ${locked ? "is-locked" : ""}`}>
      <div className="rtc-field-top">
        <span>{label}</span>
        {onLock && <LockButton locked={locked} onToggle={onLock} />}
      </div>
      <div className="rtc-field-input">
        <NumberInput value={value} onCommit={onChange} disabled={disabled || (locked && lockDisables)} step={step} scale={pct ? 100 : 1} digits={digits ?? 4} min={min} max={max} />
        {(unit || pct) && <em>{pct ? "%" : unit}</em>}
      </div>
      {hint && <small>{hint}</small>}
    </div>
  );
}

export function SelectBox({ label, value, onChange, locked, onLock, options, hint }) {
  return (
    <div className={`rtc-field ${locked ? "is-locked" : ""}`}>
      <div className="rtc-field-top">
        <span>{label}</span>
        {onLock && <LockButton locked={locked} onToggle={onLock} />}
      </div>
      <select value={value} disabled={locked} onChange={(e) => onChange(e.target.value)}>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
      {hint && <small>{hint}</small>}
    </div>
  );
}

export function SwitchBox({ label, checked, onChange, locked, onLock, hint }) {
  return (
    <div className={`rtc-field ${locked ? "is-locked" : ""}`}>
      <div className="rtc-field-top">
        <span>{label}</span>
        {onLock && <LockButton locked={locked} onToggle={onLock} />}
      </div>
      <button type="button" className={`rtc-switch ${checked ? "on" : ""}`} disabled={locked} onClick={() => onChange(!checked)}>
        <i />
        {checked ? "On" : "Off"}
      </button>
      {hint && <small>{hint}</small>}
    </div>
  );
}

export function Section({ index, title, note, actions, children, className = "" }) {
  return (
    <section className={`rtc-section ${className}`}>
      <header>
        <div>
          {index && <span className="rtc-index">{index}</span>}
          <h2>{title}</h2>
        </div>
        <div className="rtc-section-actions">
          {note && <span className="rtc-note">{note}</span>}
          {actions}
        </div>
      </header>
      {children}
    </section>
  );
}

export function UploadButton({ label, onFile, disabled }) {
  const ref = useRef(null);
  return (
    <>
      <button type="button" className="secondary" disabled={disabled} onClick={() => ref.current?.click()}>
        <Upload size={14} /> {label}
      </button>
      <input
        ref={ref}
        type="file"
        accept=".csv,.txt"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = "";
        }}
      />
    </>
  );
}

export function Stat({ label, value, detail, tone }) {
  return (
    <div className={`rtc-stat ${tone ? `tone-${tone}` : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      {detail && <small>{detail}</small>}
    </div>
  );
}

// ---------------------------------------------------------------- chart options

export function heatmapOption(matrix, { name, unit, max, min = 0, colors }) {
  const data = [];
  matrix.forEach((row, m) => row.forEach((v, h) => data.push([h, m, Number(v.toFixed(3))])));
  const hi = max ?? Math.max(...data.map((d) => d[2]), 1e-6);
  const lo = Math.min(min, hi * 0.5);
  return {
    animation: false,
    grid: { left: 44, right: 16, top: 10, bottom: 58 },
    tooltip: { formatter: (p) => `${E.MONTHS[p.value[1]]} · ${HOUR_LABELS[p.value[0]]}:00<br/><b>${nf(p.value[2], unit === "%" ? 1 : 1)} ${unit}</b>` },
    xAxis: { type: "category", data: HOUR_LABELS, splitArea: { show: false } },
    yAxis: { type: "category", data: E.MONTHS, inverse: true },
    visualMap: { min: lo, max: hi, calculable: true, orient: "horizontal", left: "center", bottom: 0, itemHeight: 160, itemWidth: 10, inRange: { color: colors }, text: [`${unit}`, ""] },
    series: [{ name, type: "heatmap", data, progressive: 0 }],
  };
}

