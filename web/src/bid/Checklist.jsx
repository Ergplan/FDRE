import React from "react";
import { CheckCircle2, CircleMinus, Info, XCircle } from "lucide-react";
import { Section, nf, pf } from "../rtc/ui";
import { SourceChip } from "./RequirementsStep";
import { FINANCE_FIELDS, SIZE_KEY, SOURCES, SOURCE_FIELDS, anyHours, plantMw, solarMinMw } from "./model";

const STATUS = {
  met: { label: "Met", icon: CheckCircle2, cls: "ok" },
  failed: { label: "Not met", icon: XCircle, cls: "bad" },
  na: { label: "Not required", icon: CircleMinus, cls: "muted" },
  info: { label: "Noted", icon: Info, cls: "muted" },
};

function StatusCell({ status }) {
  const s = STATUS[status] || STATUS.info;
  const Icon = s.icon;
  return <span className={`bid-check ${s.cls}`}><Icon size={14} /> {s.label}</span>;
}

const fmtDate = (v) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || ""));
  return m ? `${m[3]}.${m[2]}.${m[1]}` : v;
};

/**
 * Every tender requirement against what the sized plant (and, on Financials, the bid) delivers.
 * Supply floors and the green share use the worst of the modelled PPA years.
 */
export function buildChecklist(state, terms, lp, bidTariff = null) {
  const prov = terms.provenance;
  const sizes = lp?.sizes || {};
  const years = lp?.perYear || [];
  const total = plantMw(state, terms);
  const rows = [];
  const add = (row) => rows.push(row);
  const sized = Boolean(lp);
  const pending = "Size the plant to check";

  if (terms.baseMw) {
    const ok = terms.partAllowed === false ? state.bid.baseMw === terms.baseMw : state.bid.baseMw <= terms.baseMw;
    add({ id: "capacity", condition: "Bid capacity", source: prov.capacity, tender: `${nf(terms.baseMw, 0)} MW${terms.partAllowed === false ? ", no part capacity" : ""}`,
      result: `${nf(state.bid.baseMw, 0)} MW bid`, status: ok ? "met" : "failed" });
  }
  if (terms.greenshoeMw) {
    add({ id: "greenshoe", condition: "Greenshoe", source: prov.greenshoe, tender: `${nf(terms.greenshoeMw, 0)} MW at the procurer's option${terms.greenshoeSameTariff ? ", same tariff" : ""}`,
      result: state.bid.greenshoe ? `Plant and tariff cover ${nf(total, 0)} MW` : "Not sized for: the tariff covers the bid capacity only", status: state.bid.greenshoe ? "met" : "info" });
  }
  for (const rule of terms.rules) {
    const outcomes = years.map((y) => (y.rules || []).find((o) => o.id === rule.id)).filter(Boolean);
    const worst = outcomes.length ? Math.min(...outcomes.map((o) => o.achieved)) : null;
    const where = `${rule.basis === "monthly" ? "every month" : "each year"}${rule.hours === "all" ? "" : rule.hours === "any" ? `, in each of the ${anyHours(terms.peak).length} hours the procurer may pick` : ", peak hours"}`;
    add({ id: `rule.${rule.id}`, condition: rule.label, source: prov[`rule.${rule.id}`], tender: `At least ${pf(rule.target, 0)} CUF, ${where}`,
      result: worst === null ? pending : `${pf(worst, 1)} in the worst modelled year (years ${years.map((y) => y.year).join(", ")})`,
      status: worst === null ? "info" : outcomes.every((o) => o.met) ? "met" : "failed" });
  }
  if (prov["peak.hours"]) {
    add({ id: "peak.hours", condition: "Peak hours", source: prov["peak.hours"], tender: `${prov["peak.hours"].display} a day${prov["peak.setBy"] ? `; ${prov["peak.setBy"].display.toLowerCase()}` : ""}`,
      result: terms.peakAny ? `Every hour of the day is checked against the peak floor` : `Checked in the chosen window`, status: "met" });
  }
  // sources: every source used must be allowed; mandated ones present
  for (const src of SOURCES) {
    const used = state.sources[src.id] && (sizes[SIZE_KEY[src.id]] || 0) > 0.5;
    const allowed = terms.permitted[src.id];
    if (allowed === false && state.sources[src.id]) {
      add({ id: `src.${src.id}`, condition: src.title, source: src.id === "thermal" ? prov.nonRe : prov.sources, tender: "Not allowed", result: used ? "Used" : "Switched on", status: "failed" });
    }
  }
  if (terms.solarMultiple) {
    const min = solarMinMw(state, terms);
    add({ id: "solar.min", condition: "Mandatory solar capacity", source: prov["solar.min"], tender: `${terms.solarMultiple} × contracted capacity = ${nf(min, 0)} MW`,
      result: sized ? `${nf(sizes.solarMw || 0, 0)} MW of solar` : pending, status: !sized ? "info" : (sizes.solarMw || 0) >= min - 0.5 ? "met" : "failed" });
  }
  if (terms.mandatory.bess) {
    add({ id: "storage", condition: "Energy storage", source: prov.storage, tender: "Mandatory",
      result: sized ? `${nf(sizes.bessMw || 0, 0)} MW / ${nf(sizes.bessMwh || 0, 0)} MWh` : pending, status: !sized ? "info" : (sizes.bessMw || 0) > 0.5 ? "met" : "failed" });
  }
  if (terms.greenMin) {
    const shares = years.map((y) => y.greenShare).filter((v) => v !== undefined);
    const worst = shares.length ? Math.min(...shares) : 1;
    const nonRe = state.sources.thermal;
    add({ id: "green", condition: "Traceable green share", source: prov.green, tender: `At least ${pf(terms.greenMin, 0)} of supply, each accounting year`,
      result: !sized ? pending : nonRe ? `${pf(worst, 1)} green in the worst modelled year` : "100% green: no non-RE source",
      status: !sized ? "info" : worst >= terms.greenMin - 1e-6 ? "met" : "failed" });
  }
  if (terms.permitted.thermal) {
    const mu = years[0]?.thermalMu;
    add({ id: "nonRe", condition: "Non-RE supply with RECs", source: prov.nonRe, tender: "Allowed for the balance; RECs for every non-RE unit",
      result: !state.sources.thermal ? "No non-RE source in the bid" : !sized ? pending : `${nf(mu || 0, 0)} MU in year 1, RECs costed on every kWh`,
      status: !state.sources.thermal ? "na" : sized ? "met" : "info" });
  }
  if (lp && years.some((y) => y.divertedMu !== undefined)) {
    const diverted = Math.max(...years.map((y) => y.divertedMu || 0));
    add({ id: "ppaFirst", condition: "PPA supplied before any sale", source: prov.ppaFirst || null,
      tender: prov.ppaFirst ? prov.ppaFirst.display : "Not stated; the PPA is supplied first in every hour",
      result: diverted < 0.01 ? "Nothing sold while the PPA had room, in every modelled year" : `${nf(diverted, 1)} MU sold while the PPA had room`,
      status: diverted < 0.01 ? "met" : "failed" });
    add({ id: "market", condition: "What may be sold in the market", source: prov["market.sale"], tender: prov["market.sale"]?.display || "Not stated",
      result: `${lp.exportSources === "solar" ? "Solar surplus only" : "Renewable surplus only"}, at ${lp.market ? `IEX ${lp.market} hourly prices` : `₹${nf(lp.flatPrice, 2)}/kWh`}`,
      status: terms.sale === "mandated_solar" ? (lp.exportSources === "solar" ? "met" : "failed") : terms.sale === "not_allowed" ? "failed" : "met" });
  } else if (terms.sale) {
    add({ id: "market", condition: "What may be sold in the market", source: prov["market.sale"], tender: prov["market.sale"]?.display, result: state.market.sell ? pending : "Nothing sold", status: state.market.sell && !sized ? "info" : "met" });
  }
  if (terms.site) add({ id: "site", condition: "Project location", source: prov.site, tender: prov.site?.display, result: "Your sites; their profiles set the solar and wind output", status: "info" });
  if (terms.years) add({ id: "term", condition: "PPA term", source: prov.years, tender: `${terms.years} years`, result: `Modelled and financed over ${terms.years} years`, status: "met" });
  const tariff = bidTariff ?? lp?.tariff ?? null;
  add({ id: "ceiling", condition: "Ceiling tariff", source: prov.ceiling, tender: terms.ceiling ? `At most ₹${nf(terms.ceiling, 2)}/kWh` : "Not stated",
    result: tariff === null ? pending : `Bid tariff ₹${nf(tariff, 3)}/kWh${bidTariff === null ? " (HiGHS)" : ""}`,
    status: !terms.ceiling ? "na" : tariff === null ? "info" : tariff <= terms.ceiling + 1e-9 ? "met" : "failed" });
  if (terms.emdPerMw) add({ id: "emd", condition: "Bid security (EMD)", source: prov.emd, tender: prov.emd.display, result: `₹${nf((terms.emdPerMw * (state.bid.baseMw || 0)) / 1e7, 2)} cr for the ${nf(state.bid.baseMw || 0, 0)} MW bid`, status: "info" });
  if (terms.pbgPerMw) add({ id: "pbg", condition: "Performance guarantee (PBG)", source: prov.pbg, tender: prov.pbg.display, result: `₹${nf((terms.pbgPerMw * (total || 0)) / 1e7, 2)} cr for ${nf(total || 0, 0)} MW`, status: "info" });
  if (terms.supplyStart) add({ id: "start", condition: "Supply start", source: prov.start, tender: `${fmtDate(terms.supplyStart)}${terms.greenshoeStart ? `; greenshoe ${fmtDate(terms.greenshoeStart)}` : ""}`, result: "Build schedule is not modelled", status: "info" });
  return rows;
}

export default function Checklist({ state, terms, lp, bidTariff = null, index = "4.2" }) {
  const rows = buildChecklist(state, terms, lp, bidTariff);
  const met = rows.filter((r) => r.status === "met").length;
  const failed = rows.filter((r) => r.status === "failed").length;
  return (
    <Section index={index} title="Tender conditions" note={`${met} met · ${failed} not met · ${rows.length - met - failed} noted or not required`}>
      <div className="bid-checklist" role="table" data-testid="bid-checklist">
        <div className="bid-checklist-row head" role="row"><span>Condition</span><span>Tender says</span><span>Plant and bid</span><span>Status</span></div>
        {rows.map((r) => (
          <div key={r.id} className={`bid-checklist-row ${r.status}`} role="row" data-testid={`check-${r.id}`}>
            <span><strong>{r.condition}</strong></span>
            <span>{r.tender} {r.source && <SourceChip source={r.source} compact />}</span>
            <span>{r.result}</span>
            <span><StatusCell status={r.status} /></span>
          </div>
        ))}
      </div>
    </Section>
  );
}

const show = (f, v) => {
  if (v === null || v === undefined) return "–";
  if (f.options) return f.options.find(([k]) => k === v)?.[1] || v;
  return f.pct ? pf(v, 2) : `${nf(v, 2)}${f.unit ? ` ${f.unit}` : ""}`;
};

/** Every input the bidder gave (the tender sets none of these), listed openly. */
export function BidderInputs({ state, prices, index = "4.3" }) {
  const rows = [];
  for (const src of SOURCES) {
    if (!state.sources[src.id]) continue;
    const s = state.src[src.id];
    const cap = s.capacity.mode === "fixed" ? `${nf(s.capacity.mw, 0)} MW fixed` : `optimised, up to ${nf(s.capacity.mw, 0)} MW`;
    const profile = src.id === "solar" || src.id === "wind" ? ` · profile ${(state[`${src.id}Upload`]?.name) || "typical shape"} scaled to the CUF` : "";
    rows.push({ input: src.title, value: `${cap} · ${SOURCE_FIELDS[src.id].map((f) => `${f.label.toLowerCase()} ${show(f, s[f.key])}`).join(" · ")}${profile}` });
  }
  rows.push({ input: "Financing", value: FINANCE_FIELDS.map((f) => `${f.label.toLowerCase()} ${show(f, state[f.section][f.key])}`).join(" · ") });
  if (state.market.sell) {
    const m = prices?.markets?.[state.market.source];
    rows.push({ input: "Market prices", value: state.market.source === "flat" ? `flat ₹${nf(state.market.flatPrice, 2)}/kWh` : `IEX ${state.market.source}${m ? `, ${m.from} to ${m.to}` : ""}, escalation ${pf(state.market.escalation || 0, 1)}/yr` });
  }
  return (
    <Section index={index} title="Your inputs" note="The bidder's own numbers; the tender sets none of these">
      <div className="bid-checklist" role="table" data-testid="bid-inputs">
        <div className="bid-checklist-row head bid-inputs-row" role="row"><span>Input</span><span>Value used</span><span /></div>
        {rows.map((r) => (
          <div key={r.input} className="bid-checklist-row bid-inputs-row" role="row">
            <span><strong>{r.input}</strong></span><span>{r.value}</span><span />
          </div>
        ))}
      </div>
    </Section>
  );
}
