// SECI CfD-I: assured peak supply of 1000 MWh (500 MW x 2 h) through the power exchanges under a
// Contract for Difference. Every term below is taken from the tender documents: the RfS, the
// standard CfD Agreement (CfDA) and Amendments 02 and 03 to both. Each cites its document, clause
// and page and quotes it word for word (tests/test_cfd_terms.py checks every quote against its page
// when the PDFs are available). Pages are the page numbers printed on the document ("Page 16 of
// 128"); the RfS PDF has a cover first, so its PDF page is the printed page + 1 (pdfOffset).
// Where an amendment changed a term, the amended term is the one used and the original is kept,
// marked "replaced". Where the documents still differ, the term is marked "conflict" and the
// model follows the CfDA, which prevails (CfDA 1.2.18).

export const DOCUMENTS = [
  { id: "rfs", title: "RfS No. SECI/C&P/IPP/13/0002/26-27 dated 15.07.2026", short: "RfS", pages: 128, pdfOffset: 1, file: "rfp.pdf" },
  { id: "cfda", title: "Standard CfD Agreement (CfDA), SECI-CfD-I", short: "CfDA", pages: 69, file: "Standard_SECI_CfDA_CfD-I-_final_upload.pdf" },
  { id: "amd2", title: "Amendment-02 to the RfS and CfDA (03.08.2026)", short: "Amd-02", pages: 5, file: "Amendment-02-SECI-CfD-I-final_upload.pdf" },
  { id: "amd3", title: "Amendment-03 to the RfS and CfDA (08.10.2026)", short: "Amd-03", pages: 5, file: "Amendment-03-SECI-CfD-I-final_upload.pdf" },
];

export const RFS = {
  number: "SECI/C&P/IPP/13/0002/26-27",
  date: "15.07.2026",
  searchCode: "SECI-2026-TN000007",
  replaces: "the RfS of the same number dated 17.04.2026",
  title: "RfS for Selection of RE Power Developers under Contract for Difference (CfD) Mechanism for assured Peak Supply of 1000 MWh (500 MW x 2 Hrs.) from ISTS-Connected RE Projects in India (SECI-CfD-I)",
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
  // the RfS
  bidMinMw: 50, // 6.1: 50 to 150 MW cumulative, in whole MW
  bidMaxMw: 150,
  rfsCostLakh: 0.5, // Bid Information Sheet (F): INR 50,000 + GST
  bidFeeLakhPerMw: 0.2, // (G): INR 20,000/MW + GST ...
  bidFeeMaxLakh: 20, // ... at most INR 20,00,000 + GST
  emdLakh: { solarMw: 9.68, windMw: 13.68, essMwh: 2.4 }, // 17
  emdValidityMonths: 12,
  pbgLakh: { solarMw: 24.2, windMw: 34.2, essMwh: 6.0 }, // 18.1
  pbgAfterScdMonths: 6, // PBG valid until 6 months after the SCD
  bgClaimDays: 30, // claim period beyond the validity (EMD and PBG)
  cacLakhPerMw: 1, // 19.1: INR 1,00,000/MW + taxes
  loaToEdDays: 30, // 21.4: Effective Date = LoA + 30 days
  docsDueDays: 20, // 21.4: PBG, CAC and documents within 20 days of the LoA
  netWorthLakh: { solarMw: 96.8, windMw: 136.8, essMwh: 24 }, // 37.1
  turnoverLakhPerMw: 42.369, // 37.2 (one of three)
  pbditLakhPerMw: 8.4738,
  lineOfCreditLakhPerMw: 10.59225,
  eraAwardShare: 0.8, // 41.2: SE = 0.8 x ST, at most 500 MW
  eraRange: 0.02, // 42.2: L1 + 2%
  eraDecrement: 0.01, // 41.4.ii
  fmExtensionMonths: 6, // 10.2.e
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
  T("capacityBid", "Scheme and bid", "Capacity you may bid", "One bid for you and your group: 50 to 150 MW cumulative, in whole MW",
    "rfs", "6.1", 16, "submit a single bid offering a minimum quantum of cumulative Contracted Capacity of 50 MW and a maximum quantum of 150 MW, in the prescribed formats. The cumulative Contracted Capacity shall be quoted in integral values only."),
  T("capacityAward", "Scheme and bid", "Most you can be awarded", "150 MW for you and your group",
    "rfs", "6.2", 17, "The cumulative Contracted Capacity to be allocated to a Bidder including its Parent, Affiliate or Ultimate Parent or any Group Company shall be limited to 150 MW."),
  T("bidValidity", "Scheme and bid", "Bid validity", "12 months from the bid deadline",
    "rfs", "29", 47, "The Bidder shall submit the response to RfS which shall remain valid up to the date as on 12 months from the last date of submission of response to RfS (“Bid Validity”)."),
  T("noCfa", "Scheme and bid", "Central financial assistance", "None",
    "rfs", "2.7", 14, "No separate Central Financial Assistance is envisaged for implementation of the Projects selected under this RfS."),
  T("fiscal", "Scheme and bid", "Tax incentives", "Yours to claim; they do not change the tariff and give no claim on SECI",
    "rfs", "2.5", 13, "No claim shall arise on SECI for any liability if Bidders are unable to avail fiscal incentives and this will not have any bearing on the applicable Tariff."),
  T("existingProjects", "Scheme and bid", "Existing RE projects", "May bid untied capacity for a longer CfDA, but Clause 11, which this refers to, reads “Not used” (p. 27): the longer term is not defined. Not modelled; ask SECI",
    "rfs", "2.6", 13, "they will be given the benefit of a longer period of CfDA, commensurate to the duration between the Commercial Operation Date (COD) and Scheduled Commissioning Date (SCD), pursuant to Clause 11 of the RfS.", { status: "conflict" }),

  // ---- the e-Reverse Auction
  T("se", "Auction", "Capacity awarded (SE)", "80% of the qualified bid capacity, at most 500 MW: the full 500 MW is awarded only if at least 625 MW is bid",
    "rfs", "41.2", 58, "In case ST > 500 MW, SE = 0.8 X ST subject to maximum eligible capacity being 500 MW."),
  T("h1Out", "Auction", "Who goes to the e-RA", "Ranked on the first-round tariff; when 80% of the bid capacity exceeds 500 MW the highest bidder (H1) is dropped, if at least 3 bidders and 500 MW remain",
    "rfs", "41.2", 58, "The lowest ranked bidder, i.e. the bidder quoting the highest tariff (the “H1 bidder”) shall be eliminated at this stage"),
  T("decrement", "Auction", "Bidding in the e-RA", "You start from your first-round tariff; each new quote at least ₹0.01/kWh lower; your capacity cannot change",
    "rfs", "41.4.ii", 59, "The minimum decrement value for tariff shall be INR 0.01 per kWh."),
  T("eraClock", "Auction", "Auction clock", "30 minutes, extended by 8 minutes whenever a quote moves a bidder into another zone (green: full award, orange: part, red: none)",
    "rfs", "41.4.vi", 59, "The initial auction period will be of 30 (thirty) minutes with a provision of auto extension by 8 (eight) minutes from the scheduled/extended closing time."),
  T("range", "Auction", "Who wins", "Every bidder within L1 + 2% of the lowest tariff, in tariff order (ties by time of the last quote), up to SE",
    "rfs", "42.2", 60, "The bidders who fall within the range of (and including) the lowest tariff (L1 tariff) + 2% of the L1 tariff-hereinafter referred to as “the range”- will be declared as Successful Bidders under the RfS"),
  T("partial", "Auction", "Part award", "The last winner may be offered less (never under 50 MW); it must accept if the offer is at least half its bid",
    "rfs", "42.4", 61, "it shall be mandatory for the last Bidder to accept the partial capacity offered against its quoted capacity"),

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
  T("lowPrices", "Daily supply", "If prices stay below the strike price", "SECI/MNRE may allow sale in other suitable markets",
    "amd3", "RfS 9.2.c (amended)", 2, "during the period in which the MCPs in the above markets are expected to remain lower than the Strike Price for a sustained period, RPD may be allowed to sell the electricity in suitable markets based on the approval of SECI/MNRE."),
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
  T("dcr", "Plant", "Solar modules", "Domestically made cells and modules (ALMM List-I and List-II)",
    "rfs", "Annexure-B 1.d", 110, "It is mandatory to use both domestically manufactured solar PV Cells and domestically manufactured solar PV modules."),
  T("substation", "Plant", "Substation", "Any ISTS substation in India with injection rights in non-solar hours; getting the connectivity is your risk",
    "rfs", "8.2", 18, "The Bidders are free to choose the ISTS substations for Interconnection of the Project to the Grid, with injection scheduling rights during non-solar hours, on a pan-India basis."),
  T("lineCost", "Plant", "Line to the substation", "Yours: building it, its charges, losses and upkeep up to the Interconnection Point",
    "rfs", "8.4", 18, "The entire cost of transmission including cost of construction of line, wheeling charges, SLDC/Scheduling charges, SOC, MOC, maintenance, losses etc. and any other charges from the Project up to and including at the Interconnection Point will be borne by the RPD."),
  T("essThirdParty", "Plant", "Battery owned by a third party", "Replaced: Amendment-02 (which numbers this clause 4.3) requires the battery to be owned by you",
    "rfs", "4.4 (original)", 16, "such ESS may be owned by the RPD or may be tied-up separately with a third party by the RPD", { status: "replaced" }),
  T("essRemote", "Plant", "Battery away from the RE", "The RfS allows it (you then pay the battery's own connectivity and charging charges); the CfDA says co-located and prevails. The model takes co-located",
    "rfs", "7.1", 17, "For a single Project, the RE Generating components, along with ESS (if any) may either be co-located or located at different locations.", { status: "conflict" }),

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
  T("cfdaSign", "Dates", "CfDA signed", "Within 30 days of the Letter of Award (LoA)",
    "rfs", "21.1", 36, "The CfDA will be signed within 30 days of issuance of Letter of Award (LoA) to the Successful Bidder."),
  T("effectiveDate", "Dates", "Effective Date", "The 30th day after the LoA; every date below runs from it",
    "rfs", "21.4", 37, "Effective Date of the CfDA shall be the date as on 30th day from the date of issuance of LoA to the Successful Bidder."),
  T("essScd", "Dates", "Battery commissioned (SCD)", "15 months from the Effective Date of the CfDA",
    "amd2", "RfS 10.2.a (amended)", 2, "The Scheduled Commissioning Date (SCD) for commissioning of the full capacity of the ESS component of the Project shall be the date as on 15 months from the Effective Date of the CfDA"),
  T("reCod", "Dates", "RE generation commissioned", "36 months from the Effective Date of the CfDA",
    "amd2", "RfS 10.2.a (amended)", 2, "The corresponding RE Generating component(s) shall be commissioned by the RPD by the date as on 36 months from the Effective Date of the CfDA"),
  T("term", "Dates", "Term", "15 years from the SCD (the draft CfDA's 12 years was extended)",
    "amd3", "CfDA 1.1 Expiry Date (amended)", 4, "shall mean the date occurring as on fifteen (15) years from the Scheduled Commissioning Date (SCD)"),
  T("rfsTerm12", "Dates", "Term in the RfS as issued", "Replaced: 12 years became 15 (Amendment-03 to RfS 2.3, 21.2 and 21.7)",
    "rfs", "21.2 (original)", 37, "The CfDAs shall be valid for a period of 12 years from the SCD.", { status: "replaced" }),
  T("afterExpiry", "Dates", "After the term", "You may keep operating; SECI does not settle beyond the Expiry Date",
    "cfda", "2.2.2", 16, "The RPD is free to operate its Project beyond the Expiry Date if other conditions such as land lease / Right to Use of Land (as applicable), permits, approvals and clearances etc. allow."),
  T("finClose", "Dates", "Financial closure", "6 months before the SCD",
    "cfda", "3.4", 18, "by the date as on 6 months prior to the SCD"),
  T("early", "Dates", "Early commissioning", "Allowed, settled under the CfD from then",
    "cfda", "5.6", 34, "The RPD shall be permitted for full as well as part commissioning of the Project even prior to the SCD"),
  T("noExtension", "Dates", "Extensions", "Only for Force Majeure",
    "cfda", "4.5.2", 28, "the Project shall not be eligible for any extension in SCD on account of any reason other than Force Majeure"),
  T("fmExtension", "Dates", "Force Majeure extension", "At most 6 months",
    "rfs", "10.2.e", 27, "In case of Force Majeure, extension in the SCD shall be limited to 6 months in line with the CfDA."),
  T("delay", "Dates", "Late by up to 3 months", "The PBG is encashed pro rata to the capacity not yet supplying",
    "amd2", "CfDA 4.6.1 (amended)", 5, "Delay beyond the SCD up to (& including) the date as on 3 months after the SCD or the extended SCD, if applicable: The total PBG/Surety Bond amount shall be encashed on pro-rata basis"),
  T("delayBeyond", "Dates", "Late by more than 3 months", "The Contracted Capacity is cut to what has been commissioned",
    "amd2", "CfDA 4.6.2 (amended)", 5, "the Contracted Capacity shall stand reduced / amended to lower of the (i) ESS capacity that has been commissioned, or (ii) the capacity which has commenced supply of power"),

  // ---- bid security and SECI's charges
  T("rfsCost", "Bid security and charges", "Cost of the RfS", "₹50,000 + GST with the bid, not refunded",
    "rfs", "Bid Information Sheet (F)", 2, "Amount: INR 50,000/- (Indian Rupees Fifty Thousand Only) + applicable GST"),
  T("bidFee", "Bid security and charges", "Bid processing fee", "₹20,000 per MW bid + GST, at most ₹20 lakh + GST, not refunded",
    "rfs", "Bid Information Sheet (G)", 2, "Amount: INR 20,000/MW + applicable GST for the quoted capacity subject to a maximum amount of INR 20,00,000 + applicable GST for the response to RfS"),
  T("emd", "Bid security and charges", "Earnest Money Deposit (EMD)", "₹9.68 lakh/MW solar + ₹13.68 lakh/MW wind or other RE + ₹2.40 lakh/MWh battery, as a bank guarantee or surety bond with the bid",
    "rfs", "17", 31, "Earnest Money Deposit = [INR 9,68,000 x Rated cumulative Installed Capacity of Solar PV component (MW) + INR 13,68,000 x Rated cumulative Installed Capacity of Wind component and other RE generating sources (MW) + INR 2,40,000 x Rated cumulative Installed Capacity of the ESS component (MWh)]."),
  T("emdValidity", "Bid security and charges", "EMD validity", "12 months from the bid deadline (claimable 30 days more); returned once the PBG is in",
    "rfs", "17", 31, "valid for 12 months from the last date of bid submission"),
  T("pbg", "Bid security and charges", "Performance Bank Guarantee (PBG)", "₹24.20 lakh/MW solar + ₹34.20 lakh/MW wind or other RE + ₹6.00 lakh/MWh battery, on the installed (AC) capacities",
    "rfs", "18.1", 33, "Performance Bank Guarantee = [INR 24,20,000 x Rated Installed Capacity of Solar component (MW) + INR 34,20,000 x Rated cumulative Installed Capacity of Wind component and other RE generating sources (MW) + INR 6,00,000 x Rated cumulative Installed Capacity of the ESS component (MWh)]."),
  T("pbgValidity", "Bid security and charges", "PBG validity", "Until 6 months after the SCD (claimable 30 days more)",
    "rfs", "18.1", 33, "with a validity period up to (& including) the date as on 6 months after the SCD of the Project."),
  T("pbgRelease", "Bid security and charges", "PBG returned", "Within 45 days of commissioning the full Project Capacity",
    "rfs", "18.10", 34, "The PBG of RPDs shall be returned to them, within 45 days of successful commissioning of the full Project Capacity/capacity finally accepted by SECI"),
  T("cac", "Bid security and charges", "Contract Administration Charges", "₹1 lakh per contracted MW + GST, to SECI within 20 days of the LoA",
    "rfs", "19.1", 35, "The Successful Bidders shall have to pay Contract Administration Charges @ INR 1,00,000/MW (Indian Rupees One Lakh/MW) + applicable taxes, corresponding to the Contracted Capacity"),
  T("docsDue", "Bid security and charges", "Due after the LoA", "The PBG, the Contract Administration Charges and the documents within 20 days of the LoA",
    "rfs", "21.4", 37, "Successful Bidders will be required to submit the necessary documents, including Contract Administration Charges as per Clause 19 and PBG as per Clause 18 prior to signing of CfDA, within 20 days from issuance of LoA."),
  T("lateDocs", "Bid security and charges", "If they are late", "₹1,000 per MW per day + GST until they are in",
    "rfs", "21.4", 37, "delay charges @Rs. 1000/MW/day + applicable GST corresponding to the unsigned CfDA capacity shall be levied on the Bidder on per-day basis"),
  T("fcLate", "Bid security and charges", "Late financial closure", "₹100 per MW per day + GST, paid in advance; refunded if the SCD is met",
    "rfs", "22.3", 38, "on advance payment of extension charges of INR 100/- per day per MW (of Contracted Capacity) + applicable GST."),

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

  // ---- eligibility
  T("netWorth", "Eligibility", "Net worth", "₹96.8 lakh/MW solar + ₹1.368 crore/MW wind or other RE + ₹24 lakh/MWh battery, at the end of the last financial year",
    "rfs", "37.1.i", 53, "Minimum Net-Worth requirement = [(Rs. 96,80,000 x Rated Installed Capacity of Solar PV component (MW)) + (Rs. 1,36,80,000 x Rated Installed Capacity of Wind Power component and other RE sources (MW)) + (Rs. 24,00,000 x Rated Installed Capacity of ESS component (MWh))]"),
  T("turnover", "Eligibility", "Liquidity: turnover", "₹42.37 lakh per contracted MW in the last financial year, other income excluded (or one of the two below)",
    "rfs", "37.2.i", 53, "A minimum annual turnover of INR 42,36,900/ MW (Indian Rupees Forty-Two Lakhs Thirty-Six Thousand and Nine Hundred/MW) of the quoted Contracted Capacity"),
  T("pbdit", "Eligibility", "Liquidity: or PBDIT", "₹8.47 lakh per contracted MW",
    "rfs", "37.2.ii", 53, "Profit Before Depreciation Interest and Taxes (PBDIT) excluding other and exceptional income for a minimum amount of INR 8,47,380/MW"),
  T("lineOfCredit", "Eligibility", "Liquidity: or a line of credit", "A bank's in-principle line of credit of ₹10.59 lakh per contracted MW",
    "rfs", "37.2.iii", 54, "committing a Line of Credit for a minimum amount of INR 10,59,225/MW"),
  T("lockIn", "Eligibility", "Your holding in the project company", "At least 51% until 1 year after the SCD, unless SECI agrees",
    "rfs", "23.5", 39, "shall not fall below 51% at any time prior to 01 (one) year after the SCD, except with the prior approval of SECI."),
];

export const TERM_GROUPS = [...new Set(TERMS.map((t) => t.group))];
export const termById = Object.fromEntries(TERMS.map((t) => [t.id, t]));
export const docById = Object.fromEntries(DOCUMENTS.map((d) => [d.id, d]));

/** "CfDA 4.4.3.i, p. 26" */
export const cite = (id) => {
  const t = termById[id];
  return t ? `${docById[t.doc].short} ${t.clause.replace(/ \((amended|original.*)\)$/, "")}, p. ${t.page}` : "";
};
