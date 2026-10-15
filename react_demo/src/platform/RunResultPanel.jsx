// Results of the platform's run kinds (bid_tariff, fixed_tariff, milp_dispatch): status and
// classification, tariff, finance summary and statement, contract-term table with the years
// actually solved, binding constraints, sensitivities, certification and the search samples
// with the certification boundary. Legacy evaluate/optimize runs keep the old tabs.
import React, { useState } from "react";
import { platformApi } from "./api";

const fmt = (v, d = 2) => (v === null || v === undefined ? "—" : typeof v === "number" ? v.toLocaleString(undefined, { maximumFractionDigits: d }) : String(v));
const pct = (v) => (v === null || v === undefined ? "—" : `${(v * 100).toFixed(2)}%`);
const cr = (v) => (v === null || v === undefined ? "—" : `₹${(v).toFixed(1)} cr`);

export default function RunResultPanel({ run, org }) {
  const [exporting, setExporting] = useState(null);
  async function exportWorkbook() {
    setExporting("working");
    try { setExporting(await platformApi(`/orgs/${org.id}/runs/${run.id}/workbook?verify=true`, { method: "POST" })); } catch (e) { setExporting({ error: e.message }); }
  }
  if (!run?.result) return <section className="run-result"><div className="panel"><h3>Run {run?.id?.slice(0, 8)}: {run?.status}</h3><p className="note">{run?.error || run?.metrics?.status_reason || "no result"}</p></div></section>;
  const r = run.result;
  const fin = r.finance;
  const term = r.term;
  return (
    <section className="run-result">
      <div className="req-head">
        <h2>{r.mode === "bid_tariff_search" ? "Bid tariff optimisation (workflow A)" : r.workflow === "B" ? "Fixed-tariff investment evaluation (workflow B)" : "MILP dispatch"}</h2>
        <span className={`chip ${run.status}`}>{run.status}</span>
        {run.stale && <span className="chip warn" title={run.stale_reason}>stale</span>}
        <span className="chip">{r.tariff_label}</span>
        {run.metrics?.solver && <span className="chip">{run.metrics.solver}</span>}
        {term?.worst_gap !== undefined && term?.worst_gap !== null && <span className="chip">gap {(term.worst_gap * 100).toFixed(3)}%</span>}
        {term?.certification_year1 && <span className={`chip ${term.certification_year1.status === "certified" ? "accepted" : "rejected"}`}>validation: {term.certification_year1.status}</span>}
        <span className="chip">run {run.id.slice(0, 8)} · inputs {run.snapshot?.inputs?.hash?.slice(0, 8)} · rules {run.snapshot?.rules_version}</span>
        {fin && org && <button className="secondary" onClick={exportWorkbook} disabled={exporting === "working"}>{exporting === "working" ? "Building and verifying…" : "Export Excel model (formulas)"}</button>}
      </div>
      {exporting && exporting !== "working" && (
        <div className={`alert ${exporting.error || exporting.verification?.status !== "verified" ? "" : "ok"}`}>
          {exporting.error ? exporting.error : <>Workbook <a href={exporting.artifact.download}>{exporting.artifact.filename}</a> (sha256 {exporting.artifact.sha256.slice(0, 10)}) · recalculation check: <strong>{exporting.verification.status}</strong>{exporting.verification.error ? ` (${exporting.verification.error})` : ""} {exporting.verification.comparisons?.map((c) => `${c.metric}: workbook ${typeof c.workbook === "number" ? c.workbook.toFixed(4) : c.workbook} vs backend ${typeof c.backend === "number" ? c.backend.toFixed(4) : c.backend} ${c.ok ? "✓" : "✗"}`).join(" · ")}</>}
        </div>
      )}
      {r.search_status && (
        <div className="panel">
          <h3>Search outcome: {r.search_status}</h3>
          <p className="note">{r.certification_boundary}</p>
          <p className="note">monotone IRR in tariff: {String(r.monotone)} · dispatch tariff-invariant on the range: {String(r.dispatch_invariant)} · MILP solves: {r.milp_solves} · iterations: {r.iterations}</p>
          {r.notes?.map((n, i) => <p key={i} className="note">{n}</p>)}
          <table className="table"><thead><tr><th>Tariff (₹/kWh)</th><th>Dispatch status</th><th>Equity IRR</th><th>Min DSCR</th><th>Meets target</th></tr></thead>
            <tbody>{r.samples.map((s, i) => <tr key={i}><td>{s.tariff.toFixed(3)}</td><td>{s.status}</td><td>{pct(s.equity_irr)}</td><td>{fmt(s.min_dscr)}</td><td>{s.meets ? "yes" : "no"}</td></tr>)}</tbody></table>
        </div>
      )}
      {fin && (
        <div className="panel">
          <h3>Financial results ({fin.version})</h3>
          <div className="kpis">
            {[["Equity IRR", pct(fin.equity_irr)], ["Project IRR", pct(fin.project_irr)], ["NPV equity", cr(fin.npv_equity_cr)], ["Min DSCR", fmt(fin.min_dscr)], ["Avg DSCR", fmt(fin.avg_dscr)], ["Project cost", cr(fin.total_project_cost_cr)], ["Debt", cr(fin.debt_cr)], ["Equity", cr(fin.equity_cr)], ["IDC", cr(fin.idc_cr)]].map(([k, v]) => <div key={k} className="kpi"><small>{k}</small><strong>{v}</strong></div>)}
          </div>
          {fin.sign_changes_equity > 1 && <div className="alert">Equity cash flows change sign {fin.sign_changes_equity} times; IRR roots found: {fin.equity_irr_roots.map((x) => pct(x)).join(", ") || "none"}. NPV at the discount rate is the ranking measure.</div>}
          {fin.notes?.map((n, i) => <p key={i} className="note">{n}</p>)}
          <details><summary>Annual statement</summary>
            <table className="table"><thead><tr><th>Year</th><th>PPA revenue</th><th>Merchant</th><th>Penalties</th><th>Purchases</th><th>Fuel+VOM</th><th>Fixed opex</th><th>EBITDA</th><th>Interest</th><th>Principal</th><th>Tax</th><th>CFADS</th><th>DSCR</th><th>FCFE</th></tr></thead>
              <tbody>{fin.years.map((y, i) => <tr key={y}><td>{y}</td>{["revenue_ppa", "revenue_merchant", "penalties", "purchases", "fuel_and_variable", "fixed_opex", "ebitda", "interest", "principal", "tax", "cfads"].map((k) => <td key={k}>{cr(fin.statement[k][i] / 1e7)}</td>)}<td>{fmt(fin.statement.dscr[i])}</td><td>{cr(fin.statement.fcfe[i] / 1e7)}</td></tr>)}</tbody></table>
          </details>
        </div>
      )}
      {term && (
        <div className="panel">
          <h3>Contract term dispatch ({term.status}) · solved years {term.years_solved?.join(", ")}{term.years_interpolated?.length ? ` · ${term.years_interpolated.length} interpolated` : ""}</h3>
          {r.binding?.length > 0 && <p className="note"><strong>Binding / diagnostics:</strong> {r.binding.join("; ")}</p>}
          <table className="table"><thead><tr><th>Year</th><th>PPA GWh</th><th>CUF</th><th>Merchant GWh</th><th>Purchases GWh</th><th>Curtailed GWh</th><th>Penalty MWh</th><th>Peak ok</th><th>RE share</th><th>Status</th></tr></thead>
            <tbody>{term.per_year.map((y) => <tr key={y.year} className={y.interpolated ? "muted" : ""}><td>{y.year}{y.interpolated ? "*" : ""}</td><td>{fmt(y.ppa_mwh / 1000, 1)}</td><td>{pct(y.annual_cuf)}</td><td>{fmt((y.merchant_mwh || 0) / 1000, 1)}</td><td>{fmt((y.iex_purchase_mwh || 0) / 1000, 1)}</td><td>{fmt((y.re_curtailed_mwh || 0) / 1000, 1)}</td><td>{fmt(y.total_penalty_mwh, 0)}</td><td>{String(y.peak_ok)}</td><td>{pct(y.renewable_share)}</td><td>{y.interpolated ? "interpolated" : y.solver_status}</td></tr>)}</tbody></table>
          {term.solves?.length > 0 && <details><summary>Solver log</summary><table className="table"><thead><tr><th>Year</th><th>Status</th><th>Objective ₹</th><th>Bound ₹</th><th>Gap</th><th>Seconds</th><th>Vars</th><th>Rows</th><th>Binaries</th><th>Certified</th></tr></thead><tbody>{term.solves.map((s) => <tr key={s.year}><td>{s.year}</td><td>{s.solver_status}</td><td>{fmt(s.objective_inr, 0)}</td><td>{fmt(s.best_bound_inr, 0)}</td><td>{s.gap === null ? "—" : (s.gap * 100).toFixed(3) + "%"}</td><td>{s.seconds}</td><td>{s.variables}</td><td>{s.constraints}</td><td>{s.binaries}</td><td>{s.certified}</td></tr>)}</tbody></table></details>}
          {term.certification_year1 && <details><summary>Independent validation (year 1): {term.certification_year1.status}, {term.certification_year1.checks_run?.length} checks, {term.certification_year1.issue_count} issue(s)</summary><pre className="mono">{JSON.stringify(term.certification_year1.max_residual, null, 1)}</pre></details>}
        </div>
      )}
      {r.sensitivities?.length > 0 && (
        <div className="panel">
          <h3>Sensitivities (finance only, dispatch fixed)</h3>
          <table className="table"><thead><tr><th>Case</th><th>Equity IRR</th><th>Project IRR</th><th>NPV equity</th><th>Min DSCR</th></tr></thead>
            <tbody>{r.sensitivities.map((s) => <tr key={s.case}><td>{s.case}</td><td>{pct(s.equity_irr)}</td><td>{pct(s.project_irr)}</td><td>{cr(s.npv_equity_cr)}</td><td>{fmt(s.min_dscr)}</td></tr>)}</tbody></table>
        </div>
      )}
      {r.assumptions && <details className="panel"><summary>Financial assumptions ({r.assumptions.version}) and their sources</summary><table className="table"><thead><tr><th>Item</th><th>Amount ₹ cr / year</th><th>Source</th></tr></thead><tbody>{r.assumptions.capex.map((c) => <tr key={c.name}><td>{c.name}</td><td>{cr(c.amount_inr / 1e7)}</td><td>{c.source}</td></tr>)}{r.assumptions.opex.map((o) => <tr key={o.name}><td>{o.name} (opex)</td><td>{cr(o.amount_inr_per_year / 1e7)} @ {pct(o.escalation)}/yr</td><td>{o.source}</td></tr>)}</tbody></table><p className="note">debt {pct(r.assumptions.debt_fraction)} at {pct(r.assumptions.interest_rate)} for {r.assumptions.tenor_years} years ({r.assumptions.repayment}, target DSCR {r.assumptions.sculpt_target_dscr}); tax {pct(r.assumptions.tax_rate)}, WDV {pct(r.assumptions.tax_wdv_rate)}; discount {pct(r.assumptions.discount_rate)}; target equity IRR {pct(r.assumptions.target_equity_irr)}; sources: {JSON.stringify(r.assumptions.sources)}</p></details>}
    </section>
  );
}
