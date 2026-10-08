// Pre-bid queries for the WBSEDCL RE-RTC RfQ/RfP (WBSEDCL/PT&P/RE-RTC/2026/01), most tariff
// impact first. Each query cites the clause and page it asks about and quotes the RFP word for word
// (tests/test_tender_intel.py checks every quote against its page when the RFP is available).
// "query" and "rationale" go to WBSEDCL; "impact" and "model" are the bidder's own notes.

export const PREBID_TENDER = "WBSEDCL/PT&P/RE-RTC/2026/01";

/** The title the RFP prescribes for queries (RFP clause 1.1.10, page 48). */
export const PREBID_TITLE = "Queries/Request for Additional Information: RFP for 1500MW with 500MW green shoe option Supply Capacity";

export const PREBID_HOW = {
  clause: "RFP 1.1.10",
  page: 48,
  quote: "Any queries or request for additional information concerning this RFP shall be submitted in writing online at the [TCIL Portal] or by speed post/courier and by e- mail attaching the queries in Microsoft word file",
};

export const PREBID_QUERIES = [
  {
    id: "peak",
    topic: "Peak hours: window, notice and how the 90% is measured",
    refs: [
      { clause: "RFQ 1.1.1", page: 10, quote: "Supply of minimum 90% CUF during Peak hours (Discharging 4 Hours Daily - single stretch of 4 hours or 4 hours in total in multiple stretches, as decided by WBSEDCL)" },
    ],
    query: [
      "Clause 1.1.1 requires a minimum 90% CUF during Peak hours (4 hours daily, in a single stretch or in multiple stretches, as decided by WBSEDCL), but the Bidding Documents do not define the Peak hours. Please clarify:",
      "(a) the window(s) of the day within which WBSEDCL will select the 4 Peak hours (for example 18:00–22:00 hrs), and whether the window differs by season or month;",
      "(b) the advance notice WBSEDCL will give of the Peak hours (day-ahead, monthly or annually), and whether they may change within a month;",
      "(c) the minimum length of each stretch when the 4 hours are split; and",
      "(d) whether the 90% Peak-hour CUF is assessed for each day, each month or each Accounting Year.",
    ].join("\n"),
    rationale: "Without a defined window every Bidder must size storage to supply 90% in any hour of the day, which raises the tariff for all Bidders. A defined window notified in advance lets Bidders size storage for WBSEDCL's actual peak and offer a lower tariff.",
    impact: "The biggest storage lever. The model now checks the 90% floor in every hour, because WBSEDCL may pick any four. A fixed evening window lets the battery charge outside it, so the battery and biomass can be smaller.",
    model: "Step 1.1 (peak floor) → Step 5 sizing",
  },
  {
    id: "market",
    topic: "Sale of the mandated Solar Power Capacity in the market: any cap?",
    refs: [
      { clause: "RFQ 1.1.2", page: 11, quote: "The Selected Bidder shall be entitled to schedule the entire Solar Power capacity so developed at its discretion, towards the RE RTC PPA or in the market, in accordance with the applicable Grid Code, scheduling regulations and provisions of the PPA." },
      { clause: "RFP 5.3.1", page: 62, quote: "The Bidder shall be entitled to schedule the entire Solar Power Capacity so developed at its discretion in accordance with the applicable Grid Code, scheduling regulations and provisions of this PPA." },
    ],
    query: [
      "Clause 1.1.2 of the RFQ entitles the Selected Bidder to schedule the entire Solar Power Capacity towards the RE RTC PPA or in the market, while Clause 5.3.1 of the RFP omits the words \"or in the market\". Please confirm:",
      "(a) that the Selected Bidder may sell on the power exchanges (IEX/PXIL/HPX, including GDAM and GTAM) or to third parties any energy from the Solar Power Capacity that is not scheduled to WBSEDCL, with no cap on the quantum, time blocks or share of generation;",
      "(b) if a cap applies, its level (MW, MU per year or % of generation) and how it is measured;",
      "(c) whether WBSEDCL has any first right or priority over this energy in any time block, and whether any revenue sharing applies; and",
      "(d) whether the same applies to Solar Power Capacity installed above 3 GW.",
    ].join("\n"),
    rationale: "Revenue from solar energy that the RTC profile cannot use offsets the cost of the mandated Solar Power Capacity of twice the Supply Capacity. Certainty on the right to sell it lets Bidders credit that revenue and offer a lower tariff.",
    impact: "Three GW of mandated solar makes far more daytime energy than a 1,500 MW RTC profile can take. If it may be sold, the surplus earns market revenue. If not, it is curtailed and its full cost sits in the tariff.",
    model: "Step 4 → Market sale (and a cap, if WBSEDCL sets one)",
  },
  {
    id: "excess",
    topic: "Payment for supply above 80% annual CUF",
    refs: [
      { clause: "RFQ 1.2.15", page: 15, quote: "Tariff payment under PPA = applicable PPA Tariff x actual power supply in kWh (minimum 80% CUF annually)" },
      { clause: "RFP 1.1.7", page: 48, quote: "The Supplier shall be entitled to receive Tariff for energy scheduled at the Delivery Point(s)." },
    ],
    query: [
      "The illustrative payment in Clause 1.2.15 reads \"Tariff payment under PPA = applicable PPA Tariff x actual power supply in kWh (minimum 80% CUF annually)\". The monthly 70% and Peak-hour 90% minimums lead Bidders to supply above 80% CUF over the year. Please confirm:",
      "(a) that all energy scheduled and supplied at the Delivery Point, including supply above 80% annual CUF, is paid at the full Applicable Tariff;",
      "(b) whether there is a maximum CUF or quantum beyond which WBSEDCL will not buy the energy or will pay a reduced tariff; and",
      "(c) if such excess energy is not bought, whether the Supplier is free to sell it to third parties or on the power exchanges.",
    ].join("\n"),
    rationale: "The tariff a Bidder offers depends on how much of the supplied energy is paid for. Confirming payment for all scheduled energy avoids Bidders pricing in the risk of unpaid supply.",
    impact: "The tariff is spread over all paid energy. If supply above 80% is unpaid or paid less, the same costs fall on fewer paid units and the tariff rises.",
    model: "Step 5 → Year-1 energy (supplied vs 80%)",
  },
  {
    id: "shortfall",
    topic: "Compensation for shortfall against each minimum",
    refs: [
      { clause: "RFQ 1.1.1", page: 10, quote: "maintaining a Supply of minimum 80% CUF for each Accounting Year along with maintaining a Supply of minimum 70% CUF on monthly basis" },
      { clause: "RFP 1.1.6", page: 47, quote: "Provided further that Selected Bidder shall be responsible for any generation variation and/or shortfall and/or excess from any such source and/or project." },
    ],
    query: [
      "Clause 1.1.1 sets three minimum supply levels (80% CUF for each Accounting Year, 70% CUF in each month and 90% CUF in Peak hours) and Clause 1.1.6 makes the Selected Bidder responsible for any shortfall, but the compensation is not stated in the Bidding Documents. Please provide:",
      "(a) the compensation payable for a shortfall against each of the three minimums (rate per kWh or formula, e.g. a multiple of the Applicable Tariff or the cost of replacement power);",
      "(b) whether a shortfall counted in a month or in Peak hours is counted again in the annual shortfall;",
      "(c) any cap on the total compensation in an Accounting Year; and",
      "(d) whether shortfall caused by grid or transmission unavailability, curtailment by the grid operator, or Force Majeure is excluded.",
    ].join("\n"),
    rationale: "The compensation rates decide how much firming capacity is economic. Known rates let Bidders weigh additional storage against a defined compensation and price both correctly.",
    impact: "The model now treats every minimum as a hard floor with zero shortfall allowed. Known penalty rates would let the optimizer accept a small shortfall for a smaller battery, which usually lowers the tariff.",
    model: "Step 5 → Compliance (each floor)",
  },
  {
    id: "ppa",
    topic: "Draft PPA and the 51% Traceable Green Power formula",
    refs: [
      { clause: "RFQ 1.1.4", page: 11, quote: "Formula for calculating 51% Traceable Green Power is set out in the draft PPA." },
      { clause: "RFP 1.1.6", page: 47, quote: "Irrespective of any source of supply, the Tariff under the PPA shall be in accordance with Article 11 of the PPA." },
    ],
    query: [
      "The Bidding Documents refer to the draft PPA for the formula for 51% Traceable Green Power (Clause 1.1.4) and for the Tariff (Article 11, Clause 1.1.6). Please share the draft PPA with Bidders well before the Bid Due Date, and clarify:",
      "(a) the formula for 51% Traceable Green Power, and whether it is measured on energy at the Delivery Point over each Accounting Year;",
      "(b) whether energy discharged from an Energy Storage System charged through RE counts as Traceable Green Power; and",
      "(c) whether non-RE energy covered by RECs counts toward the 51% or only toward the 100% green supply.",
    ].join("\n"),
    rationale: "The green-share formula and the PPA terms (tariff, payment security, change in law, shortfall) decide which sources and how much storage each Bidder needs. Bidders cannot price the supply without them.",
    impact: "The model holds non-RE supply to at most 49% of the energy delivered over the year, and counts RE-charged battery output as green. A different formula changes how much thermal or other non-RE power the plant may use.",
    model: "Step 1.1 (51% green) → Step 5 sizing",
  },
  {
    id: "tariff",
    topic: "Tariff structure and how the levelized tariff is computed",
    refs: [
      { clause: "RFP 7.9.1", page: 64, quote: "The Bid shall comprise the weighted average levelized Tariff as per the applicable extant Guidelines offered by the Bidder for supply of electricity to the Procurer exclusive of all applicable transmission charges and losses at Delivery Point" },
    ],
    query: [
      "Clause 7.9.1 asks for the weighted average levelized Tariff as per the applicable extant Guidelines. Please clarify:",
      "(a) whether Bidders may quote year-wise tariffs, or a tariff with a fixed annual escalation, for the 25 years, or must quote a single tariff for the whole term;",
      "(b) the discount rate, base date and weights (e.g. contracted energy in each year) used to compute the weighted average levelized Tariff;",
      "(c) how year-wise tariffs, if allowed, are revised during the e-Reverse Auction; and",
      "(d) whether the Tariff for the Greenshoe Supply Capacity from 01.04.2029 is the same levelized Tariff or the year-wise tariff applicable from that year.",
    ].join("\n"),
    rationale: "A tariff path that follows the cost profile (debt service in the early years, escalating fuel and O&M costs) can reduce the levelized tariff; the evaluation method must be known so that all Bids are compared on equal terms.",
    impact: "The model solves one flat tariff for 25 years. Biomass fuel and O&M costs escalate, so whether escalation is allowed, and WBSEDCL's discount rate, decide if a rising tariff path gives a lower evaluated tariff.",
    model: "Step 6 → Financials (tariff path)",
  },
  {
    id: "nonre",
    topic: "Non-RE power: Merit Order Despatch, deemed supply and RECs",
    refs: [
      { clause: "RFP 1.1.4", page: 47, quote: "If the said schedule from non-RE sources is not confirmed by the Procurer as a result of application of MOD principle, then 70% of the Applicable Tariff (i.e., fixed charge component hereinafter referred to as the “Fixed Charge”), shall be payable for such power which is not scheduled by the Procurer." },
      { clause: "RFP 1.1.4", page: 47, quote: "for any non-RE power finally supplied to the Procurer, the Supplier shall be required to provide Renewable Energy Certificates (“REC”) equivalent to such non RE- power supplied, to the Procurer." },
    ],
    query: [
      "Clause 1.1.4 of the RFP provides that non-RE power not scheduled by the Procurer under Merit Order Despatch is paid the Fixed Charge (70% of the Applicable Tariff), and that RECs must be provided for non-RE power finally supplied. Please clarify:",
      "(a) whether non-RE energy offered but not scheduled by WBSEDCL under MOD is deemed supplied for the 80% annual, 70% monthly and 90% Peak-hour minimums;",
      "(b) the timeline and procedure for WBSEDCL's confirmation of the non-RE schedule (day-ahead or intra-day);",
      "(c) which RECs are acceptable (category, vintage, purchase on the power exchanges) and by when they must be provided; and",
      "(d) whether the Supplier may sell to third parties non-RE energy that WBSEDCL does not schedule.",
    ].join("\n"),
    rationale: "These points decide whether Bidders can firm the supply with non-RE sources without a shortfall risk they do not control, and the REC cost they must price in.",
    impact: "The model counts non-RE energy toward the minimums only when it is supplied. If MOD-unscheduled energy is deemed supplied, cheaper thermal can firm the profile with less storage.",
    model: "Step 4 → Thermal (REC cost) → Step 5",
  },
  {
    id: "bess",
    topic: "Battery storage: co-location, charging and ISTS charges",
    refs: [
      { clause: "RFQ 1.1.4", page: 11, quote: "If the developer elects to supply power through a Battery Energy storage System (Charges through RE only), the BESS must be co-located as per CERC Sharing Regulations." },
    ],
    query: [
      "Clause 1.1.4 requires a BESS (charged through RE only) to be co-located as per the CERC Sharing Regulations. Please clarify:",
      "(a) whether the BESS must be co-located with the Solar Power Capacity, or may be co-located with any RE source of the Bidder or at any ISTS substation;",
      "(b) whether the BESS may be charged with RE power drawn from the grid (from the Bidder's own RE plants elsewhere, green energy open access or GDAM purchases), and how such charging energy is metered and accounted as RE;",
      "(c) whether the BESS may discharge to the power exchanges in hours when it is not needed for the RTC supply; and",
      "(d) the treatment of ISTS charges and losses for charging the BESS.",
    ].join("\n"),
    rationale: "Where storage may be located and how it may be charged decides its cost and its use; flexibility here lets Bidders install smaller storage and offer a lower tariff.",
    impact: "The model charges the battery only from the bidder's own plants at the same node. Charging from the grid or GDAM, or selling battery output in the market, would make the battery smaller or earn revenue.",
    model: "Step 4 → Battery → Step 5",
  },
  {
    id: "solar",
    topic: "Mandated Solar Power Capacity: AC or DC, what qualifies, by when",
    refs: [
      { clause: "RFQ 1.1.2", page: 11, quote: "The Selected Bidder shall mandatorily ensure installation of Solar Power Capacity equivalent to twice the contracted Supply Capacity (i.e. 3 GW corresponding to the Base Supply Capacity and further additional capacity of 1 GW corresponding to Greenshoe Supply Capacity, if exercised), anywhere in India" },
      { clause: "RFP 1.1.9", page: 48, quote: "Selected Bidder shall be required to submit the binding land documents and relevant CTU connectivity documents for 50% of the LOA capacity within 3 months of LOA issuance and for balance 50% of the LOA capacity within 6 months of LOA issuance." },
      { clause: "RFP 5.3", page: 62, quote: "the Supplier shall demonstrate the land and CTU connectivity availability as per clause 1.1.9 above within 15 days of issuance of LOA." },
    ],
    query: [
      "Clause 1.1.2 of the RFQ and Clauses 1.1.9 and 5.3 of the RFP require Solar Power Capacity of twice the Supply Capacity (3 GW for the Base Supply Capacity). Please clarify:",
      "(a) whether the 3 GW is AC capacity at the Interconnection Point (MWac) or DC module capacity (MWp);",
      "(b) whether solar capacity already commissioned or under construction by the Bidder or its Affiliates, and not tied to any other PPA, LOA or tender, qualifies;",
      "(c) the date by which the Solar Power Capacity must be commissioned (by the Supply Start Date or in phases), and how compliance is verified over the 25 years; and",
      "(d) the time allowed to submit the land and CTU connectivity documents: Clause 5.3 states 15 days of LOA, while Clause 1.1.9 allows 50% within 3 months and the balance within 6 months of LOA.",
    ].join("\n"),
    rationale: "The mandated solar is the largest single cost of the Bid. Its basis (AC or DC), which capacity qualifies and when it must be installed directly decide the capital cost Bidders price in; the two document timelines also need to be reconciled.",
    impact: "The model holds solar at no less than 3,000 MW AC from day one. A DC basis, qualifying existing capacity, or a later installation date would cut the capex charged to the tariff.",
    model: "Step 1.1 (solar minimum) → Step 4 → Solar",
  },
  {
    id: "greenshoe",
    topic: "Greenshoe 500 MW: option or obligation, and its tariff",
    refs: [
      { clause: "RFQ 1.1.1", page: 10, quote: "500 MW Greenshoe Supply Capacity shall be offered to the Selected Bidder at least 30 days prior to 30.09.2027 with Supply Start Date of 01.04.2029" },
      { clause: "RFQ 1.1.1", page: 10, quote: "providing uniform tariff for entire Supply Capacity of 2000 MW" },
    ],
    query: [
      "Clause 1.1.1 provides that the 500 MW Greenshoe Supply Capacity shall be offered at least 30 days prior to 30.09.2027, with Supply Start Date of 01.04.2029, at the same Applicable Tariff, providing a uniform tariff for 2000 MW. Please clarify:",
      "(a) whether the Selected Bidder must accept the greenshoe when it is offered, or may decline it without penalty or forfeiture of any security;",
      "(b) by when the additional 1 GW of Solar Power Capacity must be installed;",
      "(c) whether the greenshoe Tariff is the Tariff discovered in this Bid without any indexation for the later Supply Start Date; and",
      "(d) whether the 25-year term of the greenshoe PPA runs from 01.04.2029 or ends with the base PPA.",
    ].join("\n"),
    rationale: "If accepting the greenshoe at a tariff fixed today is an obligation, Bidders must price the cost risk of a later build into the base tariff; confirming that it is an option avoids that premium.",
    impact: "The model sizes the 1,500 MW base supply. If the greenshoe is an obligation at the same tariff, the bid must also cover 500 MW more supply and 1 GW more solar built later.",
    model: "Step 3 → Greenshoe",
  },
];

/** A query with the bidder's edits (text, rationale, include) applied. */
export function queryWithEdits(q, prebid) {
  const edit = prebid?.edits?.[q.id] || {};
  return { ...q, query: edit.query ?? q.query, rationale: edit.rationale ?? q.rationale, include: !prebid?.off?.[q.id] };
}

/** The queries to send, numbered, in the RFP's order of importance. */
export function queriesToSend(prebid) {
  return PREBID_QUERIES.map((q) => queryWithEdits(q, prebid)).filter((q) => q.include).map((q, i) => ({ ...q, no: i + 1 }));
}

const cite = (q) => [...new Set(q.refs.map((r) => `${r.clause}, p. ${r.page}`))].join("; ");

/** Plain text of the queries, for pasting into the TCIL portal or an e-mail. */
export function queriesText(prebid, tenderNumber = PREBID_TENDER) {
  const lines = [PREBID_TITLE, `Tender: ${tenderNumber}`];
  if (prebid?.bidder) lines.push(`Bidder: ${prebid.bidder}`);
  lines.push("");
  for (const q of queriesToSend(prebid)) {
    lines.push(`${q.no}. ${q.topic} (${cite(q)})`);
    for (const r of q.refs) lines.push(`RFP provision (${r.clause}, p. ${r.page}): "${r.quote}"`);
    lines.push(`Clarification sought: ${q.query}`);
    lines.push(`Rationale: ${q.rationale}`);
    lines.push("");
  }
  return lines.join("\n").trim();
}

/** The rows of the Word file (S. No., clause and page, RFP provision, clarification sought, rationale). */
export function queriesForWord(prebid, tenderNumber = PREBID_TENDER) {
  return {
    title: PREBID_TITLE,
    tenderNumber,
    bidder: prebid?.bidder || "",
    rows: queriesToSend(prebid).map((q) => ({
      no: q.no,
      topic: q.topic,
      clause: cite(q),
      provision: q.refs.map((r) => `“${r.quote}” (${r.clause}, p. ${r.page})`).join("\n"),
      query: q.query,
      rationale: q.rationale,
    })),
  };
}
