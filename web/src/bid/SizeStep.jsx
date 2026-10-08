import React, { useMemo, useState } from "react";
import { BatteryCharging, CheckCircle2, Flame, Loader2, Square, Sun, TriangleAlert, Wind, XCircle, Zap } from "lucide-react";
import * as E from "../rtc/engine";
import { LiveChart } from "../rtc/charts";
import { SizeCard } from "../rtc/chapters";
import ProfileLibrary from "../rtc/ProfileLibrary";
import { DATA_COLORS } from "../chartTheme";
import { Field, SelectBox, Section, Stat, SwitchBox, nf, pf } from "../rtc/ui";
import { BIOMASS_COLOR, MARKETS, activeRules, anyHours, energyMix, marketLabel, peakHours, peakLabel, scaledVars, sizesAtMax } from "./model";
import { SourceChip } from "./RequirementsStep";
import Checklist, { BidderInputs } from "./Checklist";

const COLORS = { solar: DATA_COLORS.solar, wind: DATA_COLORS.wind, biomass: BIOMASS_COLOR, bess: DATA_COLORS.bess };
const HOUR_OPTIONS = Array.from({ length: 24 }, (_, h) => [String(h), `${String(h).padStart(2, "0")}:00`]);

function SourceCard({ id, title, icon: Icon, on, onToggle, lockedOn, children, note }) {
  return (
    <div className={`bid-source ${on ? "" : "off"}`} style={{ "--chapter": COLORS[id] }} data-testid={`source-${id}`}>
      <header>
        <span className="bid-source-icon"><Icon size={16} /></span>
        <strong>{title}</strong>
        <button type="button" className={`rtc-switch ${on ? "on" : ""}`} onClick={onToggle} disabled={lockedOn} aria-pressed={on} title={lockedOn ? "Required by the tender" : undefined}>
          <i />{on ? "On" : "Off"}
        </button>
      </header>
      {note && <p className="rtc-note">{note}</p>}
      {on && <div className="bid-source-body">{children}</div>}
    </div>
  );
}

function RulesEditor({ state, setState, prov }) {
  const setRule = (id, values) => setState((s) => ({ ...s, rules: s.rules.map((r) => (r.id === id ? { ...r, ...values } : r)) }));
  return (
    <div className="bid-rules">
      <div className="bid-rules-row head"><span /><span>Supply floor</span><span>Measured</span><span>Hours</span><span>At least</span><span /></div>
      {state.rules.map((r) => (
        <div key={r.id} className={`bid-rules-row ${r.enabled ? "" : "off"}`} data-testid={`rule-${r.id}`}>
          <input type="checkbox" checked={r.enabled} onChange={() => setRule(r.id, { enabled: !r.enabled })} aria-label={`Use ${r.label}`} />
          <span>{r.label}</span>
          <select value={r.basis} onChange={(e) => setRule(r.id, { basis: e.target.value })} disabled={!r.enabled}>
            <option value="annual">over the year</option>
            <option value="monthly">in every month</option>
          </select>
          <select value={r.hours} onChange={(e) => setRule(r.id, { hours: e.target.value })} disabled={!r.enabled}>
            <option value="all">all hours</option>
            <option value="peak">peak window</option>
            <option value="any">any hour that may be picked</option>
          </select>
          <span className="bid-pct">
            <input type="number" step="1" min="1" max="100" value={Math.round(r.target * 1000) / 10} disabled={!r.enabled}
              onChange={(e) => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) setRule(r.id, { target: Math.min(1, Math.max(0.01, v / 100)) }); }} />
            <em>%</em>
          </span>
          <SourceChip source={prov[`rule.${r.id}`]} compact />
        </div>
      ))}
      <p className="rtc-note">Each floor is delivered energy ÷ (contracted capacity × hours), checked in every modelled PPA year, as the tender measures supply (CUF).</p>
    </div>
  );
}

function ComplianceTable({ lp }) {
  const years = lp.perYear || [];
  const rules = years[0]?.rules || [];
  if (!rules.length) return null;
  return (
    <div className="bid-compliance" data-testid="bid-compliance">
      <div className="bid-compliance-row head"><span>Supply floor</span><span>Target</span>{years.map((y) => <span key={y.year}>Year {y.year}</span>)}</div>
      {rules.map((r, i) => (
        <div key={r.id} className="bid-compliance-row">
          <span>{r.label || r.id}</span>
          <span>{pf(r.target, 1)}</span>
          {years.map((y) => {
            const o = y.rules[i];
            return <span key={y.year} className={o.met ? "ok" : "bad"}>{o.met ? <CheckCircle2 size={12} /> : <XCircle size={12} />} {pf(o.achieved, 1)}</span>;
          })}
        </div>
      ))}
    </div>
  );
}

/** Average day and month of the chosen IEX market, from the hourly price year. */
function MarketProfile({ prices, market }) {
  const m = prices?.markets?.[market];
  const option = useMemo(() => (m ? {
    animation: false,
    grid: [{ left: 48, right: "54%", top: 30, bottom: 28 }, { left: "54%", right: 12, top: 30, bottom: 28 }],
    title: [{ text: "Average day (₹/kWh)", left: 0, top: 0, textStyle: { fontSize: 11 } }, { text: "Monthly average (₹/kWh)", left: "54%", top: 0, textStyle: { fontSize: 11 } }],
    tooltip: { trigger: "axis", valueFormatter: (v) => `₹${nf(v, 2)}/kWh` },
    xAxis: [{ type: "category", gridIndex: 0, data: Array.from({ length: 24 }, (_, h) => String(h).padStart(2, "0")) }, { type: "category", gridIndex: 1, data: E.MONTHS }],
    yAxis: [{ type: "value", gridIndex: 0, min: 0 }, { type: "value", gridIndex: 1, min: 0 }],
    series: [
      { name: market, type: "bar", xAxisIndex: 0, yAxisIndex: 0, data: m.hourOfDayMeanRsPerMwh.map((v) => v / 1000), itemStyle: { color: DATA_COLORS.surplus } },
      { name: market, type: "bar", xAxisIndex: 1, yAxisIndex: 1, data: m.monthlyMeanRsPerMwh.map((v) => v / 1000), itemStyle: { color: DATA_COLORS.surplus } },
    ],
  } : null), [m, market]);
  if (!m) return <p className="rtc-note">IEX prices are loading or unavailable; the sizing uses them once loaded.</p>;
  return (
    <div className="rtc-card bid-market" data-testid="bid-market">
      <div className="rtc-card-head">
        <span>IEX {market} · {m.label} · {m.from} to {m.to} · {m.days} days</span>
        <span className="rtc-note">min ₹{nf(m.minRsPerMwh / 1000, 2)} · avg ₹{nf(m.meanRsPerMwh / 1000, 2)} · max ₹{nf(m.maxRsPerMwh / 1000, 2)}/kWh</span>
      </div>
      <LiveChart option={option} height={190} />
    </div>
  );
}

function DispatchWeek({ hourly, peak, market, rules }) {
  const [week, setWeek] = useState(0);
  const option = useMemo(() => {
    if (!hourly) return null;
    const start = week * 168;
    const end = Math.min(E.HOURS, start + 168);
    const idx = Array.from({ length: end - start }, (_, i) => start + i);
    const split = (key) => idx.map((t) => {
      const g = hourly.solar[t] + hourly.wind[t] + hourly.biomass[t];
      return g > 0 ? Number(((hourly.direct[t] * hourly[key][t]) / g).toFixed(2)) : 0;
    });
    const labels = idx.map((t) => `${E.MONTHS[E.MONTH_OF_HOUR[t]]} ${String(E.HOUR_OF_DAY[t]).padStart(2, "0")}h`);
    const anyRule = rules?.some((r) => r.enabled && r.hours === "any");
    const ph = new Set(anyRule ? (peak.windows?.length ? anyHours(peak) : []) : peakHours(peak));
    const areas = [];
    idx.forEach((t, i) => {
      if (ph.has(E.HOUR_OF_DAY[t]) && (i === 0 || !ph.has(E.HOUR_OF_DAY[idx[i - 1]]))) {
        let j = i;
        while (j + 1 < idx.length && ph.has(E.HOUR_OF_DAY[idx[j + 1]])) j += 1;
        areas.push([{ xAxis: labels[i] }, { xAxis: labels[j] }]);
      }
    });
    const stack = (name, data, color) => ({ name, type: "line", stack: "supply", areaStyle: { color, opacity: 0.75 }, lineStyle: { width: 0 }, symbol: "none", itemStyle: { color }, data });
    return {
      animation: false,
      grid: { left: 56, right: 16, top: 34, bottom: 46 },
      legend: { top: 0, right: 0 },
      tooltip: { trigger: "axis", valueFormatter: (v) => `${nf(v, 1)} MW` },
      xAxis: { type: "category", data: labels, axisLabel: { interval: 23 } },
      yAxis: [{ type: "value", name: "MW" }, { type: "value", name: "₹/kWh", min: 0, splitLine: { show: false }, show: Boolean(hourly.price) }],
      series: [
        { ...stack("Solar", split("solar"), DATA_COLORS.solar), markArea: { silent: true, itemStyle: { color: "rgba(212,255,63,0.06)" }, data: areas } },
        stack("Wind", split("wind"), DATA_COLORS.wind),
        stack("Biomass", split("biomass"), BIOMASS_COLOR),
        stack("Battery", idx.map((t) => hourly.discharge[t]), DATA_COLORS.bess),
        stack(market ? `Sold on IEX ${market}` : "Sold as surplus", idx.map((t) => hourly.export[t]), DATA_COLORS.surplus),
        ...(hourly.price ? [{ name: `IEX ${market} price`, type: "line", yAxisIndex: 1, symbol: "none", data: idx.map((t) => hourly.price[t]), lineStyle: { color: "#f2b84b", width: 1.2 }, itemStyle: { color: "#f2b84b" }, tooltip: { valueFormatter: (v) => `₹${nf(v, 2)}/kWh` } }] : []),
        { name: "Charging", type: "bar", data: idx.map((t) => -hourly.charge[t]), itemStyle: { color: "rgba(169,139,255,0.45)" }, barWidth: "90%" },
        { name: "Contracted supply", type: "line", step: "middle", data: idx.map((t) => hourly.demand[t]), lineStyle: { color: "#f4f4f1", type: "dashed", width: 1 }, itemStyle: { color: "#f4f4f1" }, symbol: "none" },
      ],
    };
  }, [hourly, week, peak, market, rules]);
  if (!hourly) return <p className="rtc-note">Run the sizing again to see the hour-by-hour dispatch (it is not kept when the page reloads).</p>;
  return (
    <div className="rtc-card">
      <div className="rtc-card-head">
        <span>Year-1 dispatch · week {week + 1} · peak window shaded</span>
        <input type="range" min="0" max="51" value={week} onChange={(e) => setWeek(Number(e.target.value))} aria-label="Week of the year" />
      </div>
      <LiveChart option={option} height={300} />
    </div>
  );
}

/** Step 3: the plant the optimizer may build and the least-tariff sizing that meets the tender. */
export default function SizeStep({ state, setState, patch, set, lockProps, isLocked, user, run, startSizing, stopSizing, hourly, goto, prices }) {
  const prov = state.provenance || {};
  const { sources, vars, bess, biomass, costs, fin, inputs } = state;
  const setVar = (k, values) => setState((s) => ({ ...s, vars: { ...s.vars, [k]: { ...s.vars[k], ...values } } }));
  const toggle = (k) => setState((s) => ({ ...s, sources: { ...s.sources, [k]: !s.sources[k] } }));
  const rules = activeRules(state);
  const lp = state.lp;
  const mix = useMemo(() => energyMix(hourly), [hourly]);
  const running = Boolean(run?.active);
  const nothingOn = !Object.values(sources).some(Boolean);
  const atMax = lp ? sizesAtMax(lp, vars, sources) : [];
  // with a tender read, sales outside the PPA only where the tender allows them
  const saleBarred = Boolean(state.tender) && (!prov["market.sale"] || /not allowed/i.test(prov["market.sale"].display || ""));

  return (
    <>
      <Section index="3" title="Contract and supply floors" note={state.site?.label}>
        <div className="rtc-grid rtc-grid-3">
          <div className="bid-input-with-src">
            <Field label="Contracted supply capacity" unit="MW" value={state.plantMw} onChange={(v) => set("plantMw", v)} step={10} min={1} hint="Round-the-clock supply obligation (delivery cap)" />
            <SourceChip source={prov.plantMw} />
          </div>
          <div className="bid-input-with-src">
            {state.rules.some((r) => r.enabled && r.hours === "any")
              ? <div className="rtc-field"><div className="rtc-field-top"><span>Peak hours</span></div><strong>{state.peak.windows?.length ? state.peak.windows.map((w) => `${w.start}–${w.end}`).join(" and ") : "Any hour of the day"}</strong><small>{state.peak.setBy === "procurer" ? "The procurer picks the hours, so every hour it may pick is checked" : "Every hour inside the tender's windows is checked"}</small></div>
              : <SelectBox label="Peak window starts" value={String(state.peak.start)} onChange={(v) => patch("peak", { start: Number(v) })} options={HOUR_OPTIONS} hint={`Peak hours ${peakLabel(state.peak)}${state.peak.setBy === "supplier" ? " · the tender lets the supplier choose" : " · not set by a tender"}`} />}
            <SourceChip source={prov["peak.setBy"]} />
          </div>
          <div className="bid-input-with-src">
            <Field label="Peak hours per day" unit="h" value={state.peak.hours} onChange={(v) => patch("peak", { hours: Math.max(1, Math.min(12, Math.round(v))) })} step={1} min={1} max={12} hint="Used by floors measured in peak hours" />
            <SourceChip source={prov["peak.hours"]} />
          </div>
        </div>
        <div className="rtc-grid rtc-grid-3">
          <div className="bid-input-with-src">
            <SwitchBox label="Sell surplus in the market" checked={fin.sellSurplus} onChange={(v) => patch("fin", { sellSurplus: v })}
              locked={saleBarred}
              hint={saleBarred ? "The tender does not allow sales outside the PPA" : "Energy the PPA and the battery cannot take"} />
            <SourceChip source={prov["market.sale"]} compact />
          </div>
          <SelectBox label="Surplus sold at" value={state.market?.source || "GDAM"} onChange={(v) => patch("market", { source: v })}
            options={[...MARKETS.map((m) => [m, prices?.markets?.[m] ? `IEX ${m} · hourly, avg ₹${nf(prices.markets[m].meanRsPerMwh / 1000, 2)}/kWh` : `IEX ${m} · hourly`]), ["flat", "A flat price"]]}
            hint={state.market?.source === "flat" ? "One price for every hour" : prices?.markets?.[state.market?.source]?.source || "IEX market-clearing prices"} />
          {state.market?.sellFrom === "solar"
            ? (
              <div className="bid-input-with-src">
                <SelectBox label="Sold in the market" value="solar" onChange={() => {}} options={[["solar", "Solar surplus only (as the tender allows)"]]}
                  hint="Only the mandated solar may be scheduled in the market; it sells over its own interconnection" />
                <SourceChip source={prov["solar.min"]} compact />
              </div>
            )
            : <Field label="Extra export capacity" unit="MW" value={fin.extraExportMw} onChange={(v) => patch("fin", { extraExportMw: v })} step={10} min={0} disabled={!fin.sellSurplus} hint="Connection for market sales beyond the contracted capacity" />}
          {state.market?.source === "flat"
            ? <Field label="Flat market price" unit="₹/kWh" value={fin.surplusPrice} onChange={(v) => patch("fin", { surplusPrice: v })} step={0.05} min={0} disabled={!fin.sellSurplus} />
            : <Field label="Market price escalation" pct value={state.market?.escalation || 0} onChange={(v) => patch("market", { escalation: v })} step={0.25} min={-5} max={10} disabled={!fin.sellSurplus} hint="per year, on the hourly prices" />}
        </div>
        {fin.sellSurplus && <p className="rtc-note">The PPA is supplied first in every hour; only energy it cannot take is sold.</p>}
        {fin.sellSurplus && state.market?.source !== "flat" && <MarketProfile prices={prices} market={state.market?.source} />}
        <RulesEditor state={state} setState={setState} prov={prov} />
        <button type="button" className="secondary" onClick={() => setState((s) => ({ ...s, vars: scaledVars(s.plantMw, s.vars) }))}>Rescale size ranges to the capacity</button>
      </Section>

      <Section index="3.1" title="What the optimizer may build" note="Switch a source off to leave it out · lock a size to keep it fixed">
        <div className="bid-sources">
          <SourceCard id="solar" title="Solar" icon={Sun} on={sources.solar} onToggle={() => toggle("solar")}>
            <SizeCard label="Solar capacity" unit="MWac" spec={vars.solarMw} onChange={(v) => setVar("solarMw", v)} color={COLORS.solar} />
            {prov["solar.min"] && <p className="rtc-note">Minimum set by the tender <SourceChip source={prov["solar.min"]} /></p>}
            <div className="rtc-grid rtc-grid-2">
              <Field label="Capex" unit="₹ cr/MW" value={costs.solarCrPerMw} onChange={(v) => patch("costs", { solarCrPerMw: v })} step={0.05} min={0} />
              <Field label="O&M" unit="₹ lakh/MW/yr" value={fin.solarOmLakhPerMw} onChange={(v) => patch("fin", { solarOmLakhPerMw: v })} step={0.1} min={0} />
              <Field label="Synthetic profile CUF" pct value={inputs.solarCuf} onChange={(v) => patch("inputs", { solarCuf: v })} step={0.1} min={5} max={40} disabled={Boolean(state.solarUpload)} hint={state.solarUpload ? `Using ${state.solarUpload.name}` : "Used when no profile is chosen"} />
              <Field label="Degradation" pct value={fin.solarDegradation} onChange={(v) => patch("fin", { solarDegradation: v })} step={0.05} min={0} max={3} hint="per year" />
            </div>
            <details className="bid-profile"><summary>Solar profile</summary><ProfileLibrary kind="solar" state={state} set={set} lockProps={lockProps} isLocked={isLocked} color={COLORS.solar} user={user} /></details>
          </SourceCard>

          <SourceCard id="wind" title="Wind" icon={Wind} on={sources.wind} onToggle={() => toggle("wind")}>
            <SizeCard label="Wind capacity" unit="MW" spec={vars.windMw} onChange={(v) => setVar("windMw", v)} color={COLORS.wind} />
            <div className="rtc-grid rtc-grid-2">
              <Field label="Capex" unit="₹ cr/MW" value={costs.windCrPerMw} onChange={(v) => patch("costs", { windCrPerMw: v })} step={0.05} min={0} />
              <Field label="O&M" unit="₹ lakh/MW/yr" value={fin.windOmLakhPerMw} onChange={(v) => patch("fin", { windOmLakhPerMw: v })} step={0.1} min={0} />
              <Field label="Synthetic profile CUF" pct value={inputs.windCuf} onChange={(v) => patch("inputs", { windCuf: v })} step={0.1} min={25} max={50} disabled={Boolean(state.windUpload)} hint={state.windUpload ? `Using ${state.windUpload.name}` : "Used when no profile is chosen"} />
            </div>
            <details className="bid-profile"><summary>Wind profile</summary><ProfileLibrary kind="wind" state={state} set={set} lockProps={lockProps} isLocked={isLocked} color={COLORS.wind} user={user} /></details>
          </SourceCard>

          <SourceCard id="biomass" title="Biomass" icon={Flame} on={sources.biomass} onToggle={() => toggle("biomass")}
            note={prov["sources.biomass"] ? <>Allowed by the tender <SourceChip source={prov["sources.biomass"]} /></> : "Firm, dispatchable renewable power, limited by fuel"}>
            <SizeCard label="Biomass capacity" unit="MW" spec={vars.biomassMw} onChange={(v) => setVar("biomassMw", v)} color={COLORS.biomass} />
            <div className="rtc-grid rtc-grid-2">
              <Field label="Availability" pct value={biomass.availability} onChange={(v) => patch("biomass", { availability: v })} step={1} min={10} max={100} hint="Highest hourly output" />
              <Field label="Fuel-limited PLF" pct value={biomass.maxPlf} onChange={(v) => patch("biomass", { maxPlf: v })} step={1} min={5} max={100} hint="Most energy per year" />
              <Field label="Minimum stable load" pct value={biomass.minLoad} onChange={(v) => patch("biomass", { minLoad: v })} step={5} min={0} max={100} hint="The plant runs all year at least this much" />
              <Field label="Capex" unit="₹ cr/MW" value={costs.biomassCrPerMw} onChange={(v) => patch("costs", { biomassCrPerMw: v })} step={0.1} min={0} />
              <Field label="O&M" unit="₹ lakh/MW/yr" value={fin.biomassOmLakhPerMw} onChange={(v) => patch("fin", { biomassOmLakhPerMw: v })} step={1} min={0} />
              <Field label="Fuel cost" unit="₹/kWh" value={fin.biomassFuelRsPerKwh} onChange={(v) => patch("fin", { biomassFuelRsPerKwh: v })} step={0.05} min={0} hint="per kWh generated" />
              <Field label="Fuel escalation" pct value={fin.biomassFuelEscalation} onChange={(v) => patch("fin", { biomassFuelEscalation: v })} step={0.25} min={0} max={15} hint="per year" />
            </div>
          </SourceCard>

          <SourceCard id="bess" title="Battery" icon={BatteryCharging} on={sources.bess} onToggle={() => toggle("bess")} lockedOn={state.bessMandatory && sources.bess}
            note={state.bessMandatory ? <>Storage is mandatory <SourceChip source={prov["sources.bess"]} /></> : null}>
            <SizeCard label="Battery power" unit="MW" spec={vars.bessMw} onChange={(v) => setVar("bessMw", v)} color={COLORS.bess} />
            {!bess.durationH && <SizeCard label="Battery energy" unit="MWh" spec={vars.bessMwh} onChange={(v) => setVar("bessMwh", v)} color={COLORS.bess} />}
            <div className="rtc-grid rtc-grid-2">
              <SelectBox label="Discharge duration" value={bess.durationH ? String(bess.durationH) : "free"} onChange={(v) => patch("bess", { durationH: v === "free" ? null : Number(v) })} options={[["4", "4 hours"], ["2", "2 hours"], ["free", "Free (1–8 h)"]]} />
              <div className="bid-input-with-src">
                <Field label="Round-trip efficiency" pct value={bess.rte} onChange={(v) => patch("bess", { rte: v })} step={0.5} min={50} max={100} />
                <SourceChip source={prov["bess.rte"]} />
              </div>
              <Field label="Capex" unit="₹ cr/MWh" value={costs.bessCrPerMwh} onChange={(v) => patch("costs", { bessCrPerMwh: v })} step={0.05} min={0} />
              <Field label="O&M" unit="₹ lakh/MWh/yr" value={fin.bessOmLakhPerMwh} onChange={(v) => patch("fin", { bessOmLakhPerMwh: v })} step={0.1} min={0} />
              <Field label="Capacity fade" pct value={bess.annualDegradation} onChange={(v) => patch("bess", { annualDegradation: v })} step={0.25} min={0} max={10} hint="per year" />
              <SelectBox label="Augmentation" value={bess.augmentation} onChange={(v) => patch("bess", { augmentation: v })} options={[["annual", "Every year"], ["oneTime", "Once"], ["none", "None"]]} />
            </div>
          </SourceCard>
        </div>
      </Section>

      <section className="optimize-bar">
        <div>
          <span className="rtc-index">3.2</span>
          <h2>Find the least-tariff plant</h2>
          <p>
            HiGHS sizes {[sources.solar && "solar", sources.wind && "wind", sources.biomass && "biomass", sources.bess && "battery"].filter(Boolean).join(", ") || "nothing"} together with the hour-by-hour dispatch over the PPA years,
            so that {rules.length ? rules.map((r) => `${r.label.toLowerCase()} ≥ ${pf(r.target, 0)}`).join(", ") : "no floor is set"} holds every year, at the lowest {fin.years}-year tariff for a {pf(fin.targetEquityIrr, 1)} equity IRR.
            {fin.sellSurplus ? ` Surplus is sold at ${marketLabel(state, prices)}, hour by hour.` : " Surplus is not sold."} Lock every size to evaluate a fixed design.
          </p>
        </div>
        <div className="optimize-bar-actions">
          {running
            ? <button type="button" className="secondary" onClick={stopSizing}><Square size={14} /> Stop</button>
            : <button type="button" className="primary optimize-go" onClick={startSizing} disabled={nothingOn || !rules.length} data-testid="bid-size"><Zap size={16} /> Size the plant</button>}
        </div>
      </section>

      {(running || run?.log?.length > 0) && (
        <div className="bid-console" data-testid="bid-console">
          <div className="bid-console-head">
            {running ? <><Loader2 className="spin" size={13} /> Solving{run.iteration ? ` · iteration ${run.iteration}` : ""}{run.tariff ? ` · ₹${nf(run.tariff, 4)}/kWh` : ""}</> : run.error ? <><TriangleAlert size={13} /> {run.error}</> : <><CheckCircle2 size={13} /> Solved</>}
            <span className="rtc-note">{nf(((run.finished || Date.now()) - run.started) / 1000, 0)} s</span>
          </div>
          <pre>{run.log.slice(-14).map((l) => `${String(Math.round(l.t / 1000)).padStart(4)} s  ${l.msg}`).join("\n")}</pre>
        </div>
      )}

      {lp && (
        <>
          {atMax.length > 0 && (
            <div className="alert" data-testid="bid-at-max">
              <TriangleAlert size={14} /> {atMax.map((k) => ({ solarMw: "Solar", windMw: "Wind", biomassMw: "Biomass", bessMw: "Battery power", bessMwh: "Battery energy" }[k])).join(", ")} ended at the top of {atMax.length > 1 ? "their ranges" : "its range"}: the optimizer would build more.
              {lp.market ? " With market sales this usually means surplus sold on the exchange is paying for extra plant; check the market limit and prices, or widen the range if intended." : " Widen the range if more is acceptable."}
            </div>
          )}
          <Section index="3.3" title="Least-tariff plant" note={`HiGHS · ${lp.status} · ${nf(lp.seconds, 0)} s · years modelled ${lp.years.join(", ")}`}
            actions={<button type="button" className="primary" onClick={() => goto("finance")}>Financials <Zap size={14} /></button>}>
            <div className="rtc-grid rtc-grid-4 bid-sizes" data-testid="bid-sizes">
              {sources.solar && <Stat label="Solar" value={`${nf(lp.sizes.solarMw, 0)} MW`} detail={`${nf(lp.sizes.solarMw / state.plantMw, 2)} × contracted`} />}
              {sources.wind && <Stat label="Wind" value={`${nf(lp.sizes.windMw, 0)} MW`} detail={`${nf(lp.sizes.windMw / state.plantMw, 2)} × contracted`} />}
              {sources.biomass && <Stat label="Biomass" value={`${nf(lp.sizes.biomassMw || 0, 0)} MW`} detail={lp.perYear?.[0]?.biomassMu !== undefined ? `${nf(lp.perYear[0].biomassMu, 0)} MU in year 1` : ""} />}
              {sources.bess && <Stat label="Battery" value={`${nf(lp.sizes.bessMw, 0)} MW / ${nf(lp.sizes.bessMwh, 0)} MWh`} detail={lp.sizes.bessMw > 0 ? `${nf(lp.sizes.bessMwh / lp.sizes.bessMw, 1)} h` : "none"} />}
              <Stat label="25-year tariff (HiGHS)" value={`₹${nf(lp.tariff, 3)}/kWh`} detail={`no design below ₹${nf(lp.lowerBound, 3)}`} />
            </div>
            <ComplianceTable lp={lp} />
          </Section>
          <Checklist state={state} lp={lp} index="3.4" />
          <BidderInputs state={state} prices={prices} index="3.5" />
          <Section index="3.6" title="Year-1 energy" note="Where the contracted supply came from">
            {hourly && (
              <div className="rtc-grid rtc-grid-4">
                <Stat label="Contracted (100%)" value={`${nf(mix.demand / 1000, 0)} MU`} />
                <Stat label="Solar" value={`${nf(mix.solar / 1000, 0)} MU`} detail={pf(mix.solar / mix.demand, 1)} />
                <Stat label="Wind" value={`${nf(mix.wind / 1000, 0)} MU`} detail={pf(mix.wind / mix.demand, 1)} />
                <Stat label="Biomass" value={`${nf(mix.biomass / 1000, 0)} MU`} detail={pf(mix.biomass / mix.demand, 1)} />
                <Stat label="Battery" value={`${nf(mix.battery / 1000, 0)} MU`} detail={pf(mix.battery / mix.demand, 1)} />
                <Stat label="Not supplied" value={`${nf(mix.unmet / 1000, 0)} MU`} detail={pf(mix.unmet / mix.demand, 1)} />
                <Stat label={lp.market ? `Sold on IEX ${lp.market}` : "Sold as surplus"} value={`${nf(mix.export / 1000, 0)} MU`}
                  detail={mix.export > 0 ? `₹${nf(lp.market ? mix.exportRevenueCr : (mix.export * (lp.flatPrice || 0)) / 1e4, 0)} cr · ₹${nf(lp.market ? (mix.exportRevenueCr * 1e4) / mix.export : lp.flatPrice, 2)}/kWh realised` : "nothing sold"} />
                <Stat label="Curtailed" value={`${nf(mix.curtail / 1000, 0)} MU`} />
              </div>
            )}
            <DispatchWeek hourly={hourly} peak={state.peak} market={lp.market} rules={state.rules} />
          </Section>
        </>
      )}
      {!lp && !running && <p className="rtc-note bid-hint">Size the plant to see the least-tariff design, the supply floors it meets in each modelled year and the dispatch.</p>}
    </>
  );
}

