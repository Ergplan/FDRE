// SECI CfD-I: assured peak supply of 1000 MWh (500 MW x 2 h) through the power exchanges under a
// Contract for Difference. Every term below is taken from the documents the bidder holds: the
// standard CfD Agreement (CfDA) and Amendments 02 and 03 to the RfS and CfDA. Each cites its
// document, clause and page and quotes it word for word (tests/test_cfd_terms.py checks every quote
// against its page when the PDFs are available). Where an amendment changed a term, the amended
// term is the one used and the original is kept, marked "replaced".

export const DOCUMENTS = [
  { id: "cfda", title: "Standard CfD Agreement (CfDA), SECI-CfD-I", short: "CfDA", pages: 69, file: "Standard_SECI_CfDA_CfD-I-_final_upload.pdf" },
  { id: "amd2", title: "Amendment-02 to the RfS and CfDA (03.08.2026)", short: "Amd-02", pages: 5, file: "Amendment-02-SECI-CfD-I-final_upload.pdf" },
  { id: "amd3", title: "Amendment-03 to the RfS and CfDA (08.10.2026)", short: "Amd-03", pages: 5, file: "Amendment-03-SECI-CfD-I-final_upload.pdf" },
];

export const RFS = {
  number: "SECI/C&P/IPP/13/0002/26-27",
  date: "15.07.2026",
  title: "RfS for Selection of RE Power Developers under Contract for Difference (CfD) Mechanism for assured Peak Supply of 1000 MWh (500 MW x 2 Hrs.) from ISTS-Connected RE Projects in India (SECI-CfD-I)",
  // terms the CfDA leaves to the RfS (not among the documents loaded)
  notLoaded: ["EMD and Performance Bank Guarantee amounts (RfS clause 18.1)", "Capacity a bidder may apply for, and the minimum per project",
    "Eligibility (technical and financial)", "Bid submission dates and the e-Reverse Auction rules", "Contract administration charges",
    "Technical requirements of the solar PV and ESS components (RfS Annexures B and E)"],
};

// The numbers the model applies, each tied to the term that states it.
export const TENDER = {
  totalMw: 500, // Recital D
  mwhPerMwDay: 2, // 2000 kWh per MW per day
  peakStart: 18, // Peak Hours: 18:00 to 24:00
  peakEnd: 24,
  peakHours: 2,
  essHoursMin: 2, // ESS X MW / 2X MWh
  essScdMonths: 15, // SCD of the ESS: 15 months from the Effective Date
  reCodMonths: 36, // RE generating components: 36 months from the Effective Date
  termYears: 15, // Expiry: 15 years from the SCD
  finCloseMonthsBeforeScd: 6,
  delayMonthsMax: 3,
  marketShare: 0.25, // green market / bilateral, whole term
  extraMarketShare: 0.75, // first 36 months, for charging the ESS only
  extraMarketMonths: 36,
  groupShare: 0.5, // after 36 months, group-company RE, for charging the ESS only
  weeklyTolerance: 0.1,
  penaltyMultiple: 1.5,
  recPoolShare: 0.5,
  lcMinPrice: 10, // C in the LC formula: at least Rs 10/kWh
  lcDays: 30,
  poolCr: 76,
  partMinMw: 50,
};

const T = (id, group, label, display, doc, clause, page, quote, extra = {}) => ({ id, group, label, display, doc, clause, page, quote, ...extra });

export const TERMS = [
  // ---- the scheme and the bid
  T("scheme", "Scheme and bid", "What is procured", "Assured peak supply of 1000 MWh a day (500 MW × 2 hours) from ISTS-connected RE projects, sold through the power exchanges, settled by SECI under a CfD",
    "cfda", "Recital D", 3, "SECI had initiated a Tariff Based Competitive Bid Process for assured Peak Supply of 1000 MWh (500 MW x 2 Hrs.) from ISTS-Connected RE Projects under CfD mechanism"),
  T("bid", "Scheme and bid", "What you bid", "One strike price in ₹/kWh for all projects applied for; digits after two decimals are ignored",
    "amd3", "RfS 40.3 (amended)", 4, "quoting a single “First Round Tariff” in Indian Rupee per kWh for all the Projects applied for. If it is quoted with more than two digits after decimal, digits after first two decimal places shall be ignored."),
  T("ceiling", "Scheme and bid", "Ceiling tariff", "None: the ₹5.80/kWh ceiling of the RfS was removed by Amendment-03",
    "amd3", "RfS 40.3 (original, removed)", 4, "The tariff has to be less than or equal to INR 5.80/kWh", { status: "replaced" }),
  T("spDefinition", "Scheme and bid", "Strike price", "The tariff discovered in the e-Reverse Auction; every CfD settlement is against it",
    "cfda", "1.1 Tariff / Strike Price", 13, "shall mean the price/ tariff (INR/kWh) discovered after the e-RA, against which the CfD settlement will take place during the Term of CfDA"),
  T("precedence", "Scheme and bid", "If documents differ", "The CfDA prevails, then the RfS",
    "cfda", "1.2.18", 15, "in case of any mismatch/contradiction between provisions of different documents, following shall be the order of precedence:"),
  T("spFixed", "Scheme and bid", "Strike price over the term", "Fixed for the whole term (no escalation)",
    "cfda", "9.1", 40, "the Strike Price shall be fixed for the entire term of this Agreement"),

  // ---- the daily supply obligation
  T("peakWindow", "Daily supply", "Peak Hours", "18:00 to 24:00, within the non-solar hours of the GNA Regulations",
    "cfda", "1.1 Peak Hours", 10, "which shall be between 18:00 Hrs. and 24:00 Hrs. of a Day, provided that such selected hours fall within the non-solar hours as defined under the GNA Regulations"),
  T("twoHours", "Daily supply", "Hours you choose", "Any 2 hours of the Peak Hours, chosen day-ahead",
    "cfda", "1.1 Peak Hours", 10, "The RPD shall, on a day-ahead basis, choose any 2 hours for supply of energy from the Project through Power Exchanges from “Peak Hours”."),
  T("mandate", "Daily supply", "Energy to sell every day", "2 MWh per MW of Contracted Capacity (2,000 kWh/MW) in the Peak Hours",
    "cfda", "1.1 Peak Hours", 10, "The RPD is mandated to sell 2000 kWh of energy per MW Contracted Capacity of the Project during Peak Hours, on a daily basis."),
  T("blocks", "Daily supply", "Time blocks", "15-minute blocks, consecutive or not, adding up to 120 minutes a day",
    "cfda", "4.4.2.iii", 25, "Such Time-Blocks may or may not be consecutive, with the only requirement being that they are chosen from the Peak Hours as defined in this Agreement and the summation of such individual time intervals adds up to 2 hours, i.e. 120 minutes, on a daily basis."),
  T("cleared", "Daily supply", "Only cleared volume counts", "Your bid must clear on the exchange to be settled",
    "cfda", "4.4.2.ii", 25, "The RPD shall ensure that its quoted volume (energy) gets cleared in the Market selected by the RPD, on a daily basis, to be eligible for any CfD settlement under this RfS."),
  T("markets", "Daily supply", "Markets", "Your choice of exchange and market: GDAM, DAM, HP-DAM, RTM, TAM, G-TAM",
    "amd3", "CfDA 4.4.2.ii (amended)", 4, "the appropriate Market (GDAM/ DAM/ HPDAM/ RTM/ TAM/ G-TAM or any other similar Market as recognized by the CERC for sale of power)"),
  T("seciHours", "Daily supply", "SECI may set the hours", "SECI may designate the Peak Hours and time blocks, and may schedule or bid on your behalf",
    "amd3", "RfS 9.2.c (amended)", 2, "SECI may, as deemed necessary, undertake or facilitate the scheduling and/or bidding of such power on behalf of the RPD in the Power Exchanges"),
  T("excess", "Daily supply", "Energy above 2 MWh/MW", "Not settled under the CfD",
    "cfda", "4.4.1.ii", 23, "in case of excess supply by the RPD over the daily limit as stipulated in these provisions, RPD shall not be entitled for CfD settlement against such excess energy supplied"),
  T("essOtherUse", "Daily supply", "Other use of the battery", "Allowed (including market sale) after the day's peak supply is met, within the connectivity",
    "cfda", "4.4.1.v", 24, "the RPD is allowed to use the ESS component for any other application (including market operations such as third-party sale or sale in power exchange) within the availability of connectivity, without requiring No Objection Certificate (NOC) from SECI, after fulfilling the Peak supply requirements for that Day"),
  T("thirdParty", "Daily supply", "Selling elsewhere before the obligation is met", "A breach, with a penalty of 1.5 × (Reference Rate − strike price) on that volume",
    "cfda", "4.4.1.v", 25, "Any instance of third-party sale of power from the Project by the RPD, while the supply commitments under the CfDA remains unfulfilled for that day, shall constitute a breach of RPD’s obligations under the CfDA"),

  // ---- settlement
  T("settlement", "CfD settlement", "What you receive", "The strike price for every kWh supplied: SECI's CfD Pool pays (SP − MCP) when the market clears below it, and you pay (MCP − SP) when it clears above",
    "amd3", "CfDA 9.2.iv (amended)", 5, "such that the RPD shall be entitled to receive the Strike Price (“SP”) for the electricity supplied from the Project"),
  T("noRisk", "CfD settlement", "Market price risk", "None on the settled energy: you keep no gain and bear no loss",
    "amd3", "CfDA 9.2.iv (amended)", 5, "Accordingly, the RPD shall neither retain any profit/gain nor bear any loss on account of variation between the MCP and the SP."),
  T("slabs", "CfD settlement", "Gain/loss sharing by price slab", "Replaced: the draft CfDA's 70:30, 50:50 and 30:70 slab sharing no longer applies",
    "cfda", "9.2.iv (original)", 40, "Profit/ Gains and losses shall be shared between the RPD and the CfD Stabilization Fund (“Pool”), in a dynamic grading as follows:", { status: "replaced" }),
  T("blockSettle", "CfD settlement", "How it is settled", "Every 15-minute block, settled monthly",
    "cfda", "9.2.vii", 42, "The calculations of gains and losses shall be carried out on a Time-Block basis, and settlement of the same shall be done on monthly basis."),
  T("pool", "CfD settlement", "CfD Pool", "₹76 crore, a revolving buffer for pay-ins and pay-outs",
    "cfda", "9.2.v", 41, "a stabilization fund of INR 76 Cr. has been created as the CfD Pool"),
  T("poolSecurity", "CfD settlement", "Payment security to you", "The CfD Pool itself",
    "cfda", "10.4(b)", 47, "the Stabilization Fund set up by the Government and maintained by SECI shall act as the Payment Security Mechanism for any amount payable by SECI to the RPD under this CfDA"),
  T("seciLimited", "CfD settlement", "SECI's obligation", "Limited to the CfD settlement",
    "cfda", "14.5.1", 60, "the performance of the obligations of the SECI under this Agreement shall be limited to settlement under CfD mechanism"),
  T("rec", "CfD settlement", "RECs", "Energy sold in brown markets (DAM, RTM, TAM) earns RECs; you sell them within 3 months and pay 50% of the proceeds into the Pool",
    "cfda", "9.2.vi", 41, "These RECs issued to the RPD shall be sold by the RPD in the Market, and 50% of the revenues generated from the sale of these RECs shall be deposited into the CfD pool."),
  T("pxCharges", "CfD settlement", "Exchange fees and charges", "Yours",
    "cfda", "4.2.7", 23, "any associated charges, losses, and any fees (including transaction fees), as applicable, for selling the energy on/through Power Exchange shall be entirely borne by RPD"),
  T("ists", "CfD settlement", "Transmission to the Delivery Point", "ISTS charges and losses up to the Delivery Point are yours",
    "cfda", "4.2.6", 23, "ISTS charges and losses till the Delivery Point(s), if applicable, shall be borne by the RPD."),

  // ---- the plant
  T("ess", "Plant", "Battery", "Mandatory: X MW / 2X MWh for X MW contracted",
    "amd2", "RfS 4.3 (amended)", 1, "For a ‘X’ MW Contracted Capacity, RPD shall mandatorily install ESS of ‘X’ MW/ ‘2X’ MWh capacity as part of the Project."),
  T("essOwned", "Plant", "Battery ownership", "Owned by you (no third-party tie-up)",
    "amd2", "RfS 4.3 (amended)", 1, "Such ESS shall be owned by the RPD for supply of power through Power Exchanges."),
  T("reSize", "Plant", "RE generation", "Solar, wind or other RE in any mix; together they may exceed the Contracted Capacity",
    "cfda", "1.1 RE Power Project", 11, "It is clarified that arithmetic summation of the rated capacities of Wind, Solar PV and other renewable power generating components of the Project can be more than the Contracted Capacity."),
  T("connectivity", "Plant", "Grid connection", "No connectivity above the Contracted Capacity",
    "cfda", "1.1 Installed Capacity", 8, "additional connectivity for RE generating component or ESS component (if applicable), above the Contracted Capacity, will not be provided"),
  T("colocated", "Plant", "Location", "Generation and battery co-located",
    "cfda", "1.1 RE Power Project", 11, "It may be noted that the sources of generation and ESS shall be co-located."),
  T("delivery", "Plant", "Delivery Point", "An ISTS substation at 220 kV or above",
    "cfda", "1.1 Delivery Point", 6, "shall mean a single point at the voltage level of 220 kV or above of the ISTS Sub-station"),
  T("nonRe", "Plant", "Charging from non-RE", "Does not count as RE",
    "cfda", "1.1 RE Power Project", 11, "It is clarified that ESS charged using a source other than RE power would not qualify as RE power."),
  T("partMin", "Plant", "Part commissioning", "At least 50 MW a part",
    "cfda", "5.7", 34, "the minimum capacity for acceptance of first and subsequent part(s) shall be 50 MW"),

  // ---- where the energy comes from
  T("allRe", "Energy sourcing", "All supply RE", "100% of the energy sold each year must be RE",
    "amd2", "CfDA 4.4.1.iv (amended)", 4, "The RPD shall supply power such that 100% of the annual energy scheduled on the Power Exchange(s) corresponds to RE power."),
  T("market25", "Energy sourcing", "Green market / bilateral", "Up to 25% of each year's energy, for the whole term",
    "amd2", "CfDA 4.4.1.iv (amended)", 4, "For the complete Term of the CfDA, the RPD can source up to 25% RE power (in energy terms), on annual basis, from the green market sources/bilateral agreements"),
  T("discharged", "Energy sourcing", "How the shares are measured", "On the energy discharged from the battery, not the charging energy",
    "amd2", "CfDA 4.4.1.iv (amended)", 4, "only the energy discharged from the ESS shall be considered for calculating the 25% requirement, and not the corresponding charging energy required"),
  T("market75", "Energy sourcing", "First 36 months", "A further 75% from the green market / bilateral, only for charging the battery",
    "amd2", "CfDA 4.4.1.iv (amended)", 4, "for the period commencing from the Effective Date of CfDA and up to the date as on 36 months therefrom, the RPD shall additionally be permitted to source up to 75% RE power (in energy terms), on annual basis, from the green market sources/ bilateral agreements, provided that such energy is utilized exclusively for charging the ESS"),
  T("group50", "Energy sourcing", "After 36 months", "A further 50% from RE projects of your group companies, only for charging the battery",
    "amd2", "CfDA 4.4.1.iv (amended)", 4, "the RPD may source up to an additional 50% RE power (in energy terms), on annual basis, from RE Project(s) owned by the Group Companies of the RPD, provided that such energy is utilized exclusively for charging the ESS"),
  T("overCap", "Energy sourcing", "Energy above these limits", "Not settled",
    "amd2", "CfDA 4.4.1.iv (amended)", 4, "in case of excess supply by the RPD over the 25% limit as stipulated in this provision, the RPD shall not be entitled for CfD settlement against such excess energy supplied"),

  // ---- dates
  T("essScd", "Dates", "Battery commissioned (SCD)", "15 months from the Effective Date of the CfDA",
    "amd2", "RfS 10.2.a (amended)", 2, "The Scheduled Commissioning Date (SCD) for commissioning of the full capacity of the ESS component of the Project shall be the date as on 15 months from the Effective Date of the CfDA"),
  T("reCod", "Dates", "RE generation commissioned", "36 months from the Effective Date of the CfDA",
    "amd2", "RfS 10.2.a (amended)", 2, "The corresponding RE Generating component(s) shall be commissioned by the RPD by the date as on 36 months from the Effective Date of the CfDA"),
  T("term", "Dates", "Term", "15 years from the SCD (the draft CfDA's 12 years was extended)",
    "amd3", "CfDA 1.1 Expiry Date (amended)", 4, "shall mean the date occurring as on fifteen (15) years from the Scheduled Commissioning Date (SCD)"),
  T("afterExpiry", "Dates", "After the term", "You may keep operating; SECI does not settle beyond the Expiry Date",
    "cfda", "2.2.2", 16, "The RPD is free to operate its Project beyond the Expiry Date if other conditions such as land lease / Right to Use of Land (as applicable), permits, approvals and clearances etc. allow."),
  T("finClose", "Dates", "Financial closure", "6 months before the SCD",
    "cfda", "3.4", 18, "by the date as on 6 months prior to the SCD"),
  T("early", "Dates", "Early commissioning", "Allowed, settled under the CfD from then",
    "cfda", "5.6", 34, "The RPD shall be permitted for full as well as part commissioning of the Project even prior to the SCD"),
  T("noExtension", "Dates", "Extensions", "Only for Force Majeure",
    "cfda", "4.5.2", 28, "the Project shall not be eligible for any extension in SCD on account of any reason other than Force Majeure"),
  T("delay", "Dates", "Late by up to 3 months", "The PBG is encashed pro rata to the capacity not yet supplying",
    "amd2", "CfDA 4.6.1 (amended)", 5, "Delay beyond the SCD up to (& including) the date as on 3 months after the SCD or the extended SCD, if applicable: The total PBG/Surety Bond amount shall be encashed on pro-rata basis"),
  T("delayBeyond", "Dates", "Late by more than 3 months", "The Contracted Capacity is cut to what has been commissioned",
    "amd2", "CfDA 4.6.2 (amended)", 5, "the Contracted Capacity shall stand reduced / amended to lower of the (i) ESS capacity that has been commissioned, or (ii) the capacity which has commenced supply of power"),

  // ---- penalties and security
  T("shortfall", "Penalties and security", "Weekly shortfall", "1.5 × (the week's highest evening MCP across all exchanges and markets − strike price) on each MWh short",
    "cfda", "4.4.3.i", 26, "the RPD shall pay a penalty calculated @ 1.5 times of the difference between (i) the highest of the MCP in HPDAM/DAM/GDAM/RTM or any other similar extant Market-based Collective Transaction Mechanism of all the Power Exchanges during the non-solar hours"),
  T("tolerance", "Penalties and security", "Tolerance", "Only the shortfall beyond 10% of the week's 14 MWh/MW",
    "cfda", "4.4.3.ii", 26, "penalty will be levied on the shortfall beyond 10% in a Contract Week"),
  T("noPenaltyBelow", "Penalties and security", "When prices are low", "No penalty when that highest MCP is below the strike price",
    "cfda", "4.4.3.i", 26, "In case the rate as determined at (i) above comes out to be less than the Strike Price, no penalty shall be levied on the RPD."),
  T("uncleared", "Penalties and security", "Uncleared bids", "Count as shortfall",
    "cfda", "4.4.3.iii", 27, "volume shall also be considered as part of shortfall in energy supply by the RPD."),
  T("curtailment", "Penalties and security", "Grid curtailment", "Reduces the week's required energy",
    "cfda", "4.4.3.iii", 27, "the quantum of such curtailed energy shall be reduced from the energy required to be supplied by the RPD for that Contract Week"),
  T("default", "Penalties and security", "Event of default", "Missing the monthly peak supply every month for 2 consecutive Contract Years",
    "cfda", "13.1.1(i)", 53, "failure to maintain minimum monthly assured Peak supply in every Contract Month during a period of 2 (two) consecutive Contract Years"),
  T("lc", "Penalties and security", "Letter of Credit from you to SECI", "2000 × Contracted MW × (C − SP) × 30, C at least ₹10/kWh, renewed yearly",
    "cfda", "10.4.2", 46, "LC = 2000 x Contracted Capacity (MW) x [C – SP] x 30"),
  T("changeInLaw", "Penalties and security", "Change in law", "No relief either way",
    "cfda", "12.1", 52, "No relief shall be admissible for any gain/ loss incurred by either Party on account of Change in Law."),
];

export const TERM_GROUPS = [...new Set(TERMS.map((t) => t.group))];
export const termById = Object.fromEntries(TERMS.map((t) => [t.id, t]));
export const docById = Object.fromEntries(DOCUMENTS.map((d) => [d.id, d]));

/** "CfDA 4.4.3.i, p. 26" */
export const cite = (id) => {
  const t = termById[id];
  return t ? `${docById[t.doc].short} ${t.clause.replace(/ \((amended|original.*)\)$/, "")}, p. ${t.page}` : "";
};
