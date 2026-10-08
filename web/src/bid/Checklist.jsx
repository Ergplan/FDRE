import React from "react";
import { CheckCircle2, CircleMinus, Info, XCircle } from "lucide-react";
import { Section, nf, pf } from "../rtc/ui";
import { SourceChip } from "./RequirementsStep";
import { anyHours, peakLabel } from "./model";

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

/**
 * Every tender condition against what the sized plant (and, on Financials, the bid) delivers.
 * Supply floors use the worst of the modelled PPA years.
 */
export function buildChecklist(state, lp, bidTariff = null) {
  const prov = state.provenance || {};
  const notes = Object.fromEntries((state.notes || []).map((n) => [n.id, n]));
  const sizes = lp?.sizes || {};
  const rows = [];
  const add = (row) => rows.push(row);

  const base = state.baseMw || state.plantMw;
  add({
    id: "capacity", condition: "Contracted supply capacity", source: prov.plantMw,
    tender: prov.plantMw?.display || "Not read from the tender",
    result: `Supply of ${nf(state.plantMw, 0)} MW in every hour is the delivery target${state.greenshoeMw ? ` (base ${nf(base, 0)} MW + greenshoe ${nf(state.greenshoeMw, 0)} MW)` : ""}`,
    status: prov.plantMw ? (Math.abs(Number(String(prov.plantMw.display).replace(/[^\d.]/g, "")) - base) < 0.5 ? "met" : "info") : "info",
  });
  if (prov.greenshoe) {
    add({
      id: "greenshoe", condition: "Greenshoe option", source: prov.greenshoe, tender: prov.greenshoe.display,
      result: state.greenshoeMw ? "Included: the plant and the tariff cover base + greenshoe" : "Not included: sized for the base only",
      status: state.greenshoeMw ? "met" : "info",
    });
  }

  const years = lp?.perYear || [];
  for (const rule of state.rules.filter((r) => r.enabled)) {
    const outcomes = years.map((y) => (y.rules || []).find((o) => o.id === rule.id)).filter(Boolean);
    const worst = outcomes.length ? Math.min(...outcomes.map((o) => o.achieved)) : null;
    const anyText = state.peak?.windows?.length ? `every hour inside ${state.peak.windows.map((w) => `${w.start}–${w.end}`).join(" and ")}` : "every hour of the day";
    const where = `${rule.basis === "monthly" ? "every month" : "each year"}, ${rule.hours === "peak" ? `peak hours ${peakLabel(state.peak)}` : rule.hours === "any" ? `in whichever hours may be picked (${anyText})` : "all hours"}`;
    const fromTender = prov[`rule.${rule.id}`];
    const tenderTarget = fromTender ? Number.parseFloat(String(fromTender.display).replace(/[^\d.]/g, "")) / 100 : null;
    const belowTender = tenderTarget !== null && rule.target < tenderTarget - 1e-9;
    add({
      id: `rule.${rule.id}`, condition: rule.label, source: fromTender,
      tender: fromTender ? `At least ${fromTender.display} of contracted capacity, ${where}` : `Not stated in the tender (model floor ${pf(rule.target, 0)}, ${where})`,
      result: belowTender ? `Model floor ${pf(rule.target, 0)} is below the tender's ${fromTender.display}`
        : worst === null ? "Size the plant to check" : `${pf(worst, 1)} in the worst modelled year (years ${years.map((y) => y.year).join(", ")})`,
      status: belowTender ? "failed" : worst === null ? "info" : outcomes.every((o) => o.met) ? (fromTender || !state.tender ? "met" : "info") : "failed",
    });
  }
  if (prov["peak.hours"]) {
    add({
      id: "peak.hours", condition: "Peak hours per day", source: prov["peak.hours"], tender: prov["peak.hours"].display,
      result: state.rules.some((r) => r.enabled && r.hours === "any")
        ? `Floor checked in each of ${anyHours(state.peak).length} hours that may be picked`
        : `Peak floor checked over ${peakLabel(state.peak)} (${state.peak.hours} h)`,
      status: state.rules.some((r) => r.enabled && r.hours === "any") || state.peak.hours >= Number.parseFloat(prov["peak.hours"].display) ? "met" : "failed",
    });
  }
  if (prov["solar.min"]) {
    const min = state.vars.solarMw.min;
    add({
      id: "solar.min", condition: "Mandatory solar capacity", source: prov["solar.min"], tender: `${prov["solar.min"].display} = ${nf(min, 0)} MW`,
      result: lp ? `${nf(sizes.solarMw, 0)} MW of solar` : "Size the plant to check",
      status: lp ? (sizes.solarMw >= min - 0.5 ? "met" : "failed") : "info",
    });
  }
  if (prov["sources.biomass"]) {
    const allowed = /yes/i.test(prov["sources.biomass"].display);
    const used = (sizes.biomassMw || 0) > 0.5;
    add({
      id: "biomass", condition: "Biomass", source: prov["sources.biomass"], tender: allowed ? "Allowed" : "Not allowed",
      result: !lp ? "Size the plant to check" : used ? `${nf(sizes.biomassMw, 0)} MW of biomass used` : "Offered to the optimizer; not chosen",
      status: !lp ? "info" : !allowed && used ? "failed" : allowed ? "met" : "na",
    });
  }
  if (prov["sources.bess"]) {
    const mandatory = /yes/i.test(prov["sources.bess"].display);
    add({
      id: "storage", condition: "Energy storage", source: prov["sources.bess"], tender: mandatory ? "Mandatory" : "Optional",
      result: lp ? ((sizes.bessMw || 0) > 0.5 ? `${nf(sizes.bessMw, 0)} MW / ${nf(sizes.bessMwh, 0)} MWh battery` : "No battery") : "Size the plant to check",
      status: !lp ? "info" : mandatory ? ((sizes.bessMw || 0) > 0.5 ? "met" : "failed") : "na",
    });
  }
  if (notes.green) {
    add({
      id: "green", condition: "Renewable (traceable green) share", source: notes.green.source, tender: `At least ${notes.green.display}`,
      result: "100% renewable: solar, wind, biomass, and a battery charged from them", status: "met",
    });
  }
  if (notes.nonRe) {
    add({ id: "nonRe", condition: "Non-RE supply with RECs", source: notes.nonRe.source, tender: notes.nonRe.display === "Yes" ? "Allowed" : "Not allowed", result: "Not used", status: "na" });
  }
  if (prov.site) {
    add({ id: "site", condition: "Project location", source: prov.site, tender: prov.site.display, result: state.site?.label || "", status: "info" });
  }
  if (prov["fin.years"]) {
    add({
      id: "term", condition: "PPA term", source: prov["fin.years"], tender: prov["fin.years"].display,
      result: `Financial model over ${state.fin.years} years`,
      status: `${state.fin.years} years` === prov["fin.years"].display ? "met" : "failed",
    });
  }
  const tariff = bidTariff ?? lp?.tariff ?? null;
  add({
    id: "ceiling", condition: "Ceiling tariff", source: prov.ceiling,
    tender: state.ceilingTariff ? `At most ₹${nf(state.ceilingTariff, 2)}/kWh` : "Not stated",
    result: tariff === null ? "Size the plant to check" : `Bid tariff ₹${nf(tariff, 3)}/kWh${bidTariff === null ? " (HiGHS)" : ""}`,
    status: !state.ceilingTariff ? "na" : tariff === null ? "info" : tariff <= state.ceilingTariff + 1e-9 ? "met" : "failed",
  });
  const crore = (perMw) => (perMw ? `₹${nf((perMw * state.plantMw) / 1e7, 2)} cr` : null);
  if (prov["guarantees.emd"]) add({ id: "emd", condition: "Bid security (EMD)", source: prov["guarantees.emd"], tender: prov["guarantees.emd"].display, result: `${state.guarantees.emdPerMwInr ? `₹${nf((state.guarantees.emdPerMwInr * base) / 1e7, 2)} cr` : "–"} for the ${nf(base, 0)} MW bid`, status: "info" });
  if (prov["guarantees.pbg"]) add({ id: "pbg", condition: "Performance guarantee (PBG)", source: prov["guarantees.pbg"], tender: prov["guarantees.pbg"].display, result: `${crore(state.guarantees.pbgPerMwInr)} for ${nf(state.plantMw, 0)} MW`, status: "info" });
  if (notes.start) add({ id: "start", condition: "Supply start date", source: notes.start.source, tender: notes.start.display, result: "Build schedule is not modelled", status: "info" });
  const sold = (lp?.perYear || []).some((y) => y.divertedMu !== undefined);
  if (lp && sold) {
    const diverted = Math.max(...lp.perYear.map((y) => y.divertedMu || 0));
    add({
      id: "ppaFirst", condition: "PPA supplied before any market sale", source: prov.ppaFirst || null,
      tender: prov.ppaFirst ? "Priority to the PPA before any sale" : "Not stated in the tender; applied as your instruction",
      result: diverted < 0.01 ? "Nothing sold while the PPA had room, in every modelled year" : `${nf(diverted, 1)} MU sold while the PPA had room`,
      status: diverted < 0.01 ? "met" : "failed",
    });
    const solarOnly = lp.exportSources === "solar";
    add({
      id: "market", condition: "What may be sold in the market", source: prov["market.sale"] || null,
      tender: prov["market.sale"]?.display || "Not stated",
      result: `${solarOnly ? "Solar surplus only" : "Any surplus"}, at ${lp.market ? `IEX ${lp.market} hourly prices` : `₹${nf(lp.flatPrice, 2)}/kWh`}`,
      status: !state.tender ? "info" : !prov["market.sale"] || /not allowed/i.test(prov["market.sale"].display) ? "failed" : /mandated solar/i.test(prov["market.sale"].display) ? (solarOnly ? "met" : "failed") : "met",
    });
  }
  return rows;
}

export default function Checklist({ state, lp, bidTariff = null, index = "3.4" }) {
  const rows = buildChecklist(state, lp, bidTariff);
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

/** Every model input the tender does not set: the bidder's own numbers, listed openly. */
export function BidderInputs({ state, prices, index = "3.5" }) {
  const { costs, fin, bess, biomass, sources, inputs } = state;
  const prov = state.provenance || {};
  const rows = [];
  const add = (input, value, why) => rows.push({ input, value, why });
  const profile = (kind, cuf) => (state[`${kind}Upload`] ? `${state[`${kind}Upload`].name}` : `Synthetic profile, CUF ${pf(cuf, 1)}`);
  if (sources.solar) {
    add("Solar resource", profile("solar", inputs.solarCuf), "Hourly output; the tender does not give a site");
    add("Solar cost", `₹${nf(costs.solarCrPerMw, 2)} cr/MW · O&M ₹${nf(fin.solarOmLakhPerMw, 1)} lakh/MW/yr · ${pf(fin.solarDegradation, 2)}/yr degradation`, "Bidder's cost");
  }
  if (sources.wind) {
    add("Wind resource", profile("wind", inputs.windCuf), "Hourly output; the tender does not give a site");
    add("Wind cost", `₹${nf(costs.windCrPerMw, 2)} cr/MW · O&M ₹${nf(fin.windOmLakhPerMw, 1)} lakh/MW/yr`, "Bidder's cost");
  }
  if (sources.biomass) {
    add("Biomass operation", `availability ${pf(biomass.availability, 0)} · fuel-limited PLF ${pf(biomass.maxPlf, 0)} · minimum load ${pf(biomass.minLoad, 0)}`, "Plant and fuel supply");
    add("Biomass cost", `₹${nf(costs.biomassCrPerMw, 2)} cr/MW · O&M ₹${nf(fin.biomassOmLakhPerMw, 0)} lakh/MW/yr · fuel ₹${nf(fin.biomassFuelRsPerKwh, 2)}/kWh, +${pf(fin.biomassFuelEscalation, 1)}/yr`, "Bidder's cost");
  }
  if (sources.bess) {
    add("Battery", `${bess.durationH ? `${bess.durationH}-hour` : "free duration"} · RTE ${pf(bess.rte, 1)}${prov["bess.rte"] ? " (tender)" : ""} · fade ${pf(bess.annualDegradation, 1)}/yr · augmentation ${bess.augmentation}`, "Technology choice");
    add("Battery cost", `₹${nf(costs.bessCrPerMwh, 2)} cr/MWh · O&M ₹${nf(fin.bessOmLakhPerMwh, 1)} lakh/MWh/yr`, "Bidder's cost");
  }
  add("Financing", `equity IRR ${pf(fin.targetEquityIrr, 1)} · debt ${pf(fin.debtFraction, 0)} at ${pf(fin.interestRate, 2)} for ${fin.tenorYears} years · tax ${pf(fin.taxRate, 2)}`, "Bidder's cost of capital");
  if (fin.sellSurplus && prov["market.sale"]) {
    const m = prices?.markets?.[state.market?.source];
    add("Market prices", state.market?.source === "flat" ? `flat ₹${nf(fin.surplusPrice, 2)}/kWh` : `IEX ${state.market?.source}${m ? `, ${m.from} to ${m.to}` : ""}, escalation ${pf(state.market?.escalation || 0, 1)}/yr`, "Your market data; the tender sets no price");
  }
  if (!prov.ppaFirst && fin.sellSurplus && prov["market.sale"]) add("PPA before any sale", "Applied", "Your instruction; the tender does not state it");
  const peakRule = state.rules.find((r) => r.id === "peak" && r.enabled);
  if (peakRule?.hours === "peak" && !prov["peak.setBy"]) add("Peak window", peakLabel(state.peak), "The tender does not fix the hours");
  if (!prov.plantMw) add("Contracted capacity", `${nf(state.plantMw, 0)} MW`, "Not read from a tender");
  return (
    <Section index={index} title="Inputs the tender does not set" note="The bidder's own numbers; change them on this page">
      <div className="bid-checklist" role="table" data-testid="bid-inputs">
        <div className="bid-checklist-row head bid-inputs-row" role="row"><span>Input</span><span>Value used</span><span>Why it is needed</span></div>
        {rows.map((r) => (
          <div key={r.input} className="bid-checklist-row bid-inputs-row" role="row">
            <span><strong>{r.input}</strong></span><span>{r.value}</span><span className="rtc-note">{r.why}</span>
          </div>
        ))}
      </div>
    </Section>
  );
}
