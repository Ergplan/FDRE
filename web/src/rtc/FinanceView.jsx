import React, { useMemo } from "react";
import { Download } from "lucide-react";
import { LiveChart } from "./charts";
import { DATA_COLORS } from "../chartTheme";
import { Field, SelectBox, Section, Stat, SwitchBox, downloadText, nf, pf } from "./ui";

// ---------------------------------------------------------------- 06 financial model

const FIN_LINES = [
  ["Operations", null],
  ["Demand (MU)", "demandMu", 1],
  ["Delivered (MU)", "deliveredMu", 1],
  ["DFR", "dfr", "pct"],
  ["Surplus sold (MU)", "excessMu", 1],
  ["Curtailed (MU)", "curtailMu", 1],
  ["Shortfall vs target (MU)", "shortfallMu", 1],
  ["Solar output factor", "solarFactor", "pct"],
  ["BESS capacity factor", "bessFactor", "pct"],
  ["Tariff (₹/kWh)", "tariff", 3],
  ["Profit & loss (₹ cr)", null],
  ["Energy revenue", "energyRevenue", 1],
  ["Surplus revenue", "surplusRevenue", 1],
  ["Shortfall penalty", "penalty", 1, -1],
  ["Total revenue", "revenue", 1, 1, true],
  ["O&M", "om", 1, -1],
  ["Insurance", "insurance", 1, -1],
  ["Other fixed", "other", 1, -1],
  ["EBITDA", "ebitda", 1, 1, true],
  ["Book depreciation", "bookDep", 1, -1],
  ["Interest", "interest", 1, -1],
  ["Profit before tax", "pbt", 1, 1, true],
  ["Tax depreciation", "taxDep", 1],
  ["Tax", "tax", 1, -1],
  ["Profit after tax", "pat", 1, 1, true],
  ["Cash flow (₹ cr)", null],
  ["EBITDA", "ebitda", 1],
  ["Tax paid", "tax", 1, -1],
  ["Working capital change", "dWc", 1, -1],
  ["BESS augmentation", "augCapex", 1, -1],
  ["CFADS", "cfads", 1, 1, true],
  ["Debt service", "debtService", 1, -1],
  ["Free cash to equity", "fcfe", 1, 1, true],
  ["Cumulative equity cash", "cumEquity", 1],
  ["Project cash flow (unlevered)", "projectCf", 1],
  ["Debt (₹ cr)", null],
  ["Opening balance", "openingDebt", 1],
  ["Interest", "interest", 1],
  ["Principal", "principal", 1],
  ["Closing balance", "closingDebt", 1],
  ["DSCR", "dscr", 2],
];

export default function FinanceView({ state, patch, set, lockProps, finance, sizes }) {
  const { fin } = state;
  const rows = finance.rows;
  const years = rows.map((r) => `Y${r.year}`);
  const plOption = useMemo(() => ({
    animation: false,
    grid: { left: 60, right: 56, top: 36, bottom: 64 },
    legend: { top: 0, right: 0 },
    tooltip: { trigger: "axis" },
    xAxis: { type: "category", data: years },
    yAxis: [{ type: "value", name: "₹ cr" }, { type: "value", name: "DSCR", splitLine: { show: false }, min: 0 }],
    dataZoom: [{ type: "inside" }, { type: "slider", bottom: 10, height: 18 }],
    series: [
      { name: "Revenue", type: "bar", data: rows.map((r) => Number(r.revenue.toFixed(1))), itemStyle: { color: "#3a3a3a" } },
      { name: "EBITDA", type: "bar", data: rows.map((r) => Number(r.ebitda.toFixed(1))), itemStyle: { color: DATA_COLORS.wind } },
      { name: "PAT", type: "bar", data: rows.map((r) => Number(r.pat.toFixed(1))), itemStyle: { color: DATA_COLORS.surplus } },
      { name: "Debt service", type: "line", data: rows.map((r) => Number(r.debtService.toFixed(1))), lineStyle: { color: DATA_COLORS.solar }, itemStyle: { color: DATA_COLORS.solar } },
      { name: "DSCR", type: "line", yAxisIndex: 1, data: rows.map((r) => (r.dscr === null ? null : Number(r.dscr.toFixed(2)))), lineStyle: { color: DATA_COLORS.demand, type: "dashed" }, itemStyle: { color: DATA_COLORS.demand } },
    ],
  }), [rows]);
  const cashOption = useMemo(() => ({
    animation: false,
    grid: { left: 60, right: 56, top: 36, bottom: 30 },
    legend: { top: 0, right: 0 },
    tooltip: { trigger: "axis" },
    xAxis: { type: "category", data: ["Y0", ...years] },
    yAxis: [{ type: "value", name: "₹ cr" }, { type: "value", name: "DFR %", min: 0, max: 100, splitLine: { show: false } }],
    series: [
      { name: "Closing debt", type: "line", data: [finance.debt, ...rows.map((r) => r.closingDebt)].map((v) => Number(v.toFixed(1))), areaStyle: { color: "rgba(245,184,61,0.10)" }, lineStyle: { color: DATA_COLORS.solar }, itemStyle: { color: DATA_COLORS.solar } },
      { name: "Cumulative equity cash", type: "line", data: [-finance.equity, ...rows.map((r) => r.cumEquity)].map((v) => Number(v.toFixed(1))), lineStyle: { color: DATA_COLORS.surplus }, itemStyle: { color: DATA_COLORS.surplus } },
      { name: "DFR", type: "line", yAxisIndex: 1, data: [null, ...rows.map((r) => Number((r.dfr * 100).toFixed(2)))], lineStyle: { color: DATA_COLORS.demand, type: "dashed" }, itemStyle: { color: DATA_COLORS.demand } },
    ],
  }), [rows, finance.debt, finance.equity]);

  function exportCsv() {
    const head = ["Line item", "Y0", ...years];
    const lines = [head.join(",")];
    const y0 = { "Free cash to equity": -finance.equity, "Project cash flow (unlevered)": -finance.capex.total, "Closing balance": finance.debt };
    for (const [label, key] of FIN_LINES) {
      if (!key) { lines.push(`"${label}"`); continue; }
      lines.push([`"${label}"`, y0[label] ?? "", ...rows.map((r) => (r[key] === null ? "" : Number(r[key]).toFixed(4)))].join(","));
    }
    lines.push("");
    lines.push(`"Solar MW",${sizes.solarMw}`, `"Wind MW",${sizes.windMw}`, `"BESS MW",${sizes.bessMw}`, `"BESS MWh",${sizes.bessMwh}`);
    lines.push(`"Project cost cr",${finance.capex.total.toFixed(2)}`, `"Tariff Rs/kWh",${finance.tariff.toFixed(4)}`, `"Equity IRR",${finance.equityIrr.toFixed(5)}`, `"Project IRR",${finance.projectIrr.toFixed(5)}`);
    downloadText("rtc_financial_model_25y.csv", lines.join("\n"));
  }

  const fmtCell = (v, fmt, sign = 1) => {
    if (v === null || v === undefined) return "–";
    if (fmt === "pct") return pf(v, 1);
    const n = Number(v) * (sign === -1 && Number(v) !== 0 ? -1 : 1);
    return n < 0 ? `(${nf(Math.abs(n), fmt)})` : nf(n, fmt);
  };

  return (
    <>
      <section className="rtc-stats">
        <Stat label={finance.tariffLocked ? "Tariff (fixed)" : "Tariff for target IRR"} value={`₹${nf(finance.tariff, 3)}`} detail={fin.tariffEscalation ? `levelised ₹${nf(finance.levelisedTariff, 3)}` : "flat, ₹/kWh"} />
        <Stat label="LCOE" value={`₹${nf(finance.lcoe, 3)}`} detail={`@ ${pf(fin.discountRate, 1)} discount`} />
        <Stat label="Equity IRR" value={pf(finance.equityIrr, 2)} detail={`NPV @ target ₹${nf(finance.equityNpv, 0)} cr`} tone={finance.equityIrr >= fin.targetEquityIrr - 1e-4 ? "good" : "bad"} />
        <Stat label="Project IRR" value={pf(finance.projectIrr, 2)} detail="post-tax, unlevered" />
        <Stat label="DSCR min / avg" value={`${nf(finance.minDscr, 2)} / ${nf(finance.avgDscr, 2)}`} detail={`${fin.tenorYears}-yr ${fin.repayment === "annuity" ? "annuity" : "equal principal"}`} tone={finance.minDscr !== null && finance.minDscr < 1.1 ? "bad" : undefined} />
        <Stat label="Equity payback" value={finance.payback ? `Year ${finance.payback}` : "–"} detail={`equity ₹${nf(finance.equity, 0)} cr · debt ₹${nf(finance.debt, 0)} cr`} />
      </section>

      <Section index="F.1" title="Assumptions" note="Unlock the tariff to solve it for the target equity IRR; lock it to compute returns at a fixed tariff">
        <div className="rtc-subhead">Tariff & returns</div>
        <div className="rtc-grid rtc-grid-4">
          <Field label="Tariff" unit="₹/kWh" value={finance.tariffLocked ? fin.tariff : finance.tariff} onChange={(v) => patch("fin", { tariff: v })} locked={state.tariffLocked} onLock={() => { if (!state.tariffLocked) patch("fin", { tariff: Number(finance.tariff.toFixed(3)) }); set("tariffLocked", !state.tariffLocked); }} disabled={!state.tariffLocked} lockDisables={false} step={0.01} min={0} hint={state.tariffLocked ? "Fixed: IRR is computed" : "Solved for the target IRR"} />
          <Field label="Target equity IRR" pct value={fin.targetEquityIrr} onChange={(v) => patch("fin", { targetEquityIrr: v })} {...lockProps("fin.targetEquityIrr")} disabled={state.tariffLocked} step={0.25} min={0} max={40} />
          <Field label="Tariff escalation" pct value={fin.tariffEscalation} onChange={(v) => patch("fin", { tariffEscalation: v })} {...lockProps("fin.tariffEscalation")} step={0.1} min={0} max={10} hint="per year" />
          <Field label="Discount rate (LCOE / NPV)" pct value={fin.discountRate} onChange={(v) => patch("fin", { discountRate: v })} {...lockProps("fin.discountRate")} step={0.25} min={0} max={30} />
          <Field label="PPA term" unit="years" value={fin.years} onChange={(v) => patch("fin", { years: Math.max(5, Math.min(35, Math.round(v))) })} {...lockProps("fin.years")} step={1} min={5} max={35} />
          <SwitchBox label="Sell surplus energy" checked={fin.sellSurplus} onChange={(v) => patch("fin", { sellSurplus: v })} {...lockProps("fin.sellSurplus")} />
          <Field label="Surplus price" unit="₹/kWh" value={fin.surplusPrice} onChange={(v) => patch("fin", { surplusPrice: v })} {...lockProps("fin.surplusPrice")} disabled={!fin.sellSurplus} step={0.05} min={0} />
          <Field label="Shortfall penalty" unit="₹/kWh" value={fin.shortfallPenalty} onChange={(v) => patch("fin", { shortfallPenalty: v })} {...lockProps("fin.shortfallPenalty")} step={0.05} min={0} hint="on energy below DFR × demand" />
        </div>
        <div className="rtc-subhead">Financing</div>
        <div className="rtc-grid rtc-grid-4">
          <Field label="Debt share" pct value={fin.debtFraction} onChange={(v) => patch("fin", { debtFraction: v })} {...lockProps("fin.debtFraction")} step={1} min={0} max={95} />
          <Field label="Interest rate" pct value={fin.interestRate} onChange={(v) => patch("fin", { interestRate: v })} {...lockProps("fin.interestRate")} step={0.05} min={0} max={25} />
          <Field label="Loan tenor" unit="years" value={fin.tenorYears} onChange={(v) => patch("fin", { tenorYears: Math.max(1, Math.round(v)) })} {...lockProps("fin.tenorYears")} step={1} min={1} max={25} />
          <SelectBox label="Repayment" value={fin.repayment} onChange={(v) => patch("fin", { repayment: v })} {...lockProps("fin.repayment")} options={[["equal", "Equal principal"], ["annuity", "Annuity (level debt service)"]]} />
          <Field label="Receivable days" unit="days" value={fin.receivableDays} onChange={(v) => patch("fin", { receivableDays: v })} {...lockProps("fin.receivableDays")} step={5} min={0} max={180} />
        </div>
        <div className="rtc-subhead">Tax & depreciation</div>
        <div className="rtc-grid rtc-grid-4">
          <Field label="Corporate tax" pct value={fin.taxRate} onChange={(v) => patch("fin", { taxRate: v })} {...lockProps("fin.taxRate")} step={0.01} min={0} max={50} digits={5} />
          <SelectBox label="Tax depreciation" value={fin.taxDepreciation} onChange={(v) => patch("fin", { taxDepreciation: v })} {...lockProps("fin.taxDepreciation")} options={[["wdv", "WDV"], ["slm", "Straight line (= book)"]]} />
          <Field label="WDV rate" pct value={fin.wdvRate} onChange={(v) => patch("fin", { wdvRate: v })} {...lockProps("fin.wdvRate")} disabled={fin.taxDepreciation !== "wdv"} step={1} min={0} max={100} />
          <Field label="Book life" unit="years" value={fin.bookLifeYears} onChange={(v) => patch("fin", { bookLifeYears: Math.max(1, Math.round(v)) })} {...lockProps("fin.bookLifeYears")} step={1} min={1} max={40} />
          <Field label="Salvage value" pct value={fin.salvagePct} onChange={(v) => patch("fin", { salvagePct: v })} {...lockProps("fin.salvagePct")} step={1} min={0} max={30} />
        </div>
        <div className="rtc-subhead">Project costs & operations</div>
        <div className="rtc-grid rtc-grid-4">
          <Field label="Evacuation / pooling" unit="₹ cr" value={state.costs.evacuationCr} onChange={(v) => patch("costs", { evacuationCr: v })} {...lockProps("costs.evacuationCr")} step={5} min={0} hint="Lump sum" />
          <Field label="Pre-operative & IDC" pct value={state.costs.preopPct} onChange={(v) => patch("costs", { preopPct: v })} {...lockProps("costs.preopPct")} step={0.5} min={0} max={30} hint="of hard cost" />
          <Field label="O&M escalation" pct value={fin.omEscalation} onChange={(v) => patch("fin", { omEscalation: v })} {...lockProps("fin.omEscalation")} step={0.25} min={0} max={15} hint="Solar, wind and BESS O&M are set in their chapters" />
          <Field label="Insurance" pct value={fin.insurancePct} onChange={(v) => patch("fin", { insurancePct: v })} {...lockProps("fin.insurancePct")} step={0.05} min={0} max={3} hint="of hard cost / yr" />
          <Field label="Other fixed cost" unit="₹ cr/yr" value={fin.otherFixedCr} onChange={(v) => patch("fin", { otherFixedCr: v })} {...lockProps("fin.otherFixedCr")} step={0.5} min={0} hint="Land lease, SLDC, overheads" />
        </div>
      </Section>

      <div className="rtc-grid rtc-grid-2 rtc-flush">
        <Section index="F.2" title="Earnings & coverage">
          <LiveChart option={plOption} height={330} />
        </Section>
        <Section index="F.3" title="Debt, equity cash & DFR">
          <LiveChart option={cashOption} height={330} />
        </Section>
      </div>

      <Section index="F.4" title={`${fin.years}-year financial model`} note={`Project cost ₹${nf(finance.capex.total, 1)} cr (hard ₹${nf(finance.capex.hard, 1)} + pre-op ₹${nf(finance.capex.preop, 1)})`} actions={<button type="button" className="secondary" onClick={exportCsv}><Download size={14} /> Export CSV</button>}>
        <div className="table-wrap rtc-model">
          <table>
            <thead>
              <tr><th>Line item</th><th>Y0</th>{years.map((y) => <th key={y}>{y}</th>)}</tr>
            </thead>
            <tbody>
              {FIN_LINES.map(([label, key, fmt, sign, strong], i) => {
                if (!key) return <tr key={i} className="rtc-model-group"><td colSpan={years.length + 2}>{label}</td></tr>;
                const y0 = label === "Free cash to equity" ? -finance.equity : label === "Project cash flow (unlevered)" ? -finance.capex.total : label === "Closing balance" ? finance.debt : null;
                return (
                  <tr key={i} className={strong ? "rtc-model-total" : ""}>
                    <td>{label}</td>
                    <td>{y0 === null ? "" : fmtCell(y0, fmt)}</td>
                    {rows.map((r) => <td key={r.year}>{fmtCell(r[key], fmt, sign)}</td>)}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>
    </>
  );
}

