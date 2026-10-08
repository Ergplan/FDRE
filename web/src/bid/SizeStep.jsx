import React, { useMemo, useState } from "react";
import { CheckCircle2, Loader2, Square, TriangleAlert, XCircle, Zap } from "lucide-react";
import * as E from "../rtc/engine";
import { LiveChart } from "../rtc/charts";
import { DATA_COLORS } from "../chartTheme";
import { Section, Stat, nf, pf } from "../rtc/ui";
import { SIZE_KEY, SOURCES, anyHours, energyMix, marketLabel, peakHours, plantMw, sizesAtMax } from "./model";
import { SOURCE_COLORS } from "./SourcesStep";
import Checklist, { BidderInputs } from "./Checklist";
import Dispatch15 from "./Dispatch15";

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

const DISPATCHABLE = ["biomass", "thermal", "hydro"];

/**
 * A week of the year-1 hourly dispatch. The stacked areas are the supply to the PPA, split by
 * source (direct delivery shared by each source's output that hour, plus battery discharge) with
 * market sales on top; the dashed lines are what biomass, thermal and hydro actually generated
 * (their output also charges the battery). The tooltip gives the hour's full balance.
 */
function DispatchWeek({ hourly, peak, market, peakAny, sizes }) {
  const [week, setWeek] = useState(0);
  const option = useMemo(() => {
    if (!hourly) return null;
    const start = week * 168;
    const end = Math.min(E.HOURS, start + 168);
    const idx = Array.from({ length: end - start }, (_, i) => start + i);
    const gens = ["solar", "wind", "hydro", "biomass", "thermal"].filter((k) => hourly[k]);
    const title = (k) => SOURCES.find((x) => x.id === k)?.title || k;
    const split = (key) => idx.map((t) => {
      const g = gens.reduce((a, k) => a + hourly[k][t], 0);
      return g > 0 ? Number(((hourly.direct[t] * hourly[key][t]) / g).toFixed(2)) : 0;
    });
    const labels = idx.map((t) => `${E.MONTHS[E.MONTH_OF_HOUR[t]]} ${String(E.HOUR_OF_DAY[t]).padStart(2, "0")}h`);
    const ph = new Set(peakAny ? (peak.windows?.length ? anyHours(peak) : []) : peakHours(peak));
    const areas = [];
    idx.forEach((t, i) => {
      if (ph.has(E.HOUR_OF_DAY[t]) && (i === 0 || !ph.has(E.HOUR_OF_DAY[idx[i - 1]]))) {
        let j = i;
        while (j + 1 < idx.length && ph.has(E.HOUR_OF_DAY[idx[j + 1]])) j += 1;
        areas.push([{ xAxis: labels[i] }, { xAxis: labels[j] }]);
      }
    });
    const stack = (name, data, color) => ({ name, type: "line", stack: "supply", areaStyle: { color, opacity: 0.75 }, lineStyle: { width: 0 }, symbol: "none", itemStyle: { color }, data });
    const dispatchable = gens.filter((k) => DISPATCHABLE.includes(k));
    const row = (label, value, note = "") => `<div style="display:flex;gap:14px;justify-content:space-between"><span>${label}</span><b>${nf(value, 0)} MW${note ? ` <span style="font-weight:400;opacity:.7">${note}</span>` : ""}</b></div>`;
    const head = (text) => `<div style="margin-top:6px;opacity:.6;font-size:11px;text-transform:uppercase;letter-spacing:.08em">${text}</div>`;
    const tooltip = (params) => {
      const t = idx[params[0]?.dataIndex ?? 0];
      if (t === undefined) return "";
      const parts = [`<b>${labels[t - start]}</b>`, head("Output")];
      for (const k of gens) {
        const mw = sizes?.[SIZE_KEY[k]] || 0;
        parts.push(row(title(k), hourly[k][t], DISPATCHABLE.includes(k) && mw > 0 ? `${pf(hourly[k][t] / mw, 0)} of ${nf(mw, 0)} MW` : ""));
      }
      parts.push(head("Uses"));
      parts.push(row("To the PPA directly", hourly.direct[t]));
      parts.push(row("Battery charging", hourly.charge[t]));
      if (hourly.export[t] > 0.5) parts.push(row(market ? `Sold on IEX ${market}` : "Sold", hourly.export[t]));
      parts.push(row("Curtailed", hourly.curtail[t]));
      parts.push(head("Supply to the PPA"));
      parts.push(row("Battery discharging", hourly.discharge[t], hourly.soc ? `state of charge ${pf(hourly.soc[t], 0)}` : ""));
      parts.push(row("Delivered", hourly.direct[t] + hourly.discharge[t], `contracted ${nf(hourly.demand[t], 0)} MW`));
      return parts.join("");
    };
    return {
      animation: false,
      grid: { left: 56, right: 16, top: 34, bottom: 46 },
      legend: { top: 0, right: 0 },
      tooltip: { trigger: "axis", formatter: tooltip },
      xAxis: { type: "category", data: labels, axisLabel: { interval: 23 } },
      yAxis: [{ type: "value", name: "MW" }, { type: "value", name: "₹/kWh", min: 0, splitLine: { show: false }, show: Boolean(hourly.price) }],
      series: [
        { ...stack(`${title("solar")} to PPA`, split("solar"), DATA_COLORS.solar), markArea: { silent: true, itemStyle: { color: "rgba(212,255,63,0.06)" }, data: areas } },
        ...gens.filter((k) => k !== "solar").map((k) => stack(`${title(k)} to PPA`, split(k), SOURCE_COLORS[k])),
        stack("Battery to PPA", idx.map((t) => hourly.discharge[t]), DATA_COLORS.bess),
        stack(market ? `Sold on IEX ${market}` : "Sold as surplus", idx.map((t) => hourly.export[t]), DATA_COLORS.surplus),
        ...dispatchable.map((k) => ({ name: `${title(k)} output`, type: "line", symbol: "none", data: idx.map((t) => hourly[k][t]), lineStyle: { color: SOURCE_COLORS[k], type: "dashed", width: 1.6 }, itemStyle: { color: SOURCE_COLORS[k] } })),
        ...(hourly.price ? [{ name: `IEX ${market} price`, type: "line", yAxisIndex: 1, symbol: "none", data: idx.map((t) => hourly.price[t]), lineStyle: { color: "#f2b84b", width: 1.2 }, itemStyle: { color: "#f2b84b" } }] : []),
        { name: "Charging", type: "bar", data: idx.map((t) => -hourly.charge[t]), itemStyle: { color: "rgba(169,139,255,0.45)" }, barWidth: "90%" },
        { name: "Contracted supply", type: "line", step: "middle", data: idx.map((t) => hourly.demand[t]), lineStyle: { color: "#f4f4f1", type: "dashed", width: 1 }, itemStyle: { color: "#f4f4f1" }, symbol: "none" },
      ],
    };
  }, [hourly, week, peak, market, peakAny, sizes]);
  if (!hourly) return <p className="rtc-note">Run the sizing again to see the hour-by-hour dispatch (it is not kept when the page reloads).</p>;
  return (
    <div className="rtc-card">
      <div className="rtc-card-head">
        <span>Year-1 dispatch · week {week + 1}{peakAny ? "" : " · peak window shaded"} · areas: supply to the PPA by source · dashed: plant output</span>
        <input type="range" min="0" max="51" value={week} onChange={(e) => setWeek(Number(e.target.value))} aria-label="Week of the year" />
      </div>
      <LiveChart option={option} height={300} />
    </div>
  );
}

/** Largest hour-to-hour change and the average daily swing (max − min) of a plant's output, as shares of its capacity. */
function rampStats(series, mw) {
  let maxStep = 0;
  for (let t = 1; t < series.length; t += 1) maxStep = Math.max(maxStep, Math.abs(series[t] - series[t - 1]) / mw);
  let swing = 0;
  const days = Math.floor(series.length / 24);
  for (let d = 0; d < days; d += 1) {
    const day = series.slice(d * 24, d * 24 + 24);
    swing += (Math.max(...day) - Math.min(...day)) / mw;
  }
  return { maxStep, swing: days ? swing / days : 0 };
}

/** Step 4: the least-tariff plant from the bidder's sources that meets every tender requirement. */
export default function SizeStep({ state, terms, run, startSizing, stopSizing, startDispatch15, hourly, goto, prices, missing }) {
  const lp = state.lp;
  const mix = useMemo(() => energyMix(hourly), [hourly]);
  const running = Boolean(run?.active);
  const atMax = lp ? sizesAtMax(lp, state, terms) : [];
  const total = plantMw(state, terms);
  const on = SOURCES.filter((src) => state.sources[src.id]);
  return (
    <>
      <section className="optimize-bar">
        <div>
          <span className="rtc-index">4</span>
          <h2>Least-tariff plant</h2>
          <p>
            HiGHS sizes {on.map((s) => s.title.toLowerCase()).join(", ") || "nothing"} for {nf(total || 0, 0)} MW round the clock, hour by hour over the PPA years, so that
            {" "}{terms.rules.map((r) => `${r.label.toLowerCase()} ≥ ${pf(r.target, 0)}`).join(", ") || "no floor"}{terms.greenMin && state.sources.thermal ? ` and green share ≥ ${pf(terms.greenMin, 0)}` : ""} hold every year,
            at the lowest {terms.years || state.fin.years}-year tariff for a {pf(state.fin.targetEquityIrr || 0, 1)} equity IRR.
            {state.market.sell ? ` ${terms.sale === "mandated_solar" ? "Solar surplus" : "Surplus"} is sold at ${marketLabel(state, prices)} after the PPA.` : " Nothing is sold outside the PPA."}
          </p>
          {missing.length > 0 && <ul className="bid-warnings">{missing.slice(0, 6).map((m) => <li key={m}><TriangleAlert size={12} /> {m}</li>)}</ul>}
        </div>
        <div className="optimize-bar-actions">
          {running
            ? <button type="button" className="secondary" onClick={stopSizing}><Square size={14} /> Stop</button>
            : <button type="button" className="primary optimize-go" onClick={startSizing} disabled={missing.length > 0} data-testid="bid-size-again"><Zap size={16} /> {lp ? "Size again" : "Size the plant"}</button>}
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
              <TriangleAlert size={14} /> {atMax.map((k) => SOURCES.find((x) => x.id === k).title).join(", ")} ended at the largest capacity you allowed: the optimizer would build more. Raise the limit on Supply sources if more is available.
            </div>
          )}
          <Section index="4.1" title="Plant" note={`HiGHS · ${lp.status} · ${nf(lp.seconds, 0)} s · years modelled ${lp.years.join(", ")}`}
            actions={<button type="button" className="primary" onClick={() => goto("finance")}>Financials <Zap size={14} /></button>}>
            <div className="rtc-grid rtc-grid-4 bid-sizes" data-testid="bid-sizes">
              {on.filter((s) => s.id !== "bess").map((s) => {
                const mw = Math.max(0, lp.sizes[SIZE_KEY[s.id]] || 0);
                const mu = lp.perYear?.[0]?.[`${s.id}Mu`];
                const ramp = hourly?.[s.id] && mw > 0.5 && ["biomass", "thermal"].includes(s.id) ? rampStats(hourly[s.id], mw) : null;
                return <Stat key={s.id} label={s.title} value={`${nf(mw, 0)} MW`} detail={[`${nf(mw / (total || 1), 2)} × contracted`, mu !== undefined ? `${nf(mu, 0)} MU in year 1` : null,
                  ramp ? `largest hourly change ${nf(ramp.maxStep * 100, 0)}% · daily swing ${nf(ramp.swing * 100, 0)}%` : null].filter(Boolean).join(" · ")} />;
              })}
              {state.sources.bess && <Stat label="Battery" value={`${nf(lp.sizes.bessMw, 0)} MW / ${nf(lp.sizes.bessMwh, 0)} MWh`} detail={lp.sizes.bessMw > 0 ? `${nf(lp.sizes.bessMwh / lp.sizes.bessMw, 1)} h` : "none"} />}
              <Stat label="25-year tariff (HiGHS)" value={`₹${nf(lp.tariff, 3)}/kWh`} detail={`no design below ₹${nf(lp.lowerBound, 3)}`} />
            </div>
            <ComplianceTable lp={lp} />
          </Section>
          <Checklist state={state} terms={terms} lp={lp} index="4.2" />
          <BidderInputs state={state} prices={prices} index="4.3" />
          <Section index="4.4" title="Year-1 energy" note="Where the contracted supply came from">
            {hourly && (
              <div className="rtc-grid rtc-grid-4">
                <Stat label="Contracted (100%)" value={`${nf(mix.demand / 1000, 0)} MU`} />
                {on.filter((s) => s.id !== "bess").map((s) => <Stat key={s.id} label={s.title} value={`${nf(Math.max(0, mix[s.id]) / 1000, 0)} MU`} detail={pf(Math.max(0, mix[s.id]) / mix.demand, 1)} />)}
                {state.sources.bess && <Stat label="Battery" value={`${nf(mix.battery / 1000, 0)} MU`} detail={pf(mix.battery / mix.demand, 1)} />}
                <Stat label="Not supplied" value={`${nf(mix.unmet / 1000, 0)} MU`} detail={pf(mix.unmet / mix.demand, 1)} />
                <Stat label={lp.market ? `Sold on IEX ${lp.market}` : "Sold in the market"} value={`${nf(mix.export / 1000, 0)} MU`}
                  detail={mix.export > 0 ? `₹${nf(lp.market ? mix.exportRevenueCr : (mix.export * (lp.flatPrice || 0)) / 1e4, 0)} cr · ₹${nf(lp.market ? (mix.exportRevenueCr * 1e4) / mix.export : lp.flatPrice, 2)}/kWh realised` : "nothing sold"} />
                <Stat label="Curtailed" value={`${nf(mix.curtail / 1000, 0)} MU`} />
              </div>
            )}
            <DispatchWeek hourly={hourly} peak={terms.peak} market={lp.market} peakAny={terms.peakAny} sizes={lp.sizes} />
          </Section>
        </>
      )}
      {lp && <Dispatch15 lp={lp} start={startDispatch15} />}
      {!lp && !running && <p className="rtc-note bid-hint">Size the plant to see the least-tariff design, the tender conditions it meets and the dispatch.</p>}
    </>
  );
}
