import React, { useState } from "react";
import { Loader2, Sparkles, Square, TriangleAlert, Wand2 } from "lucide-react";
import { Field, Section, SelectBox, nf } from "../rtc/ui";
import Cite from "./Cite.jsx";
import { BENCHMARK_NOTE, BG_YEARS, CHOICES, FIELDS, fillBenchmarks, fmtDate, keyDates, missingInputs, rfsAmounts } from "./model.js";

/** Number inputs of one section; a value filled from the benchmarks is marked until it is changed. */
function Fields({ state, setInput, section, only }) {
  const list = FIELDS.filter((f) => f.section === section && (!only || only.includes(f.key)));
  return (
    <div className="rtc-grid rtc-grid-4 cfd-fields">
      {list.map((f) => (
        <div key={f.key} className={state.filled[f.key] ? "bid-benchmark" : ""} data-testid={`cfd-in-${f.key}`}>
          <Field label={f.label} unit={f.pct ? undefined : f.unit} pct={Boolean(f.pct)} value={state.inputs[f.key]} step={f.step} min={f.min} max={f.max}
            onChange={(v) => setInput(f.key, v)} hint={[f.pct && f.unit !== "%" ? f.unit : null, state.filled[f.key] ? "benchmark" : null, f.hint].filter(Boolean).join(" · ")} />
        </div>
      ))}
    </div>
  );
}

function Choice({ state, setInput, k, yesNo = false }) {
  const c = CHOICES[k];
  const value = state.inputs[k];
  const options = yesNo ? [["", "Choose"], ["yes", "Yes"], ["no", "No"]] : [["", "Choose"], ...c.options];
  const shown = yesNo ? (value === true ? "yes" : value === false ? "no" : "") : (value ?? "");
  return (
    <div className={state.filled[k] ? "bid-benchmark" : ""} data-testid={`cfd-in-${k}`}>
      <SelectBox label={c.label} value={shown} options={options} hint={[state.filled[k] ? "benchmark" : null, c.hint].filter(Boolean).join(" · ")}
        onChange={(v) => setInput(k, yesNo ? (v === "yes" ? true : v === "no" ? false : null) : (v || null))} />
    </div>
  );
}

function FillBar({ state, setState, missing }) {
  return (
    <div className="cfd-fill-bar">
      <button type="button" className="secondary" onClick={() => setState((s) => fillBenchmarks(s))} data-testid="cfd-fill">
        <Sparkles size={14} /> Fill up for me please
      </button>
      <span className="rtc-note">Puts an industry benchmark in every empty field, marked “benchmark” ({BENCHMARK_NOTE.toLowerCase()}). Your own figures replace them.</span>
      {missing.length > 0 && <span className="cfd-missing" data-testid="cfd-missing"><TriangleAlert size={12} /> {missing.length} input{missing.length > 1 ? "s" : ""} needed</span>}
    </div>
  );
}

/** Step 3: what you build and where the energy comes from. */
export function PlantStep({ state, setState, setInput, optimise, optimising, stopOptimise }) {
  const i = state.inputs;
  const missing = missingInputs(state);
  const dates = i.effectiveDate && /^\d{4}-\d{2}-\d{2}$/.test(i.effectiveDate) ? keyDates(i.effectiveDate) : null;
  const X = i.contractedMw || 0;
  return (
    <>
      <Section index="3" title="Plant and sourcing" note="What you build and where the energy comes from">
        <FillBar state={state} setState={setState} missing={missing} />
        <h4 className="cfd-sub">Capacity and dates</h4>
        <div className="rtc-grid rtc-grid-4 cfd-fields">
          <div data-testid="cfd-in-contractedMw">
            <Field label="Contracted capacity you bid" unit="MW" value={i.contractedMw} step={1} min={50} max={150} onChange={(v) => setInput("contractedMw", v)} hint="50 to 150 MW in whole MW, one bid for your group" />
            <Cite id="capacityBid" />
          </div>
          <div className={`rtc-field ${state.filled.effectiveDate ? "bid-benchmark" : ""}`} data-testid="cfd-in-effectiveDate">
            <div className="rtc-field-top"><span>{CHOICES.effectiveDate.label}</span></div>
            <input type="date" value={i.effectiveDate || ""} onChange={(e) => setInput("effectiveDate", e.target.value || null)} />
            <small>{[state.filled.effectiveDate ? "benchmark" : null, CHOICES.effectiveDate.hint].filter(Boolean).join(" · ")}</small>
          </div>
        </div>
        {dates && (
          <div className="cfd-dates" data-testid="cfd-dates">
            <span>Letter of Award <strong>{fmtDate(dates.loa)}</strong><Cite id="effectiveDate" compact /></span>
            <span>PBG, charges, documents <strong>{fmtDate(dates.docsDue)}</strong><Cite id="docsDue" compact /></span>
            <span>Financial closure <strong>{fmtDate(dates.finClose)}</strong><Cite id="finClose" compact /></span>
            <span>SCD: battery and supply <strong>{fmtDate(dates.scd)}</strong><Cite id="essScd" compact /></span>
            <span>PBG valid to <strong>{fmtDate(dates.pbgUntil)}</strong><Cite id="pbgValidity" compact /></span>
            <span>Own RE by <strong>{fmtDate(dates.reDeadline)}</strong><Cite id="reCod" compact /></span>
            <span>Term ends <strong>{fmtDate(dates.end)}</strong><Cite id="term" compact /></span>
          </div>
        )}
        <h4 className="cfd-sub">Battery <Cite id="ess" /></h4>
        <Fields state={state} setInput={setInput} section="project" only={["essMwhPerMw", "essMwPerMw"]} />
        {X > 0 && i.essMwhPerMw && <p className="rtc-note">Battery {nf(X * (i.essMwPerMw || 1))} MW / {nf(X * i.essMwhPerMw)} MWh for {nf(X)} MW contracted.</p>}
        <Fields state={state} setInput={setInput} section="resource" only={["rte", "essDegradation"]} />
        <div className="rtc-grid rtc-grid-4 cfd-fields"><Choice state={state} setInput={setInput} k="augmentation" /></div>
        <h4 className="cfd-sub">Own RE generation <Cite id="reCod" /> <Cite id="reSize" /></h4>
        <div className="cfd-optimise">
          {optimising
            ? <button type="button" className="secondary" onClick={stopOptimise}><Square size={14} /> Stop ({optimising.done}/{optimising.total})</button>
            : <button type="button" className="primary" onClick={optimise} disabled={missing.length > 0} data-testid="cfd-optimise"><Wand2 size={14} /> Optimise own RE</button>}
          <span className="rtc-note">{optimising ? <><Loader2 className="spin" size={12} /> Trying own-RE sizes: lowest strike price with every day's supply met</> : "Finds the solar (and wind, if you have it) that gives the lowest strike price while every day's supply is met within the sourcing limits."}</span>
        </div>
        <Fields state={state} setInput={setInput} section="project" only={["solarMw", "windMw", "reCodMonths", "availability"]} />
        <Fields state={state} setInput={setInput} section="resource" only={["solarCuf", "solarDegradation", "windCuf"]} />
      </Section>
      <Section index="3.1" title="Charging power and markets" note="Within the tender's sourcing limits">
        <p className="rtc-note">All supply must be RE <Cite id="allRe" />. Up to 25% may come from the green market or bilateral deals all term <Cite id="market25" />, a further 75% for charging until month 36 <Cite id="market75" />, then a further 50% from group companies' RE <Cite id="group50" />; shares are measured on the energy discharged <Cite id="discharged" />. Green power is bought at the hourly IEX GDAM price.</p>
        <div className="rtc-grid rtc-grid-4 cfd-fields">
          <Choice state={state} setInput={setInput} k="useMarket" yesNo />
          <Choice state={state} setInput={setInput} k="useGroup" yesNo />
          <Choice state={state} setInput={setInput} k="sellMarket" />
          <Choice state={state} setInput={setInput} k="merchant" yesNo />
        </div>
        <Fields state={state} setInput={setInput} section="sourcing" />
      </Section>
    </>
  );
}

const cr = (v) => `₹${nf(v, 2)} cr`;

/** What the RfS asks of a bid for this plant: securities, SECI's charges and the eligibility tests. */
function RfsAmounts({ inputs }) {
  const a = rfsAmounts(inputs);
  const plant = `${nf(a.solarMw)} MW solar${a.windMw ? `, ${nf(a.windMw)} MW wind` : ""}, ${nf(a.essMwh)} MWh battery`;
  const rows = [
    ["EMD with the bid", cr(a.emdCr), `bank guarantee, held ~${nf(BG_YEARS.emd * 12, 0)} months`, ["emd"]],
    ["PBG after the LoA", cr(a.pbgCr), `bank guarantee, held ~${nf(BG_YEARS.pbg * 12, 0)} months`, ["pbg"]],
    ["Contract Administration Charges", cr(a.cacCr), "+ GST, within 20 days of the LoA", ["cac"]],
    ["Bid processing fee and RfS cost", cr(a.bidFeeCr + a.rfsCostCr), "+ GST, with the bid", ["bidFee", "rfsCost"]],
    ["Net worth you must show", cr(a.netWorthCr), "for the installed capacities", ["netWorth"]],
    ["Liquidity: one of", `${cr(a.turnoverCr)} turnover`, `or ${cr(a.pbditCr)} PBDIT, or a ${cr(a.lineOfCreditCr)} line of credit`, ["turnover", "pbdit", "lineOfCredit"]],
  ];
  return (
    <div className="cfd-rfs" data-testid="cfd-rfs-amounts">
      <p className="rtc-note">For {nf(inputs.contractedMw || 0)} MW contracted: {plant}. The model charges the bank guarantees at the cost above and adds SECI's charges, with GST, to the project cost.</p>
      <div className="cfd-rfs-grid">
        {rows.map(([label, value, note, cites]) => (
          <div key={label}><span>{label}</span><strong>{value}</strong><small>{note}</small><span className="cfd-rfs-cites">{cites.map((c) => <Cite key={c} id={c} />)}</span></div>
        ))}
      </div>
    </div>
  );
}

/** Step 4: capex, running costs, tender costs and financing. */
export function CostsStep({ state, setState, setInput }) {
  const missing = missingInputs(state);
  return (
    <>
      <Section index="4" title="Costs" note="Capex, running costs and the tender's own costs">
        <FillBar state={state} setState={setState} missing={missing} />
        <Fields state={state} setInput={setInput} section="costs" />
        <p className="rtc-note">Exchange fees <Cite id="pxCharges" />, transmission to the Delivery Point <Cite id="ists" /> <Cite id="lineCost" />, the Letter of Credit <Cite id="lc" />, the bank guarantees and SECI's charges are yours. Augmentation replaces the battery's degraded MWh each year at the battery price, falling by the rate above.</p>
      </Section>
      <Section index="4.1" title="What the RfS asks of this bid" note="From the RfS formulas, on your contracted MW and installed capacities">
        <RfsAmounts inputs={state.inputs} />
      </Section>
      <Section index="4.2" title="Financing" note="The strike price is solved for your target equity IRR">
        <Fields state={state} setInput={setInput} section="fin" />
        <div className="rtc-grid rtc-grid-4 cfd-fields">
          <Choice state={state} setInput={setInput} k="afterTerm" />
          {state.inputs.afterTerm === "merchant" && (
            <div data-testid="cfd-in-merchantYears">
              <Field label="Years of market sales after the term" unit="years" value={state.inputs.merchantYears} step={1} min={0} max={15} onChange={(v) => setInput("merchantYears", v)}
                hint="The CfD ends with the term; you may operate on" />
              <Cite id="afterExpiry" />
            </div>
          )}
        </div>
      </Section>
    </>
  );
}
