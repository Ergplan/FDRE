import React, { useMemo, useState } from "react";
import { Download, Loader2, TriangleAlert } from "lucide-react";
import { Section, Stat, nf, pf } from "../rtc/ui";
import { LiveChart } from "../rtc/charts";
import Cite from "./Cite.jsx";
import { TENDER, TERMS, docById } from "./terms.js";
import { CHOICES, FIELDS, fmtDate, poolFlows } from "./model.js";

const LINES = [
  ["Revenue", null],
  ["CfD revenue (SP × energy supplied)", "cfdRevenue"],
  ["Market sales after the term", "marketSales"],
  ["Surplus RE sold", "merchantRevenue"],
  ["RECs (your 50%)", "recRevenue"],
  ["Total revenue", "revenue"],
  ["Operating costs", null],
  ["Charging power: green market", "chargingMarket"],
  ["Charging power: group RE", "chargingGroup"],
  ["Battery O&M", "essOm"],
  ["RE O&M", "reOm"],
  ["Battery augmentation", "augmentation"],
  ["Scheduling, fees, admin", "otherFixed"],
  ["Insurance", "insurance"],
  ["Exchange fees", "pxFees"],
  ["Letter of Credit", "lcCost"],
  ["Weekly shortfall penalty", "penalty"],
  ["Total operating costs", "opex"],
  ["Results", null],
  ["EBITDA", "ebitda"],
  ["Depreciation", "depreciation"],
  ["Interest", "interest"],
  ["Profit before tax", "pbt"],
  ["Tax", "tax"],
  ["Profit after tax", "pat"],
  ["Cash flow", null],
  ["Capex", "capex"],
  ["Bank guarantees: EMD and PBG", "bgCost"],
  ["Debt drawn", "debtDraw"],
  ["CFADS", "cfads"],
  ["Debt service", "debtService"],
  ["DSCR", "dscr", "x"],
  ["Debt outstanding", "debtClosing"],
  ["Free cash to equity", "equityCf"],
];

function StackChart({ rows }) {
  const option = useMemo(() => {
    const ops = rows.slice(1);
    const s = (name, key, color, neg = false) => ({ name, type: "bar", stack: neg ? "c" : "r", data: ops.map((r) => Number(((neg ? -1 : 1) * (r[key] || 0)).toFixed(2))), itemStyle: { color } });
    return {
      animation: false,
      grid: { left: 64, right: 16, top: 34, bottom: 40 },
      legend: { top: 0, right: 0, type: "scroll" },
      tooltip: { trigger: "axis", valueFormatter: (v) => `₹${nf(v, 2)} cr` },
      xAxis: { type: "category", data: ops.map((r) => r.period) },
      yAxis: { type: "value", name: "₹ crore" },
      series: [
        s("CfD revenue", "cfdRevenue", "#a98bff"), s("Surplus RE sold", "merchantRevenue", "#f2b84b"), s("RECs", "recRevenue", "#7ddc9a"), s("After-term sales", "marketSales", "#d4ff3f"),
        s("Charging power", "chargingMarket", "#3fa7d6", true), s("Group RE", "chargingGroup", "#4fd1c5", true), s("O&M and other", "essOm", "#86867f", true), s("RE O&M", "reOm", "#5c5c57", true),
        s("Augmentation", "augmentation", "#c2c2bc", true), s("Penalties", "penalty", "#ff6b5f", true), s("Interest", "interest", "#ff8a5f", true), s("Tax", "tax", "#e0a3ff", true),
      ],
    };
  }, [rows]);
  return <LiveChart option={option} height={320} />;
}

/** The payload of the Excel workbook: cover, terms, inputs, operations and the model. */
function workbookPayload(state, model) {
  const { inputs, sim, sp, bid, fin } = model;
  const inputRows = FIELDS.map((f) => ({ group: f.section, input: f.label, value: inputs[f.key], unit: f.pct ? "%" : f.unit, source: state.filled[f.key] ? "Industry benchmark" : "Your input" }));
  for (const k of ["effectiveDate", "sellMarket", "useMarket", "useGroup", "merchant", "augmentation", "afterTerm"]) {
    inputRows.push({ group: "choice", input: CHOICES[k].label, value: String(inputs[k]), unit: "", source: state.filled[k] ? "Industry benchmark" : "Your input" });
  }
  return {
    title: `SECI CfD-I bid model: ${nf(inputs.contractedMw)} MW × 2 h assured peak supply`,
    subtitle: `Strike price to bid ₹${bid?.toFixed(2)}/kWh for a ${pf(inputs.targetEquityIrr, 2)} equity IRR · SCD ${fmtDate(sim.dates.scd)} · term to ${fmtDate(sim.dates.end)}`,
    fileName: `CfD-I_${inputs.contractedMw}MW_bid_model`,
    cover: [
      ["Strike price to bid (₹/kWh, two decimals)", bid, "tariff"],
      ["Strike price for the target IRR (exact)", sp, "tariff"],
      ["Equity IRR", fin.equityIrr, "pct"], ["Project IRR", fin.projectIrr, "pct"],
      ["Minimum DSCR", fin.minDscr, "x"], ["Average DSCR", fin.avgDscr, "x"],
      ["Levelised cost of supply (₹/kWh)", fin.levelisedCost, "tariff"],
      ["Total capex (₹ cr)", fin.capex.total, "cr"], ["of which SECI's charges with GST (₹ cr)", fin.capex.seci, "cr"], ["Letter of Credit to SECI (₹ cr)", fin.lcCr, "cr"],
      ["EMD bank guarantee (₹ cr, RfS 17)", fin.rfs.emdCr, "cr"], ["PBG (₹ cr, RfS 18.1)", fin.rfs.pbgCr, "cr"],
      ["Net worth required (₹ cr, RfS 37.1)", fin.rfs.netWorthCr, "cr"], ["Turnover required, or PBDIT, or line of credit (₹ cr, RfS 37.2)", `${nf(fin.rfs.turnoverCr, 2)} / ${nf(fin.rfs.pbditCr, 2)} / ${nf(fin.rfs.lineOfCreditCr, 2)}`],
      ["Contracted capacity (MW)", inputs.contractedMw, "mw"], ["Battery (MW)", inputs.contractedMw * inputs.essMwPerMw, "mw"], ["Battery (MWh)", inputs.contractedMw * inputs.essMwhPerMw, "mw"],
      ["Own solar (MWac)", inputs.solarMw, "mw"], ["Own wind (MW)", inputs.windMw || 0, "mw"],
      ["Effective Date", fmtDate(sim.dates.ed)], ["SCD (battery, supply starts)", fmtDate(sim.dates.scd)], ["Own RE commissioned", fmtDate(sim.dates.reCod)], ["Term ends", fmtDate(sim.dates.end)],
    ],
    terms: TERMS.map((t) => ({ group: t.group, term: t.label, says: t.display, doc: docById[t.doc].short, clause: t.clause, page: t.page, quote: t.quote, status: t.status || "" })),
    inputs: inputRows,
    operations: sim.years.map((y) => ({
      cy: y.index, start: fmtDate(y.start), days: y.days, requiredMwh: y.requiredMwh, deliveredMwh: y.deliveredMwh, shareOwn: y.shareOwn, shareMarket: y.shareMarket, shareGroup: y.shareGroup,
      chargeOwnMwh: y.chargeOwnMwh, chargeMarketMwh: y.chargeMarketMwh, chargeGroupMwh: y.chargeGroupMwh, chargingCostCr: y.marketCostCr + y.groupCostCr,
      merchantMwh: y.merchantMwh, merchantRevCr: y.merchantRevCr, curtailedMwh: y.curtailedMwh, shortDays: y.shortDays, penaltyWeeks: y.weeks.filter((w) => w.beyondMwh > 1e-6).length,
      avgMcp: y.deliveredMwh > 0 ? (y.mcpDeliveredCr * 1e4) / y.deliveredMwh : null,
    })),
    lines: LINES.filter(([, k]) => k).map(([label, key, fmt]) => ({ label, key, fmt: fmt || "cr" })),
    rows: fin.rows.map((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => typeof v === "number" || typeof v === "string" || typeof v === "boolean"))),
  };
}

/** Step 6: the strike price to bid, the returns, the CfD Pool at that price, and the statements. */
export default function FinanceStep({ state, model }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!model) return <p className="rtc-note bid-hint">Fill in Plant and sourcing and Costs to price the bid.</p>;
  if (!model.sp) return <div className="alert"><TriangleAlert size={14} /> {model.reason || "No strike price reaches the target IRR."}</div>;
  const { inputs, sim, sp, bid, fin } = model;
  const pool = poolFlows(sim, bid);
  const poolYear = pool.find((p) => p.cy === 2) || pool[0];
  const scale = TENDER.totalMw / inputs.contractedMw;
  const drain = poolYear.netCr < 0 ? (TENDER.poolCr / (-poolYear.netCr * scale)) * 12 : null;

  async function download() {
    setBusy(true);
    setError("");
    try {
      const payload = workbookPayload(state, model);
      const res = await fetch("/api/cfd/model", { method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin", body: JSON.stringify(payload) });
      if (!res.ok) {
        let msg = `Download failed (${res.status})`;
        try { msg = (await res.json()).error || msg; } catch { /* not JSON */ }
        throw new Error(msg);
      }
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = `${payload.fileName}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Section index="6" title="Strike price to bid" note={`For a ${pf(inputs.targetEquityIrr, 2)} equity IRR over the 15-year term${inputs.afterTerm === "merchant" ? ` and ${inputs.merchantYears} market years after it` : ""}`}
        actions={<button type="button" className="primary" onClick={download} disabled={busy} data-testid="cfd-download">{busy ? <Loader2 className="spin" size={14} /> : <Download size={14} />} Download financial model (Excel)</button>}>
        <div className="rtc-grid rtc-grid-4" data-testid="cfd-finance">
          <Stat label="Strike price to bid" value={`₹${bid.toFixed(2)}/kWh`} detail={`₹${nf(sp, 4)} exact, rounded up (digits after two decimals are ignored)`} />
          <Stat label="Equity IRR" value={pf(fin.equityIrr, 2)} detail={`project IRR ${pf(fin.projectIrr, 2)}`} />
          <Stat label="DSCR" value={`${nf(fin.minDscr, 2)} minimum`} detail={`${nf(fin.avgDscr, 2)} average`} tone={fin.minDscr !== null && fin.minDscr < 1.1 ? "bad" : undefined} />
          <Stat label="Levelised cost of supply" value={`₹${nf(fin.levelisedCost, 2)}/kWh`} detail={`at ${pf(inputs.discountRate, 1)}, net of surplus sales and RECs`} />
          <Stat label="Capex" value={`₹${nf(fin.capex.total, 0)} cr`} detail={`battery, line and SECI's charges ₹${nf(fin.capex.atScd, 0)} cr by the SCD; own RE ₹${nf(fin.capex.atRe, 0)} cr by ${fmtDate(sim.dates.reCod)}`} />
          <Stat label="Letter of Credit to SECI" value={`₹${nf(fin.lcCr, 2)} cr`} detail={bid >= TENDER.lcMinPrice ? "nil: the strike price is above ₹10/kWh" : "2000 × MW × (₹10 − SP) × 30"} />
          <Stat label="EMD and PBG" value={`₹${nf(fin.rfs.emdCr, 1)} cr + ₹${nf(fin.rfs.pbgCr, 1)} cr`} detail={`bank guarantees (RfS 17, 18.1); cost ₹${nf(fin.rows[0].bgCost, 2)} cr`} />
          <Stat label="Energy supplied" value={`${nf(sim.years.reduce((a, y) => a + y.deliveredMwh, 0) / 1000, 0)} GWh`} detail="over the term" />
          <Stat label="Average evening market price" value={`₹${nf(poolYear.mcpAvg, 2)}/kWh`} detail={`your 2 best hours in the ${inputs.sellMarket}, 2025–26`} />
        </div>
        {error && <div className="alert"><TriangleAlert size={14} /> {error}</div>}
      </Section>
      <Section index="6.1" title="The CfD Pool at your strike price" note="Your payment security is the Pool itself">
        <div className={`bid-mode ${poolYear.netCr < 0 ? "rules" : ""}`} data-testid="cfd-pool">
          <TriangleAlert size={14} />
          <span>
            At ₹{bid.toFixed(2)}/kWh and 2025–26 prices (₹{nf(poolYear.mcpAvg, 2)}/kWh in your best 2 evening hours), your project {poolYear.netCr < 0 ? "draws" : "pays into"} the Pool <strong>₹{nf(Math.abs(poolYear.netCr), 1)} crore a year</strong>.
            {drain
              ? ` If all ${TENDER.totalMw} MW were awarded at this price, the ₹${TENDER.poolCr} crore Pool would last about ${nf(drain, 0)} months before payments to developers depend on new inflows.`
              : ` If all ${TENDER.totalMw} MW were awarded at this price, the Pool would grow by about ₹${nf(poolYear.netCr * scale, 0)} crore a year.`}
            {" "}SECI's obligation is limited to the settlement and the Pool is the payment security <Cite id="poolSecurity" /> <Cite id="seciLimited" />.
          </span>
        </div>
      </Section>
      <Section index="6.2" title="Revenue and costs by year" note="₹ crore">
        <StackChart rows={fin.rows} />
      </Section>
      <Section index="6.3" title="Financial model" note="Construction, then each Contract Year (April–March); ₹ crore">
        <div className="cfd-statements" data-testid="cfd-statements">
          <table>
            <thead><tr><th>₹ crore</th>{fin.rows.map((r) => <th key={r.period}>{r.period}</th>)}</tr></thead>
            <tbody>
              {LINES.map(([label, key, fmt]) => (key
                ? <tr key={label} className={/^(Total|EBITDA|Profit after tax|CFADS|Free cash)/.test(label) ? "strong" : ""}><td>{label}</td>{fin.rows.map((r, i) => <td key={i}>{r[key] === undefined || r[key] === null ? "" : fmt === "x" ? nf(r[key], 2) : nf(r[key], 2)}</td>)}</tr>
                : <tr key={label} className="band"><td colSpan={fin.rows.length + 1}>{label}</td></tr>))}
            </tbody>
          </table>
        </div>
      </Section>
    </>
  );
}

export { workbookPayload };
