import React, { useMemo } from "react";
import { ArrowRight, BatteryCharging, CheckCircle2, Droplets, Factory, Flame, Sun, TriangleAlert, Wind, Zap } from "lucide-react";
import ProfileLibrary from "../rtc/ProfileLibrary";
import { LiveChart } from "../rtc/charts";
import { DATA_COLORS } from "../chartTheme";
import { Field, Section, SelectBox, nf } from "../rtc/ui";
import * as E from "../rtc/engine";
import { BIOMASS_COLOR, FINANCE_FIELDS, HYDRO_COLOR, MARKETS, SOURCES, SOURCE_FIELDS, THERMAL_COLOR, missingInputs, plantMw, solarMinMw, sourceIssues } from "./model";
import { SourceChip } from "./RequirementsStep";

export const SOURCE_COLORS = { solar: DATA_COLORS.solar, wind: DATA_COLORS.wind, hydro: HYDRO_COLOR, biomass: BIOMASS_COLOR, thermal: THERMAL_COLOR, bess: DATA_COLORS.bess };
const ICONS = { solar: Sun, wind: Wind, hydro: Droplets, biomass: Flame, thermal: Factory, bess: BatteryCharging };

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

function InputField({ f, value, onChange }) {
  if (f.options) {
    return <SelectBox label={f.label} value={value ?? ""} onChange={(v) => onChange(v || null)} options={[["", "Choose…"], ...f.options]} />;
  }
  return <Field label={f.label} unit={f.unit === "%" ? undefined : f.unit} pct={Boolean(f.pct)} value={value} onChange={onChange} step={f.step} min={f.min} max={f.max} hint={f.hint} />;
}

function permittedNote(id, terms) {
  const prov = terms.provenance;
  const allowed = terms.permitted[id];
  if (allowed === false) return { blocked: true, text: "Not allowed by the tender", source: id === "thermal" ? prov.nonRe : prov.sources };
  if (terms.mandatory[id]) return { required: true, text: id === "solar" ? `Required by the tender: at least ${terms.solarMultiple} × contracted capacity` : "Required by the tender", source: id === "solar" ? prov["solar.min"] : prov.storage };
  if (allowed) return { text: id === "thermal" ? `Allowed for the balance, with RECs; at least ${Math.round((terms.greenMin || 0) * 100)}% of supply stays green` : "Allowed by the tender", source: id === "thermal" ? prov.nonRe : prov.sources };
  return { text: "The tender does not list sources" };
}

function SourceCard({ id, state, setState, terms, set, lockProps, isLocked, user }) {
  const meta = SOURCES.find((s) => s.id === id);
  const Icon = ICONS[id];
  const on = Boolean(state.sources[id]);
  const s = state.src[id];
  const note = permittedNote(id, terms);
  const issues = on ? sourceIssues(state, id, terms) : [];
  const setSrc = (values) => setState((st) => ({ ...st, src: { ...st.src, [id]: { ...st.src[id], ...values } }, lp: null }));
  const setCap = (values) => setSrc({ capacity: { ...s.capacity, ...values } });
  const toggle = () => setState((st) => ({ ...st, sources: { ...st.sources, [id]: !st.sources[id] }, lp: null }));
  const min = id === "solar" ? solarMinMw(state, terms) : null;
  const groups = [...new Set(SOURCE_FIELDS[id].map((f) => f.group))];
  const shim = { ...state, inputs: { solarCuf: state.src.solar.cuf || 0, windCuf: state.src.wind.cuf || 0 } };
  return (
    <div className={`bid-source ${on ? "" : "off"} ${issues.length ? "incomplete" : ""}`} style={{ "--chapter": SOURCE_COLORS[id] }} data-testid={`source-${id}`}>
      <header>
        <span className="bid-source-icon"><Icon size={16} /></span>
        <strong>{meta.title}</strong>
        <button type="button" className={`rtc-switch ${on ? "on" : ""}`} onClick={toggle} disabled={note.blocked || (note.required && on)} aria-pressed={on} data-testid={`have-${id}`}>
          <i />{on ? "I have it" : "Not in my bid"}
        </button>
      </header>
      <p className="rtc-note">{note.text} {note.source ? <SourceChip source={note.source} compact /> : null}</p>
      {on && (
        <div className="bid-source-body">
          <div className="bid-cap">
            <div className="bid-choice">
              <button type="button" className={s.capacity.mode === "fixed" ? "active" : ""} onClick={() => setCap({ mode: "fixed" })}>Fixed capacity</button>
              <button type="button" className={s.capacity.mode === "optimise" ? "active" : ""} onClick={() => setCap({ mode: "optimise" })}>Optimizer sizes it, up to</button>
            </div>
            <Field label={id === "bess" ? "Battery power" : "Capacity"} unit={id === "solar" ? "MWac" : "MW"} value={s.capacity.mw} onChange={(v) => setCap({ mw: v })} step={10} min={0}
              hint={min ? `Tender minimum ${nf(min, 0)} MW` : s.capacity.mode === "optimise" ? "The most the optimizer may build" : s.capacity.mode === "fixed" ? "Exactly this capacity" : "Choose fixed or optimised first"} />
          </div>
          {groups.map((g) => (
            <div key={g} className="bid-src-group">
              <h4>{g === "Cost" ? "Costs" : "Parameters"}</h4>
              <div className="rtc-grid rtc-grid-2">
                {SOURCE_FIELDS[id].filter((f) => f.group === g).map((f) => (
                  (f.profileOnly && (id === "solar" ? state.solarUpload : state.windUpload)) ? null
                    : <InputField key={f.key} f={f} value={s[f.key]} onChange={(v) => setSrc({ [f.key]: v })} />
                ))}
              </div>
            </div>
          ))}
          {(id === "solar" || id === "wind") && (
            <details className="bid-profile">
              <summary>Hourly profile: {(id === "solar" ? state.solarUpload : state.windUpload)?.name || "a typical Indian profile shape"}, scaled to your CUF</summary>
              <p className="rtc-note">The CUF you enter sets the energy; the profile sets its hour-by-hour shape. Pick or upload your site's 8,760-hour profile for the real shape.</p>
              <ProfileLibrary kind={id} state={shim} set={set} lockProps={lockProps} isLocked={isLocked} color={SOURCE_COLORS[id]} user={user} />
            </details>
          )}
          {id === "hydro" && (
            <details className="bid-profile">
              <summary>Monthly CUF (optional){Array.isArray(s.monthlyCuf) ? ": entered" : ": not entered, the annual CUF is the limit for the year"}</summary>
              <div className="bid-months">
                {E.MONTHS.map((m, i) => (
                  <Field key={m} label={m} pct value={s.monthlyCuf?.[i] ?? null} min={0} max={100} step={1}
                    onChange={(v) => setSrc({ monthlyCuf: Array.from({ length: 12 }, (_, k) => (k === i ? v : (s.monthlyCuf?.[k] ?? null))) })} />
                ))}
              </div>
              <button type="button" className="secondary" onClick={() => setSrc({ monthlyCuf: null })}>Clear the monthly CUF</button>
            </details>
          )}
          {issues.length > 0 && <ul className="bid-warnings">{issues.map((m) => <li key={m}><TriangleAlert size={12} /> {m}</li>)}</ul>}
        </div>
      )}
    </div>
  );
}

/** Step 3: the sources the bidder has, each with its capacity, parameters and costs, and the financing. */
export default function SourcesStep({ state, setState, terms, set, lockProps, isLocked, user, prices, goto, startSizing }) {
  const missing = missingInputs(state, terms);
  const total = plantMw(state, terms);
  const saleAllowed = terms.sale && terms.sale !== "not_allowed";
  const setMarket = (values) => setState((s) => ({ ...s, market: { ...s.market, ...values }, lp: null }));
  return (
    <>
      <Section index="3" title="Supply sources" note={`Switch on the sources you have; every value is yours${total ? ` · sizing for ${nf(total, 0)} MW` : ""}`}>
        <div className="bid-sources">
          {SOURCES.map((src) => <SourceCard key={src.id} id={src.id} state={state} setState={setState} terms={terms} set={set} lockProps={lockProps} isLocked={isLocked} user={user} />)}
        </div>
      </Section>

      {saleAllowed && (
        <Section index="3.1" title="Sale in the market" note={terms.sale === "mandated_solar" ? "The tender lets the mandated solar be scheduled in the market" : "The tender allows sales outside the PPA"}>
          <p className="rtc-note">{terms.provenance["market.sale"]?.display} <SourceChip source={terms.provenance["market.sale"]} compact /> The PPA is supplied first in every hour; only what it cannot take is sold.</p>
          <div className="rtc-grid rtc-grid-3">
            <div className="rtc-field" data-testid="bid-sell">
              <div className="rtc-field-top"><span>Sell {terms.sale === "mandated_solar" ? "solar surplus" : "surplus"} in the market?</span></div>
              <div className="bid-choice">
                <button type="button" className={state.market.sell === true ? "active" : ""} onClick={() => setMarket({ sell: true })}>Yes</button>
                <button type="button" className={state.market.sell === false ? "active" : ""} onClick={() => setMarket({ sell: false })}>No</button>
              </div>
            </div>
            {state.market.sell && (
              <SelectBox label="Sold at" value={state.market.source} onChange={(v) => setMarket({ source: v })}
                options={[...MARKETS.map((m) => [m, prices?.markets?.[m] ? `IEX ${m} · hourly, avg ₹${nf(prices.markets[m].meanRsPerMwh / 1000, 2)}/kWh` : `IEX ${m} · hourly`]), ["flat", "A flat price"]]}
                hint={state.market.source === "flat" ? "One price for every hour" : "IEX market-clearing prices, hour by hour"} />
            )}
            {state.market.sell && (state.market.source === "flat"
              ? <Field label="Flat sale price" unit="₹/kWh" value={state.market.flatPrice} onChange={(v) => setMarket({ flatPrice: v })} step={0.05} min={0} />
              : <Field label="Market price escalation" pct value={state.market.escalation} onChange={(v) => setMarket({ escalation: v })} step={0.25} min={-5} max={10} hint="per year, on the hourly prices" />)}
          </div>
          {state.market.sell && state.market.source !== "flat" && <MarketProfile prices={prices} market={state.market.source} />}
        </Section>
      )}

      <Section index="3.2" title="Financing and project costs" note="Your terms; they set the tariff the optimizer minimises">
        <div className="rtc-grid rtc-grid-4" data-testid="bid-financing">
          {FINANCE_FIELDS.map((f) => (
            <Field key={`${f.section}.${f.key}`} label={f.label} unit={f.unit === "%" ? undefined : f.unit} pct={Boolean(f.pct)} value={state[f.section][f.key]}
              onChange={(v) => setState((s) => ({ ...s, [f.section]: { ...s[f.section], [f.key]: v }, lp: null }))} step={f.step} min={f.min} max={f.max} hint={f.hint} />
          ))}
        </div>
        <p className="rtc-note">PPA term {terms.years ? `${terms.years} years (from the tender)` : "not stated"}. Repayment, depreciation, salvage and receivable days are on the Financials step.</p>
      </Section>

      <section className="optimize-bar">
        <div>
          <span className="rtc-index">3.3</span>
          <h2>{missing.length ? `${missing.length} input${missing.length > 1 ? "s" : ""} still needed` : "Ready to size"}</h2>
          {missing.length
            ? <ul className="bid-warnings" data-testid="bid-missing">{missing.slice(0, 12).map((m) => <li key={m}><TriangleAlert size={12} /> {m}</li>)}{missing.length > 12 && <li>… and {missing.length - 12} more</li>}</ul>
            : <p><CheckCircle2 size={13} /> Every source you switched on has its capacity, parameters and costs. The optimizer sizes them against the tender's requirements only.</p>}
        </div>
        <div className="optimize-bar-actions">
          <button type="button" className="primary optimize-go" disabled={missing.length > 0} onClick={() => { goto("size"); startSizing(); }} data-testid="bid-size"><Zap size={16} /> Size the plant <ArrowRight size={14} /></button>
        </div>
      </section>
    </>
  );
}
