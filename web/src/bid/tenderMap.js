// Tender to Bid: turn the fields read from a tender (tender_intel result) into proposed model
// inputs. Each proposal keeps the field it came from (page and quote) so every input on the
// Size and Financials steps can be traced back to the tender.
import { DEFAULT_RULES, scaledVars } from "./model.js";

const pct = (v) => (Number.isFinite(v) ? v / 100 : null);
const fmtPct = (v) => `${Math.round(v * 1000) / 10}%`;
const fmtMw = (v) => `${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 1 }).format(v)} MW`;
const fmtInr = (v) => `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(v)}`;

export function fieldIndex(result) {
  const index = {};
  for (const section of result?.sections || []) for (const f of section.fields || []) index[f.path] = { ...f, section: section.label };
  return index;
}

function stated(index, result, path) {
  const f = index[path];
  if (!f || f.status === "not_found" || f.status === "rejected") return null;
  const value = result.values?.[path] ?? f.value;
  return value === null || value === undefined ? null : { value, field: f };
}

/** The first of several paths the tender states, as { value, field }. */
function first(index, result, paths, pick = (v) => v) {
  for (const p of paths) {
    const hit = stated(index, result, p.path || p);
    if (!hit) continue;
    const v = p.key ? hit.value?.[p.key] : hit.value;
    const picked = v === null || v === undefined ? null : pick(v);
    if (picked !== null && picked !== undefined && !(typeof picked === "number" && !Number.isFinite(picked))) {
      return { value: picked, field: hit.field, key: p.key || null };
    }
  }
  return null;
}

export function sourceOf(hit) {
  if (!hit) return null;
  const ev = (hit.field.evidence || []).find((e) => e.located) || (hit.field.evidence || [])[0] || null;
  return {
    path: hit.field.path + (hit.key ? `.${hit.key}` : ""),
    label: hit.field.label,
    section: hit.field.section,
    status: hit.field.status,
    confidence: hit.field.confidence,
    page: ev?.page ?? null,
    quote: ev?.quote ?? null,
    located: Boolean(ev?.located),
  };
}

const F = "sector.power.fdre";
const C = "sector.power.common";
const DP = `${F}.demand_profile_structured`;

/**
 * Proposals for the model, in display order. Each: { id, group, label, display, value,
 * source, apply(state, value) -> state, info } — info proposals are shown but set nothing.
 */
export function buildProposals(result) {
  if (!result) return [];
  const index = fieldIndex(result);
  const out = [];
  const add = (p) => out.push({ group: "Supply obligation", info: false, ...p, source: sourceOf(p.hit), stated: Boolean(p.hit) });

  // ---- contracted capacity
  const maxBid = first(index, result, [`${C}.max_bid_mw`]);
  const total = first(index, result, [`${C}.total_capacity_mw`]);
  const cap = maxBid && total && maxBid.value < total.value ? maxBid : total || maxBid;
  const greenshoe = first(index, result, [`${C}.greenshoe_capacity_mw`]);
  add({
    id: "plantMw", group: "Contract", label: "Contracted supply capacity", hit: cap, value: cap?.value,
    display: cap ? fmtMw(cap.value) : null,
    note: [cap === maxBid && total ? `Tender total ${fmtMw(total.value)}; one bidder may offer up to ${fmtMw(maxBid.value)}` : null,
      greenshoe ? `Greenshoe option of ${fmtMw(greenshoe.value)} not included in the sizing` : null].filter(Boolean).join(". ") || "Sizing is for this capacity; edit it to size for a different bid",
    apply: (s, v) => ({ ...s, plantMw: v, vars: scaledVars(v, s.vars) }),
  });

  // ---- supply rules
  const rule = (id, label, hit, basis, hours) => add({
    id: `rule.${id}`, label, hit, value: hit ? pct(hit.value) : null, display: hit ? fmtPct(pct(hit.value)) : null,
    note: `${basis === "monthly" ? "Every month" : "Each year"}, ${hours === "peak" ? "peak hours" : "all hours"}, as a share of contracted capacity`,
    apply: (s, v) => ({
      ...s,
      rules: (s.rules?.length ? s.rules : DEFAULT_RULES).map((r) => (r.id === id ? { ...r, target: v, basis: r.id === "annual" ? "annual" : r.basis, enabled: true } : r)),
    }),
  });
  rule("annual", "Annual supply floor", first(index, result, [`${F}.annual_supply_min_pct`, { path: DP, key: "cuf_declared_min_pct" }, "sector.power.hybrid.combined_cuf_floor_percent"]), "annual", "all");
  rule("monthly", "Monthly supply floor", first(index, result, [`${F}.monthly_supply_min_pct`]), "monthly", "all");
  rule("peak", "Peak-hour supply floor", first(index, result, [`${F}.peak_supply_min_pct`, { path: DP, key: "peak_availability_pct" }, `${F}.assured_availability_percent`]), "monthly", "peak");

  const peakHrs = first(index, result, [`${F}.peak_hours_per_day`, { path: DP, key: "peak_hours_per_day" }]);
  add({
    id: "peak.hours", label: "Peak hours per day", hit: peakHrs, value: peakHrs?.value, display: peakHrs ? `${peakHrs.value} h` : null,
    note: "The tender may let the procurer choose the hours; the window start is set on the Size step",
    apply: (s, v) => ({ ...s, peak: { ...s.peak, hours: Math.max(1, Math.min(24, Math.round(v))) } }),
  });
  const block = first(index, result, [{ path: DP, key: "peak_blocks" }], (v) => (Array.isArray(v) && v[0]?.window_start ? v[0].window_start : null));
  if (block) {
    add({
      id: "peak.start", label: "Peak window starts", hit: block, value: Number(String(block.value).slice(0, 2)), display: block.value,
      apply: (s, v) => ({ ...s, peak: { ...s.peak, start: v } }),
    });
  }

  // ---- sources and plant
  const bio = first(index, result, [`${F}.biomass_permitted`]);
  const listed = first(index, result, [`${F}.permitted_re_sources`], (v) => (Array.isArray(v) ? v : [String(v)]));
  const bioListed = listed ? listed.value.some((x) => /bio/i.test(x)) : null;
  const bioHit = bio || (bioListed !== null ? { ...listed, value: bioListed } : null);
  add({
    id: "sources.biomass", group: "Sources", label: "Biomass allowed", hit: bioHit, value: bioHit ? Boolean(bioHit.value) : null,
    display: bioHit ? (bioHit.value ? "Yes" : "No") : null,
    note: listed ? `Sources named: ${listed.value.join(", ")}` : "Biomass is offered to the optimizer when allowed",
    apply: (s, v) => ({ ...s, sources: { ...s.sources, biomass: Boolean(v) } }),
  });
  const solarMult = first(index, result, [`${F}.min_solar_capacity_multiple`]);
  add({
    id: "solar.min", group: "Sources", label: "Mandatory solar capacity", hit: solarMult, value: solarMult?.value,
    display: solarMult ? `${solarMult.value} × contracted capacity` : null,
    note: "Sets the smallest solar size. Its surplus may be sold in the market over its own connection, so surplus sales are on with that connection as extra export capacity",
    apply: (s, v) => {
      const min = Math.round(v * s.plantMw);
      const cur = s.vars.solarMw;
      return {
        ...s,
        sources: { ...s.sources, solar: true },
        vars: { ...s.vars, solarMw: { ...cur, locked: false, min, max: Math.max(cur.max, Math.round(min * 1.5)), value: Math.max(cur.value, min) } },
        fin: { ...s.fin, sellSurplus: true, extraExportMw: min },
      };
    },
  });
  const storage = first(index, result, [`${F}.storage_mandatory`]);
  add({
    id: "sources.bess", group: "Sources", label: "Energy storage mandatory", hit: storage, value: storage?.value,
    display: storage ? (storage.value ? "Yes" : "No") : null,
    note: "When mandatory the battery cannot be switched off",
    apply: (s, v) => (v ? { ...s, sources: { ...s.sources, bess: true }, bessMandatory: true } : { ...s, bessMandatory: false }),
  });
  const rte = first(index, result, ["sector.power.bess.round_trip_efficiency_guarantee_percent"]);
  if (rte) {
    add({
      id: "bess.rte", group: "Sources", label: "Battery round-trip efficiency", hit: rte, value: pct(rte.value), display: fmtPct(pct(rte.value)),
      apply: (s, v) => ({ ...s, bess: { ...s.bess, rte: v } }),
    });
  }

  // ---- location
  const loc = first(index, result, [`${C}.location_constraint`]);
  const places = first(index, result, [`${C}.named_states_or_sites`], (v) => (Array.isArray(v) ? v : [String(v)]));
  const locText = loc ? { ists_anywhere: "Anywhere in India (ISTS)", state_specific: "Within a named state", named_substation: "At a named substation", named_site: "At a named site" }[loc.value] || loc.value : null;
  add({
    id: "site", group: "Location", label: "Project location", hit: loc || places, value: { constraint: loc?.value || null, places: places?.value || [] },
    display: [locText, places?.value?.join(", ")].filter(Boolean).join(" · ") || null,
    note: loc?.value === "ists_anywhere" ? "Choose the best solar and wind sites: pick their profiles on the Size step" : "Pick solar and wind profiles from this region on the Size step",
    apply: (s, v) => ({ ...s, site: { ...s.site, constraint: v.constraint, places: v.places, label: [locText, (v.places || []).join(", ")].filter(Boolean).join(" · ") || s.site.label } }),
  });
  const delivery = first(index, result, [`${C}.delivery_point`]);
  if (delivery) add({ id: "delivery", group: "Location", label: "Delivery point", hit: delivery, value: delivery.value, display: String(delivery.value), info: true });

  // ---- commercial
  const years = first(index, result, [`${C}.ppa_tenure_years`]);
  add({
    id: "fin.years", group: "Commercial", label: "PPA term", hit: years, value: years?.value, display: years ? `${years.value} years` : null,
    apply: (s, v) => ({ ...s, fin: { ...s.fin, years: Math.max(5, Math.min(35, Math.round(v))) } }),
  });
  const ceiling = first(index, result, [`${C}.tariff_ceiling_inr_per_kwh`]);
  add({
    id: "ceiling", group: "Commercial", label: "Ceiling tariff", hit: ceiling, value: ceiling?.value, display: ceiling ? `₹${ceiling.value}/kWh` : null,
    note: "Compared with the bid tariff on the Financials step",
    apply: (s, v) => ({ ...s, ceilingTariff: v }),
  });
  const emd = first(index, result, ["core.guarantees.emd_per_mw_inr"]);
  const pbg = first(index, result, ["core.guarantees.pbg_per_mw_inr"]);
  add({
    id: "guarantees.emd", group: "Commercial", label: "Bid security (EMD)", hit: emd, value: emd?.value, display: emd ? `${fmtInr(emd.value)} per MW` : null,
    apply: (s, v) => ({ ...s, guarantees: { ...s.guarantees, emdPerMwInr: v } }),
  });
  add({
    id: "guarantees.pbg", group: "Commercial", label: "Performance guarantee (PBG)", hit: pbg, value: pbg?.value, display: pbg ? `${fmtInr(pbg.value)} per MW` : null,
    apply: (s, v) => ({ ...s, guarantees: { ...s.guarantees, pbgPerMwInr: v } }),
  });

  // ---- facts shown with the model, not modelled
  const info = (id, group, label, hit, display, note) => hit && add({ id, group, label, hit, value: hit.value, display, note, info: true });
  const green = first(index, result, [`${F}.green_share_min_pct`, { path: DP, key: "re_share_min_pct" }]);
  info("green", "Supply obligation", "Least renewable (traceable green) share", green, green ? `${green.value}%` : null,
    "This model supplies only renewable energy (solar, wind, biomass, battery), so it meets this share");
  const nonRe = first(index, result, [`${F}.non_re_allowed`]);
  info("nonRe", "Supply obligation", "Non-RE supply allowed", nonRe, nonRe ? (nonRe.value ? "Yes" : "No") : null,
    nonRe?.value ? "Not modelled: buying non-RE power with RECs could lower the bid tariff" : null);
  const start = first(index, result, [`${F}.supply_start_date`]);
  info("start", "Commercial", "Supply start date", start, start ? String(start.value) : null, null);
  const shortfall = first(index, result, [`${F}.shortfall_compensation_multiple`]);
  info("shortfall", "Commercial", "Shortfall compensation", shortfall, shortfall ? `${shortfall.value} × tariff` : null, "The sizing meets the floors, so no shortfall is planned");
  const deadline = first(index, result, ["core.key_dates.bid_submission_deadline"]);
  info("deadline", "Commercial", "Bid submission deadline", deadline, deadline ? String(deadline.value) : null, null);
  return out;
}

/** Apply the accepted proposals (default: every stated, non-info proposal) to the model. */
export function applyProposals(state, proposals, accepted = {}) {
  let next = { ...state, provenance: { ...state.provenance } };
  const notes = [];
  // capacity first: other inputs (solar minimum) scale with it
  const ordered = [...proposals].sort((a, b) => (a.id === "plantMw" ? -1 : b.id === "plantMw" ? 1 : 0));
  for (const p of ordered) {
    if (!p.stated) continue;
    if (p.info) {
      notes.push({ id: p.id, label: p.label, display: p.display, note: p.note, source: p.source });
      continue;
    }
    if (accepted[p.id] === false) continue;
    next = p.apply(next, p.value);
    next.provenance[p.id] = { label: p.label, display: p.display, ...p.source };
  }
  return { ...next, notes };
}
