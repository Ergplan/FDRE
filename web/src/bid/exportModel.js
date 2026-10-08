// Tender to Bid: the financial-model workbook request (POST /api/bid/model builds the .xlsx).
// Everything comes from what the tab computed: the tender's terms, the bidder's inputs (each
// marked as typed, benchmark or default), the sized plant and the financial model's years.
import { BENCHMARK_NOTE, FINANCE_FIELDS, SOURCES, SOURCE_FIELDS, capacityWarnings, capexBySource, plantMw, solarMinMw } from "./model.js";
import { buildChecklist } from "./Checklist.jsx";

const STATUS = { met: "Met", failed: "Not met", na: "Not required", info: "Noted" };
const SIZE = { solar: "solarMw", wind: "windMw", hydro: "hydroMw", biomass: "biomassMw", thermal: "thermalMw", bess: "bessMw" };
const fmtDate = (v) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || ""));
  return m ? `${m[3]}.${m[2]}.${m[1]}` : v || "";
};

/** The workbook request for the bid that was sized and priced. */
export function modelExport({ state, terms, finance, costs, fin, prices }) {
  const lp = state.lp;
  const values = state.tender?.result?.values || {};
  const total = plantMw(state, terms);
  const y1 = finance.rows[0];
  const on = SOURCES.filter((s) => state.sources[s.id]);
  const checks = buildChecklist(state, terms, lp, finance.tariff);
  const met = checks.filter((c) => c.status === "met").length;
  const failed = checks.filter((c) => c.status === "failed");
  const tenderNumber = values["core.identity.tender_number"] || "";
  const issuer = values["core.identity.issuing_agency"] || "";
  const sourceOf = (path) => (state.filled?.[path] ? "Industry benchmark" : "Your input");
  const mix = lp.perYear?.[0] || {};
  const capex = capexBySource(lp.sizes, costs);

  const outputs = [
    ["Bid tariff (₹/kWh)", finance.tariff, "tariff", `Tariff that gives the ${(fin.targetEquityIrr * 100).toFixed(2)}% target equity IRR`],
    ["Equity IRR", finance.equityIrr, "pct"],
    ["Project IRR", finance.projectIrr, "pct"],
    ["Equity NPV at the target IRR (₹ cr)", finance.equityNpv, "cr"],
    ["Minimum DSCR", finance.minDscr, "x"],
    ["Average DSCR", finance.avgDscr, "x"],
    ["Equity payback (year)", finance.payback ?? "beyond the term", "int"],
    ["Project cost (₹ cr)", finance.capex.total, "cr", `₹${(finance.capex.total / (total || 1)).toFixed(2)} cr per contracted MW`],
    ["Debt (₹ cr)", finance.debt, "cr"],
    ["Equity (₹ cr)", finance.equity, "cr"],
    ["Levelised cost of supply (₹/kWh)", finance.lcoe, "tariff", `at a ${(fin.discountRate * 100).toFixed(1)}% discount rate`],
    ["Least-tariff sizing (HiGHS, ₹/kWh)", lp.tariff, "tariff", "Screening tariff of the sizing; the bid tariff is from the full financial model"],
    ["Year-1 supply (MU)", y1.deliveredMu, "mu", `${(y1.dfr * 100).toFixed(1)}% of contracted`],
    ["Year-1 market sale (MU)", y1.excessMu, "mu"],
    [`Revenue over ${finance.rows.length} years (₹ cr)`, finance.totals.revenue, "cr"],
    ["Tender conditions", `${met} met, ${failed.length} not met`, "text", failed.map((c) => c.condition).join("; ")],
  ];
  const plant = [
    ["Contracted capacity (MW)", total, "mw", state.bid.greenshoe ? `bid ${state.bid.baseMw} MW + greenshoe ${terms.greenshoeMw} MW` : "bid capacity"],
    ...on.filter((s) => s.id !== "bess").map((s) => [`${s.title} (MW)`, Math.max(0, lp.sizes[SIZE[s.id]] || 0), "mw",
      `${state.src[s.id].capacity.mode === "fixed" ? "fixed by you" : "sized by the optimizer"}${mix[`${s.id}Mu`] !== undefined ? ` · ${Math.round(mix[`${s.id}Mu`])} MU in year 1` : ""}`]),
    ...(state.sources.bess ? [["Battery power (MW)", lp.sizes.bessMw, "mw"], ["Battery energy (MWh)", lp.sizes.bessMwh, "mw"]] : []),
    ...(mix.greenShare !== undefined ? [["Green share, year 1", mix.greenShare, "pct"]] : []),
  ];
  const keyInputs = [
    ["Bid capacity (MW)", state.bid.baseMw, "mw", capacityWarnings(state, terms).join("; ")],
    ...on.map((s) => {
      const src = state.src[s.id];
      const parts = SOURCE_FIELDS[s.id].filter((f) => ["cuf", "capex", "om", "fuel", "fixed", "energy", "rec", "duration", "rte"].includes(f.key))
        .map((f) => `${f.label} ${f.pct ? `${(src[f.key] * 100).toFixed(1)}%` : f.options ? (f.options.find(([k]) => k === src[f.key])?.[1] || src[f.key]) : src[f.key]}${f.pct || f.options ? "" : ` ${f.unit}`}`);
      return [s.title, parts.join(" · "), "text"];
    }),
    ["Financing", `equity IRR ${(fin.targetEquityIrr * 100).toFixed(1)}% · debt ${(fin.debtFraction * 100).toFixed(0)}% at ${(fin.interestRate * 100).toFixed(2)}% for ${fin.tenorYears} years · tax ${(fin.taxRate * 100).toFixed(2)}%`, "text"],
    ["Market sale", state.market.sell ? (state.market.source === "flat" ? `flat ₹${state.market.flatPrice}/kWh` : `IEX ${state.market.source}, hourly${prices?.markets?.[state.market.source] ? `, ${prices.markets[state.market.source].from} to ${prices.markets[state.market.source].to}` : ""}`) : "none", "text"],
  ];
  const tender = [
    ["Procurer", issuer, "text"],
    ["Tender", tenderNumber, "text", values["core.identity.title"] || ""],
    ["Capacity", `${terms.baseMw || "–"} MW${terms.greenshoeMw ? ` + ${terms.greenshoeMw} MW greenshoe` : ""}${terms.partAllowed === false ? ", no part capacity" : ""}`, "text"],
    ["Supply floors", terms.rules.map((r) => `${r.label} ${Math.round(r.target * 100)}%`).join(" · "), "text"],
    ["Least green share", terms.greenMin ? `${Math.round(terms.greenMin * 100)}% each year` : "Not stated", "text"],
    ["Mandatory solar", terms.solarMultiple ? `${terms.solarMultiple} × contracted = ${solarMinMw(state, terms)} MW` : "Not stated", "text"],
    ["PPA term", terms.years ? `${terms.years} years` : "Not stated", "text"],
    ["Supply start", `${fmtDate(terms.supplyStart)}${terms.greenshoeStart ? `; greenshoe ${fmtDate(terms.greenshoeStart)}` : ""}`, "text"],
    ["Ceiling tariff", terms.ceiling ? `₹${terms.ceiling}/kWh` : "Not stated", "text"],
  ];
  const notes = [
    "Every tender condition comes from the tender reading, with its page and quote (sheet Tender conditions).",
    `Inputs marked "Industry benchmark" are ${BENCHMARK_NOTE.charAt(0).toLowerCase()}${BENCHMARK_NOTE.slice(1)}; the rest are the bidder's own (sheet Inputs).`,
    ...capacityWarnings(state, terms).map((w) => `${w} (p. 12); this model is for ${state.bid.baseMw} MW.`),
  ];

  const inputs = [];
  inputs.push({ group: "Bid", input: "Bid capacity", value: state.bid.baseMw, unit: "MW", source: state.filled?.["bid.baseMw"] ? "Prefilled" : "Your input" });
  inputs.push({ group: "Bid", input: "Sized for the greenshoe", value: state.bid.greenshoe ? "Yes" : "No", unit: "", source: "Your input" });
  for (const s of on) {
    const src = state.src[s.id];
    inputs.push({ group: s.title, input: "Capacity", value: src.capacity.mode === "fixed" ? src.capacity.mw : (src.capacity.mw || "automatic limit"), unit: "MW", source: src.capacity.mode === "fixed" ? "Fixed by you" : "Upper limit for the optimizer" });
    for (const f of SOURCE_FIELDS[s.id]) {
      const v = src[f.key];
      inputs.push({ group: s.title, input: f.label, value: f.options ? (f.options.find(([k]) => k === v)?.[1] || v) : v, unit: f.pct ? "%" : f.unit || "", source: sourceOf(`${s.id}.${f.key}`) });
    }
  }
  for (const f of FINANCE_FIELDS) inputs.push({ group: "Financing", input: f.label, value: state[f.section][f.key], unit: f.pct ? "%" : f.unit || "", source: sourceOf(`${f.section}.${f.key}`) });
  const otherTerms = [["Repayment", fin.repayment], ["Tax depreciation", fin.taxDepreciation], ["WDV rate", fin.wdvRate, "%"], ["Book life", fin.bookLifeYears, "years"], ["Salvage value", fin.salvagePct, "%"], ["Receivable days", fin.receivableDays, "days"], ["Discount rate (LCOE, NPV)", fin.discountRate, "%"]];
  for (const [label, value, unit] of otherTerms) inputs.push({ group: "Financing", input: label, value, unit: unit || "", source: "Model default (editable on Financials)" });
  inputs.push({ group: "Market", input: "Sell in the market", value: state.market.sell ? `Yes, ${state.market.source === "flat" ? `flat ₹${state.market.flatPrice}/kWh` : `IEX ${state.market.source}`}` : "No", unit: "", source: state.filled?.["market.sell"] ? "Industry benchmark" : "Your input" });

  const capexRows = [
    ...on.map((s) => [`${s.title}`, capex[s.id] || 0, "cr", s.id === "hydro" || s.id === "thermal" ? "0 when the power is bought under contract" : ""]),
    ["Transmission / evacuation", (costs.evacuationCr || 0) * (1 + (costs.preopPct || 0)), "cr"],
    ["Total project cost (incl. pre-operative & IDC)", finance.capex.total, "cr", `pre-operative ${((costs.preopPct || 0) * 100).toFixed(1)}% of hard cost`],
    ["Debt", finance.debt, "cr", `${(fin.debtFraction * 100).toFixed(0)}%`],
    ["Equity", finance.equity, "cr"],
  ];

  const plantLines = [];
  if (state.sources.biomass) plantLines.push(["Biomass fuel", "fuel"]);
  if (state.sources.hydro) plantLines.push(["Hydro fixed + energy cost", "hydroCost"]);
  if (state.sources.thermal) plantLines.push(["Thermal (non-RE) cost incl. RECs", "thermalCost"]);
  const energyMu = [];
  if (state.sources.biomass) energyMu.push(["Biomass generation", "biomassMu", "mu", "MU"]);
  if (state.sources.hydro) energyMu.push(["Hydro energy", "hydroMu", "mu", "MU"]);
  if (state.sources.thermal) energyMu.push(["Thermal (non-RE) energy", "thermalMu", "mu", "MU"]);
  const energy = { title: "Energy and tariff", lines: [
    ["Contracted energy", "demandMu", "mu", "MU"], ["Delivered to the procurer", "deliveredMu", "mu", "MU"], ["Delivered ÷ contracted", "dfr", "pct", "", false],
    ["Sold in the market", "excessMu", "mu", "MU"], ...energyMu, ["Tariff", "tariff", "tariff", "₹/kWh", false],
  ] };
  const revenue = { title: "Revenue", lines: [
    ["PPA supply revenue", "energyRevenue"], [lp.market ? `Market sale revenue (IEX ${lp.market})` : "Market sale revenue", "surplusRevenue"], ["Shortfall penalty", "penalty"], ["Total revenue", "revenue"],
  ] };
  const costsSection = { title: "Operating costs", lines: [
    ["O&M", "om"], ["Insurance", "insurance"], ["Other fixed cost", "other"], ...plantLines, ["Total operating cost", "opex"],
  ] };
  const streams = [energy, revenue, costsSection, { title: "Capital spend in operation", lines: [["Battery augmentation", "augCapex"]] }];
  const statements = [
    energy, revenue, costsSection,
    { title: "Profit and loss", lines: [["EBITDA", "ebitda"], ["Book depreciation", "bookDep"], ["Interest", "interest"], ["Profit before tax", "pbt"], ["Tax depreciation", "taxDep"], ["Tax", "tax"], ["Profit after tax", "pat"]] },
    { title: "Cash flow", lines: [["Receivables", "receivables", "cr", "₹ cr", false], ["Working capital change", "dWc"], ["Battery augmentation", "augCapex"], ["CFADS", "cfads"], ["Debt service", "debtService"], ["Free cash to equity", "fcfe"], ["Cumulative equity cash", "cumEquity", "cr", "₹ cr", false], ["Project cash flow", "projectCf"]] },
    { title: "Debt", lines: [["Opening debt", "openingDebt", "cr", "₹ cr", false], ["Interest", "interest"], ["Principal", "principal"], ["Closing debt", "closingDebt", "cr", "₹ cr", false], ["DSCR", "dscr", "x", "×", false]] },
  ];

  const conditions = checks.map((c) => ({ condition: c.condition, tender: c.tender, page: c.source?.page ?? null, quote: c.source?.quote || "", result: c.result, status: STATUS[c.status] || c.status }));
  const shortName = (issuer.match(/\(([^)]+)\)/)?.[1] || "Tender").replace(/\s+/g, "_");
  return {
    fileName: `${shortName}_bid_${state.bid.baseMw}MW_financial_model`,
    title: `${issuer.match(/\(([^)]+)\)/)?.[1] || issuer || "Tender"} ${values["core.identity.tender_type_as_stated"] || ""} · bid financial model`.replace(/\s+/g, " "),
    subtitle: [tenderNumber, `${total} MW round the clock`, `${finance.rows.length} years`].filter(Boolean).join(" · "),
    tenderNumber,
    cover: { outputs, plant, inputs: keyInputs, tender, notes },
    conditions,
    inputs,
    plant,
    capex: capexRows,
    rows: finance.rows,
    streams,
    statements,
    flows: { equity: finance.equityFlows, project: finance.projectFlows },
  };
}

/** POST the request and save the workbook. */
export async function downloadModel(payload) {
  const res = await fetch("/api/bid/model", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    let msg = `Download failed (${res.status})`;
    try { msg = (await res.json()).error || msg; } catch { /* not JSON */ }
    throw new Error(msg);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${payload.fileName}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
