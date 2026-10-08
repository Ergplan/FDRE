// Tender to Bid: what the tender requires, from the fields the tender engine read (tender_intel
// result). tenderTerms() turns them into the constraints the sizing uses; every term keeps the
// field it came from (page and quote). Nothing here is a bidder input or an assumption: a term
// the tender does not state is shown as not stated and is not applied.

const fmtMw = (v) => `${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 1 }).format(v)} MW`;
const fmtInr = (v) => `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(v)}`;
const fmtDate = (v) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v));
  return m ? `${m[3]}.${m[2]}.${m[1]}` : String(v);
};

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

// Issues that mean the page does not prove the value: its quote was not found, or the quote
// does not print it, or it is not of its type. Plausibility checks (a ratio, a range) do not.
const UNPROVED = new Set(["evidence_not_located", "value_in_quotes", "structured_numbers_quoted", "type"]);

export function sourceOf(hit) {
  if (!hit) return null;
  const ev = (hit.field.evidence || []).find((e) => e.located) || (hit.field.evidence || [])[0] || null;
  const proved = Boolean(ev?.located) && !(hit.field.issues || []).some((i) => !i.warning && UNPROVED.has(i.rule));
  return {
    proved,
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

/** Whether a term is used: one the page proves is used unless unticked; one it does not prove
 * (quote not found, or not printing the value) only when the reviewer ticks it. */
export function isUsed(p, accepted = {}) {
  if (!p.stated) return false;
  if (p.source?.proved) return accepted[p.id] !== false;
  return accepted[p.id] === true;
}

/**
 * Every requirement the tender states, in display order, as rows of the one-page list:
 * { id, group, label, display, effect, source, stated, apply(terms, value) }.
 */
export function buildProposals(result) {
  if (!result) return [];
  const index = fieldIndex(result);
  const out = [];
  const add = (p) => out.push({ group: "Supply", ...p, source: sourceOf(p.hit), stated: Boolean(p.hit) });

  // ---- capacity
  const total = first(index, result, [`${C}.total_capacity_mw`]);
  const maxBid = first(index, result, [`${C}.max_bid_mw`]);
  const minBid = first(index, result, [`${C}.min_bid_mw`]);
  add({ id: "capacity", group: "Capacity", label: "Base supply capacity", hit: total, value: total?.value, display: total ? fmtMw(total.value) : null,
    effect: "The capacity you bid is checked against it", apply: (t, v) => ({ ...t, baseMw: v }) });
  const part = first(index, result, [`${C}.part_capacity_allowed`]);
  add({ id: "part", group: "Capacity", label: "Part capacity allowed", hit: part, value: part?.value, display: part ? (part.value ? "Yes" : "No: a single bidder bids the whole capacity") : null,
    effect: "A bid for less than the base capacity is refused", apply: (t, v) => ({ ...t, partAllowed: Boolean(v) }) });
  if (maxBid) add({ id: "maxBid", group: "Capacity", label: "Most one bidder may offer", hit: maxBid, value: maxBid.value, display: fmtMw(maxBid.value), effect: "The bid may not exceed it", apply: (t, v) => ({ ...t, maxBidMw: v }) });
  if (minBid) add({ id: "minBid", group: "Capacity", label: "Least one bidder may offer", hit: minBid, value: minBid.value, display: fmtMw(minBid.value), effect: "The bid may not be below it", apply: (t, v) => ({ ...t, minBidMw: v }) });
  const greenshoe = first(index, result, [`${C}.greenshoe_capacity_mw`]);
  add({ id: "greenshoe", group: "Capacity", label: "Greenshoe capacity", hit: greenshoe, value: greenshoe?.value, display: greenshoe ? `${fmtMw(greenshoe.value)}, at the procurer's option` : null,
    effect: "You choose whether the plant is sized for it too", apply: (t, v) => ({ ...t, greenshoeMw: v }) });
  const gsStart = first(index, result, [`${C}.greenshoe_supply_start_date`]);
  add({ id: "greenshoeStart", group: "Capacity", label: "Greenshoe supply start", hit: gsStart, value: gsStart?.value, display: gsStart ? fmtDate(gsStart.value) : null,
    effect: "Shown; the sizing supplies the full capacity from year 1", apply: (t, v) => ({ ...t, greenshoeStart: v }) });
  const gsTariff = first(index, result, [`${C}.greenshoe_same_tariff`]);
  add({ id: "greenshoeTariff", group: "Capacity", label: "Greenshoe tariff", hit: gsTariff, value: gsTariff?.value, display: gsTariff ? (gsTariff.value ? "Same terms and tariff as the base capacity" : "Different tariff") : null,
    effect: "One tariff is priced for the whole capacity", apply: (t, v) => ({ ...t, greenshoeSameTariff: Boolean(v) }) });

  // ---- supply floors
  const pct = (v) => v / 100;
  const floor = (id, label, hit, basis, hours) => add({
    id: `rule.${id}`, label, hit, value: hit ? pct(hit.value) : null, display: hit ? `At least ${hit.value}% CUF` : null,
    effect: `${basis === "monthly" ? "Every month" : "Every year"}: delivered ÷ (contracted MW × hours)${hours === "all" ? "" : " in peak hours"} ≥ ${hit ? hit.value : "?"}%`,
    apply: (t, v) => ({ ...t, rules: [...(t.rules || []).filter((r) => r.id !== id), { id, label, basis, hours, target: v }] }),
  });
  floor("annual", "Annual supply floor", first(index, result, [`${F}.annual_supply_min_pct`, { path: DP, key: "cuf_declared_min_pct" }, "sector.power.hybrid.combined_cuf_floor_percent"]), "annual", "all");
  floor("monthly", "Monthly supply floor", first(index, result, [`${F}.monthly_supply_min_pct`]), "monthly", "all");
  floor("peak", "Peak-hour supply floor", first(index, result, [`${F}.peak_supply_min_pct`, { path: DP, key: "peak_availability_pct" }, `${F}.assured_availability_percent`]), "monthly", "peak");
  const peakHrs = first(index, result, [`${F}.peak_hours_per_day`, { path: DP, key: "peak_hours_per_day" }]);
  add({ id: "peak.hours", label: "Peak hours per day", hit: peakHrs, value: peakHrs?.value, display: peakHrs ? `${peakHrs.value} h` : null,
    effect: "The length of the peak each day", apply: (t, v) => ({ ...t, peak: { ...t.peak, hours: Math.max(1, Math.min(24, Math.round(v))) } }) });
  const setBy = first(index, result, [`${F}.peak_hours_set_by`]);
  const blocks = first(index, result, [{ path: DP, key: "peak_blocks" }], (v) => (Array.isArray(v) && v.some((b) => b.window_start && b.window_end) ? v : null));
  const windows = blocks ? blocks.value.filter((b) => b.window_start && b.window_end).map((b) => ({ start: b.window_start, end: b.window_end, hours: b.hours ?? null })) : [];
  const setByText = { procurer: "The procurer decides the hours", tender: "The tender prints the windows", supplier: "The supplier chooses the hours" };
  if (setBy || windows.length) {
    const who = setBy?.value || "tender";
    add({
      id: "peak.setBy", label: "Who sets the peak hours", hit: setBy || blocks, value: { who, windows },
      display: [setByText[who] || who, windows.length ? windows.map((w) => `${w.start}–${w.end}`).join(" and ") : null].filter(Boolean).join(": "),
      effect: who === "supplier" ? "Checked in the window you choose"
        : `Checked in every hour ${windows.length ? "inside these windows" : "of the day"}, every month, since any of them may be picked (the tender does not state the measuring period; the stricter monthly check is used)`,
      apply: (t, v) => ({ ...t, peak: { ...t.peak, setBy: v.who, windows: v.windows }, peakAny: v.who !== "supplier" }),
    });
  }

  // ---- sources
  const listed = first(index, result, [`${F}.permitted_re_sources`], (v) => (Array.isArray(v) ? v : [String(v)]));
  add({ id: "sources", group: "Sources", label: "Renewable sources named", hit: listed, value: listed?.value, display: listed ? listed.value.join(", ") : null,
    effect: "Only these renewable sources (and the non-RE below) can be switched on",
    apply: (t, v) => {
      const has = (re) => v.some((x) => re.test(x));
      return { ...t, permitted: { ...t.permitted, solar: has(/solar/i), wind: has(/wind/i), hydro: has(/hydro/i), biomass: has(/bio/i), bess: has(/storage|battery|bess/i) } };
    } });
  const bio = first(index, result, [`${F}.biomass_permitted`]);
  if (bio && !listed) add({ id: "biomass", group: "Sources", label: "Biomass allowed", hit: bio, value: bio.value, display: bio.value ? "Yes" : "No", effect: "Biomass can be switched on", apply: (t, v) => ({ ...t, permitted: { ...t.permitted, biomass: Boolean(v) } }) });
  const nonRe = first(index, result, [`${F}.non_re_allowed`]);
  add({ id: "nonRe", group: "Sources", label: "Non-RE supply", hit: nonRe, value: nonRe?.value, display: nonRe ? (nonRe.value ? "Allowed for the balance, with RECs for every non-RE unit" : "Not allowed") : null,
    effect: "Thermal (non-RE) can be switched on; RECs are costed on every non-RE kWh", apply: (t, v) => ({ ...t, permitted: { ...t.permitted, thermal: Boolean(v) } }) });
  const green = first(index, result, [`${F}.green_share_min_pct`, { path: DP, key: "re_share_min_pct" }]);
  add({ id: "green", group: "Sources", label: "Least traceable green share", hit: green, value: green ? pct(green.value) : null, display: green ? `${green.value}% of supply, each accounting year` : null,
    effect: "Every year: non-RE energy ≤ the rest of the supply", apply: (t, v) => ({ ...t, greenMin: v }) });
  const solarMult = first(index, result, [`${F}.min_solar_capacity_multiple`]);
  add({ id: "solar.min", group: "Sources", label: "Mandatory solar capacity", hit: solarMult, value: solarMult?.value, display: solarMult ? `${solarMult.value} × the contracted capacity` : null,
    effect: "Solar is required, at least this size", apply: (t, v) => ({ ...t, solarMultiple: v, mandatory: { ...t.mandatory, solar: true } }) });
  const storage = first(index, result, [`${F}.storage_mandatory`]);
  add({ id: "storage", group: "Sources", label: "Energy storage mandatory", hit: storage, value: storage?.value, display: storage ? (storage.value ? "Yes" : "No") : null,
    effect: "When mandatory the battery must be switched on", apply: (t, v) => ({ ...t, mandatory: { ...t.mandatory, bess: Boolean(v) } }) });
  const sale = first(index, result, [`${F}.market_sale_scope`]);
  const saleText = { mandated_solar: "The mandated solar may be scheduled in the market", any_capacity: "Energy may be sold to a third party or on a power exchange", not_allowed: "No sale outside the PPA" };
  add({ id: "market.sale", group: "Sources", label: "Sale in the market", hit: sale, value: sale?.value, display: sale ? saleText[sale.value] || sale.value : null,
    effect: sale?.value === "mandated_solar" ? "Only solar surplus may be sold, after the PPA is supplied each hour" : "Only what the tender allows may be sold",
    apply: (t, v) => ({ ...t, sale: v }) });
  const priority = first(index, result, [`${F}.ppa_priority_before_sale`]);
  add({ id: "ppaFirst", group: "Sources", label: "PPA before any sale", hit: priority, value: priority?.value, display: priority ? (priority.value ? "Yes" : "No") : null,
    effect: "Every hour the PPA is supplied first; only what it cannot take is sold", apply: (t) => t });
  const loc = first(index, result, [`${C}.location_constraint`]);
  const locText = loc ? { ists_anywhere: "Anywhere in India (ISTS)", state_specific: "Within a named state", named_substation: "At a named substation", named_site: "At a named site" }[loc.value] || loc.value : null;
  add({ id: "site", group: "Sources", label: "Project location", hit: loc, value: loc?.value, display: locText, effect: "Your solar and wind profiles should be from sites that qualify", apply: (t, v) => ({ ...t, site: v }) });

  // ---- term, dates and money
  const years = first(index, result, [`${C}.ppa_tenure_years`]);
  add({ id: "years", group: "Commercial", label: "PPA term", hit: years, value: years?.value, display: years ? `${years.value} years` : null,
    effect: "Years modelled and financed", apply: (t, v) => ({ ...t, years: Math.max(5, Math.min(35, Math.round(v))) }) });
  const start = first(index, result, [`${F}.supply_start_date`]);
  add({ id: "start", group: "Commercial", label: "Supply start date (base)", hit: start, value: start?.value, display: start ? fmtDate(start.value) : null, effect: "Shown; build time is not modelled", apply: (t, v) => ({ ...t, supplyStart: v }) });
  const ceiling = first(index, result, [`${C}.tariff_ceiling_inr_per_kwh`]);
  add({ id: "ceiling", group: "Commercial", label: "Ceiling tariff", hit: ceiling, value: ceiling?.value, display: ceiling ? `₹${ceiling.value}/kWh` : null, effect: "The bid tariff is compared with it", apply: (t, v) => ({ ...t, ceiling: v }) });
  const emd = first(index, result, ["core.guarantees.emd_per_mw_inr"]);
  add({ id: "emd", group: "Commercial", label: "Bid security (EMD)", hit: emd, value: emd?.value, display: emd ? `${fmtInr(emd.value)} per MW` : null, effect: "Money at stake, on the bid capacity", apply: (t, v) => ({ ...t, emdPerMw: v }) });
  const pbg = first(index, result, ["core.guarantees.pbg_per_mw_inr"]);
  add({ id: "pbg", group: "Commercial", label: "Performance guarantee (PBG)", hit: pbg, value: pbg?.value, display: pbg ? `${fmtInr(pbg.value)} per MW` : null, effect: "Money at stake, on the contracted capacity", apply: (t, v) => ({ ...t, pbgPerMw: v }) });
  const deadline = first(index, result, ["core.key_dates.bid_submission_deadline"]);
  add({ id: "deadline", group: "Commercial", label: "Bid submission deadline", hit: deadline, value: deadline?.value, display: deadline ? fmtDate(deadline.value) : null, effect: "Shown", apply: (t, v) => ({ ...t, deadline: v }) });
  return out;
}

const EMPTY_TERMS = {
  baseMw: null, greenshoeMw: null, partAllowed: null, maxBidMw: null, minBidMw: null, greenshoeStart: null, greenshoeSameTariff: null,
  rules: [], peak: { start: 18, hours: 4, setBy: null, windows: [] }, peakAny: false,
  permitted: { solar: null, wind: null, hydro: null, biomass: null, thermal: null, bess: null },
  mandatory: { solar: false, bess: false },
  greenMin: null, solarMultiple: null, sale: null, site: null, years: null, supplyStart: null,
  ceiling: null, emdPerMw: null, pbgPerMw: null, deadline: null, provenance: {},
};

/** The constraints the sizing uses: every term the tender states and the page proves (or the reviewer ticked). */
export function tenderTerms(result, accepted = {}) {
  let terms = { ...EMPTY_TERMS, permitted: { ...EMPTY_TERMS.permitted }, mandatory: { ...EMPTY_TERMS.mandatory }, peak: { ...EMPTY_TERMS.peak }, provenance: {} };
  for (const p of buildProposals(result)) {
    if (!isUsed(p, accepted)) continue;
    terms = p.apply(terms, p.value);
    terms.provenance[p.id] = { label: p.label, display: p.display, ...p.source };
  }
  // a peak floor whose hours the procurer picks is checked in every hour it may pick
  terms.rules = ["annual", "monthly", "peak"].map((id) => terms.rules.find((r) => r.id === id)).filter(Boolean)
    .map((r) => (r.id === "peak" && terms.peakAny ? { ...r, hours: "any" } : r));
  return terms;
}
