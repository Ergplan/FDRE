import React, { useRef, useState } from "react";
import { AlertTriangle, BatteryCharging, CheckCircle2, FileSearch, FileText, IndianRupee, Landmark, ListChecks, Loader2, Upload, XCircle } from "lucide-react";
import * as B from "./engine";
import { Field, LockButton, NumberInput, SelectBox, Stat, nf, pf } from "../rtc/ui";

export const CHAPTERS = [
  { id: "tender", title: "Tender", icon: FileSearch, color: "#d4ff3f" },
  { id: "requirements", title: "Requirements", icon: ListChecks, color: "#4fd1c5" },
  { id: "battery", title: "Battery", icon: BatteryCharging, color: "#a98bff" },
  { id: "costs", title: "Costs", icon: IndianRupee, color: "#f5b83d" },
  { id: "finance", title: "Finance", icon: Landmark, color: "#5ab4e8" },
];

export function chapterSummary(id, state) {
  const { req, tech, costs, fin, tender } = state;
  switch (id) {
    case "tender": return tender ? `${tender.found}/${tender.total} found · ${tender.extraction?.engine || ""}` : "Upload the RfS";
    case "requirements": return `${nf(req.powerMw)} MW / ${nf(req.energyMwh)} MWh · ${req.cyclesPerDay}×/day`;
    case "battery": return `${tech.chemistry} · DoD ${pf(tech.dod, 0)} · RTE ${pf(B.rteAt(1, tech), 1)}`;
    case "costs": return `DC ₹${nf(costs.dcCrPerMwh, 2)} cr/MWh · PCS ₹${nf(costs.pcsCrPerMw, 2)} cr/MW`;
    case "finance": return `Equity IRR ${pf(fin.targetEquityIrr, 1)} · debt ${pf(fin.debtFraction, 0)}`;
    default: return "";
  }
}

const CONF = {
  high: { label: "Found", icon: CheckCircle2, cls: "q-good" },
  medium: { label: "Check", icon: AlertTriangle, cls: "q-warn" },
  low: { label: "Default", icon: XCircle, cls: "q-bad" },
  edited: { label: "Edited", icon: CheckCircle2, cls: "q-model" },
};

export function ConfidenceBadge({ level }) {
  const c = CONF[level] || CONF.low;
  const Icon = c.icon;
  return <span className={`q-badge ${c.cls}`}><Icon size={11} /> {c.label}</span>;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

// ---------------------------------------------------------------- 01 tender

export function TenderChapter({ state, onParsed, lockProps }) {
  const fileRef = useRef(null);
  const [parser, setParser] = useState("auto");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const t = state.tender;

  async function onFile(file) {
    setError("");
    if (file.size > 60 * 1024 * 1024) { setError("The file is larger than 60 MB."); return; }
    setBusy(true);
    const started = performance.now();
    try {
      const content = await fileToBase64(file);
      const res = await fetch("/api/bess/parse", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ file: { name: file.name, content_base64: content }, parser }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof j.detail === "string" ? j.detail : j.error || `Engine returned ${res.status}`);
      onParsed({ ...j, parsedAt: new Date().toISOString(), seconds: (performance.now() - started) / 1000 });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bess-tender">
      <p className="rtc-lead">Upload the Request for Selection (PDF or Word). The tender is read with Docling (layout, tables and OCR for scanned pages) when the engine has it, otherwise with the standard extractor, then searched clause by clause for the battery requirements. Every value keeps its page and clause so you can check it.</p>
      <div className="chapter-toolbar">
        <div className="seg">
          {[["auto", "Automatic"], ["docling", "Docling"], ["standard", "Standard (fast)"]].map(([v, l]) => (
            <button key={v} type="button" className={parser === v ? "active" : ""} onClick={() => setParser(v)}>{l}</button>
          ))}
        </div>
        <button type="button" className="primary" disabled={busy || lockProps("tender").locked} onClick={() => fileRef.current?.click()}>
          {busy ? <Loader2 className="spin" size={14} /> : <Upload size={14} />} {busy ? "Reading the tender…" : t ? "Upload another tender" : "Upload tender"}
        </button>
        <input ref={fileRef} type="file" accept=".pdf,.docx,.txt" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ""; }} />
        <div className="chapter-toolbar-end"><LockButton locked={lockProps("tender").locked} onToggle={lockProps("tender").onLock} title="Lock the tender (no new uploads)" /></div>
      </div>
      {busy && <p className="rtc-note"><Loader2 className="spin" size={12} /> Docling can take a minute or two on a long scanned tender.</p>}
      {error && <div className="alert">{error}</div>}
      {t ? (
        <>
          <div className="bess-doc">
            <FileText size={28} />
            <div>
              <strong>{t.title || t.source_name}</strong>
              <small>{[t.metadata?.issuer, t.metadata?.rfs_no && `RfS ${t.metadata.rfs_no}`, t.metadata?.rfs_date].filter(Boolean).join(" · ")}</small>
              <small>{t.source_name} · {t.extraction?.pages} pages · read with {t.extraction?.engine}{t.seconds ? ` in ${nf(t.seconds, 1)} s` : ""}</small>
            </div>
          </div>
          {t.warnings?.length > 0 && <ul className="upload-issues">{t.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
          <div className="rtc-stats">
            <Stat label="Requirements found" value={`${t.found} / ${t.total}`} detail="the rest use defaults: check them" tone={t.found < t.total / 2 ? "bad" : undefined} />
            <Stat label="Capacity" value={`${nf(state.req.powerMw)} MW`} detail={`${nf(state.req.energyMwh)} MWh · ${nf(state.req.energyMwh / state.req.powerMw, 1)} h`} />
            <Stat label="Contract" value={`${state.req.contractYears} years`} detail={`${state.req.cyclesPerDay} cycles/day`} />
            <Stat label="Risk flags" value={t.risk_flags?.length || 0} detail="see Tender insights below the answer" />
          </div>
          {t.timeline?.length > 0 && (
            <div className="table-wrap">
              <table>
                <thead><tr>{Object.keys(t.timeline[0]).map((k) => <th key={k}>{k}</th>)}</tr></thead>
                <tbody>{t.timeline.slice(0, 8).map((r, i) => <tr key={i}>{Object.values(r).map((v, j) => <td key={j}>{String(v)}</td>)}</tr>)}</tbody>
              </table>
            </div>
          )}
        </>
      ) : (
        <div className="empty-state">No tender yet. You can also skip this chapter and type the requirements in the next one.</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- 02 requirements

// Tender fields and how they are edited. kind: num | pct | lakh | select | info
const REQ_FIELDS = [
  { key: "powerMw", kind: "num", unit: "MW" },
  { key: "energyMwh", kind: "num", unit: "MWh" },
  { key: "durationH", kind: "num", unit: "h", derived: true },
  { key: "cyclesPerDay", kind: "num", unit: "per day" },
  { key: "annualCycles", kind: "num", unit: "per year" },
  { key: "minRte", kind: "pct" },
  { key: "availability", kind: "pct" },
  { key: "availabilityBasis", kind: "select", options: [["monthly", "Monthly"], ["annual", "Annual"]] },
  { key: "contractYears", kind: "num", unit: "years" },
  { key: "scodMonths", kind: "num", unit: "months" },
  { key: "ceilingTariff", kind: "lakh", unit: "lakh/MW/month" },
  { key: "vgfLakhPerMwh", kind: "num", unit: "lakh/MWh" },
  { key: "vgfPct", kind: "pct" },
  { key: "chargingBy", kind: "select", options: [["procurer", "Procurer"], ["developer", "Developer"]] },
  { key: "maintainCapacity", kind: "info" },
  { key: "tariffBasis", kind: "info" },
  { key: "connectionKv", kind: "info" },
  { key: "location", kind: "info" },
  { key: "minBidMw", kind: "info" },
  { key: "maxBidMw", kind: "info" },
  { key: "emdLakhPerMw", kind: "info" },
  { key: "pbgLakhPerMw", kind: "info" },
  { key: "availabilityPenalty", kind: "info" },
  { key: "rtePenalty", kind: "info" },
];
const LABELS = {
  powerMw: "Contracted power", energyMwh: "Contracted energy", durationH: "Discharge duration", cyclesPerDay: "Cycles per day",
  annualCycles: "Cycles per year", minRte: "Minimum round-trip efficiency", availability: "Minimum availability", availabilityBasis: "Availability measured",
  contractYears: "Contract term", scodMonths: "Commissioning (SCOD)", ceilingTariff: "Ceiling tariff", vgfLakhPerMwh: "VGF", vgfPct: "VGF (% of capex)",
  chargingBy: "Charging energy", maintainCapacity: "Capacity maintained for the term", tariffBasis: "Tariff basis", connectionKv: "Connection voltage",
  location: "Location", minBidMw: "Minimum bid", maxBidMw: "Maximum bid", emdLakhPerMw: "Bid security (EMD)", pbgLakhPerMw: "Performance security (PBG)",
  availabilityPenalty: "Availability shortfall penalty", rtePenalty: "RTE shortfall penalty",
};

export function RequirementsChapter({ state, setReq, lockProps }) {
  const [open, setOpen] = useState(null);
  const src = state.reqSource || {};
  const { req } = state;
  const valueOf = (f) => (f.key === "durationH" ? req.energyMwh / req.powerMw : req[f.key]);
  const onChange = (f, v) => {
    if (f.key === "durationH") setReq({ energyMwh: req.powerMw * v }, "energyMwh");
    else setReq({ [f.key]: v }, f.key);
  };
  return (
    <div>
      <p className="rtc-lead">What the tender asks for. Values read from the document show their page and clause; anything not found uses a flagged default. Edit a value to override it, and lock it to keep it when another tender or amendment is uploaded.</p>
      <div className="table-wrap">
        <table className="req-table">
          <thead><tr><th>Requirement</th><th>Value</th><th>Status</th><th>Source</th><th /></tr></thead>
          <tbody>
            {REQ_FIELDS.filter((f) => f.kind !== "info" || src[f.key]).map((f) => {
              const s = src[f.key];
              const lp = lockProps(`req.${f.key}`);
              const edited = state.edited?.[f.key];
              const level = edited ? "edited" : s?.confidence || (state.tender ? "low" : "edited");
              return (
                <React.Fragment key={f.key}>
                  <tr className={open === f.key ? "selected" : ""}>
                    <td><strong>{LABELS[f.key]}</strong>{s?.note && <small>{s.note}</small>}</td>
                    <td className="req-value">
                      {f.kind === "info" ? <span>{s?.display ?? "–"}</span>
                        : f.kind === "select" ? (
                          <select value={req[f.key]} disabled={lp.locked} onChange={(e) => onChange(f, e.target.value)}>
                            {f.options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                          </select>
                        ) : (
                          <span className="rtc-field-input">
                            <NumberInput
                              value={f.kind === "lakh" ? (valueOf(f) ?? NaN) : valueOf(f)}
                              scale={f.kind === "pct" ? 100 : f.kind === "lakh" ? 1e-5 : 1}
                              digits={f.kind === "lakh" ? 3 : 3}
                              disabled={lp.locked}
                              onCommit={(v) => onChange(f, v)}
                            />
                            <em>{f.kind === "pct" ? "%" : f.unit}</em>
                          </span>
                        )}
                    </td>
                    <td><ConfidenceBadge level={level} /></td>
                    <td>
                      {s?.page ? (
                        <button type="button" className="rtc-link" onClick={() => setOpen(open === f.key ? null : f.key)}>
                          p. {s.page}{s.clause ? ` · cl. ${s.clause}` : ""}{s.snippet ? (open === f.key ? " ▴" : " ▾") : ""}
                        </button>
                      ) : <span className="muted">{state.tender ? "not in the document" : "–"}</span>}
                    </td>
                    <td className="lib-actions">{f.kind !== "info" && <LockButton locked={lp.locked} onToggle={lp.onLock} />}</td>
                  </tr>
                  {open === f.key && s?.snippet && (
                    <tr className="req-snippet"><td colSpan={5}><blockquote>{s.snippet}</blockquote></td></tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 03 battery

export function BatteryChapter({ state, patch, lockProps }) {
  const { tech, req } = state;
  const p = (k) => ({ ...lockProps(`tech.${k}`), value: tech[k], onChange: (v) => patch("tech", { [k]: v }) });
  const perYear = tech.calendarFade + tech.cycleFadePer1000 * req.annualCycles / 1000;
  return (
    <div>
      <p className="rtc-lead">How the battery performs and ages. Capacity fades every year from calendar ageing and from cycling; the optimizer keeps the contracted energy by oversizing on day one and adding blocks later.</p>
      <div className="rtc-grid rtc-grid-3">
        <SelectBox label="Chemistry" value={tech.chemistry} onChange={(v) => patch("tech", { chemistry: v })} {...lockProps("tech.chemistry")} options={[["LFP", "LFP (lithium iron phosphate)"], ["NMC", "NMC"], ["Na-ion", "Sodium-ion"]]} />
        <Field label="Usable depth of discharge" pct {...p("dod")} />
        <Field label="Battery (DC) round-trip efficiency" pct {...p("dcRte")} />
        <Field label="PCS + transformer efficiency (one way)" pct {...p("pcsEff")} />
        <Field label="Auxiliary consumption" pct {...p("auxPct")} hint="HVAC, BMS; counted inside the AC round-trip efficiency" />
        <Field label="RTE loss per year" pct {...p("rteFadePerYear")} />
        <Field label="Extra fade in year 1" pct {...p("firstYearFade")} />
        <Field label="Calendar fade per year" pct {...p("calendarFade")} />
        <Field label="Cycle fade per 1,000 cycles" pct {...p("cycleFadePer1000")} />
        <Field label="PCS margin over contracted power" pct {...p("pcsMarginPct")} />
        <Field label="Expected availability" pct {...p("expectedAvailability")} />
      </div>
      <div className="rtc-stats">
        <Stat label="AC round-trip efficiency" value={pf(B.rteAt(1, tech), 1)} detail={`year ${req.contractYears}: ${pf(B.rteAt(req.contractYears, tech), 1)} · tender ≥ ${pf(req.minRte, 0)}`} tone={B.rteAt(req.contractYears, tech) < req.minRte ? "bad" : "good"} />
        <Stat label="DC needed for the contract" value={`${nf(B.requiredDcMwh(req, tech))} MWh`} detail={`for ${nf(req.energyMwh)} MWh at the delivery point`} />
        <Stat label="Capacity fade" value={`${pf(perYear, 1)} / yr`} detail={`plus ${pf(tech.firstYearFade, 1)} in year 1 · ${nf(req.annualCycles)} cycles/yr`} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 04 costs

export function CostsChapter({ state, patch, lockProps }) {
  const { costs } = state;
  const p = (k) => ({ ...lockProps(`costs.${k}`), value: costs[k], onChange: (v) => patch("costs", { [k]: v }) });
  return (
    <div>
      <p className="rtc-lead">Capital and running costs. Augmentation blocks are bought later at the DC block price less the yearly decline, plus a fixed cost per campaign: that trade-off against day-one oversizing is what the optimizer settles.</p>
      <div className="rtc-grid rtc-grid-3">
        <Field label="DC block (containerised)" unit="₹ cr/MWh" {...p("dcCrPerMwh")} />
        <Field label="PCS + MV transformer" unit="₹ cr/MW" {...p("pcsCrPerMw")} />
        <Field label="Balance of plant" unit="₹ cr/MWh" {...p("bopCrPerMwh")} hint="per MWh of contracted energy" />
        <Field label="Grid connection works" unit="₹ cr" {...p("gridCr")} />
        <Field label="Pre-operative + IDC" pct {...p("preopPct")} />
        <Field label="DC price decline per year" pct {...p("cellPriceDecline")} />
        <Field label="Cost per augmentation campaign" unit="₹ cr" {...p("augEventCr")} />
        <Field label="Fixed O&M" unit="₹ lakh/MW/yr" {...p("omLakhPerMwYr")} />
        <Field label="O&M + insurance per installed MWh" unit="₹ lakh/MWh/yr" {...p("omLakhPerMwhYr")} />
        <Field label="O&M escalation" pct {...p("omEscalation")} />
        <Field label="Charging / compensation price" unit="₹/kWh" {...p("chargingPrice")} hint="for RTE shortfall compensation, and charging if the developer buys it" />
        <Field label="Availability penalty factor" unit="× charge" {...p("availabilityPenaltyFactor")} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 05 finance

export function FinanceChapter({ state, patch, lockProps }) {
  const { fin } = state;
  const p = (k) => ({ ...lockProps(`fin.${k}`), value: fin[k], onChange: (v) => patch("fin", { [k]: v }) });
  return (
    <div>
      <p className="rtc-lead">The capacity charge is solved so that equity earns the target IRR over the contract term, after debt service, tax (WDV depreciation, losses carried forward), working capital and augmentation. VGF from the tender reduces the funded capital cost.</p>
      <div className="rtc-grid rtc-grid-3">
        <Field label="Target equity IRR" pct {...p("targetEquityIrr")} />
        <Field label="Debt share" pct {...p("debtFraction")} />
        <Field label="Interest rate" pct {...p("interestRate")} />
        <Field label="Loan tenor" unit="years" {...p("tenorYears")} />
        <Field label="Tax rate" pct {...p("taxRate")} />
        <Field label="Tax depreciation (WDV)" pct {...p("wdvRate")} />
        <Field label="Residual value" pct {...p("salvagePct")} hint="of the initial capital cost, at the end of the term" />
        <Field label="Receivable days" unit="days" {...p("receivableDays")} />
        <Field label="Capacity charge escalation" pct {...p("tariffEscalation")} />
        <Field label="Discount rate (LCOS)" pct {...p("discountRate")} />
      </div>
    </div>
  );
}
