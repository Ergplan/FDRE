# CfD bid (SECI CfD-I)

A dashboard tab for bidding SECI's CfD-I tender: assured peak supply of 1000 MWh a day (500 MW ×
2 hours) from ISTS-connected RE projects, sold on the power exchanges and settled by SECI's CfD Pool
against the bidder's strike price. It is a separate tab (`cfd`, "CfD Bid") and runs in the browser;
an administrator grants it like the other tabs.

| Step | What it shows | Where |
| --- | --- | --- |
| 1 How it works | The tender as a picture: a flow diagram of energy and money (RE plant, group RE, green market → battery → exchange → CfD Pool → the bidder), the timeline from the Effective Date to the end of the term, a day of supply on IEX evening prices, the bidder's obligations in order from the bid and the e-RA to the end of the term, and the money in one line | `VisualModel.jsx` |
| 2 Tender terms | 95 terms in 10 groups, each with its document, clause, page and quote; terms an amendment replaced are kept and marked; where the RfS and the CfDA still differ the term is marked "documents differ" | `terms.js`, `TermsStep.jsx` |
| 3 Plant and sourcing | Contracted MW (50–150, whole MW), Effective Date (the LoA, PBG and tender dates follow), battery, own solar and wind, charging sources and markets; **Fill up for me please**; **Optimise own RE** | `InputsStep.jsx` |
| 4 Costs and finance | Capex, O&M, augmentation, exchange fees, LC, bank-guarantee cost, GST on SECI's charges, financing; what the RfS asks of this bid (EMD, PBG, SECI's charges, net worth, liquidity) | `InputsStep.jsx` |
| 5 Operations | Every day of the term: supply, where the energy came from against the limits, surplus sold, curtailment, weekly penalties; any day's hourly operation | `model.js simulate`, `OperationsStep.jsx` |
| 6 Bid and financials | The strike price for the target equity IRR (rounded up to two decimals), IRRs, DSCR, levelised cost, the CfD Pool at that price, revenue and costs by year, the statements; **Download financial model (Excel)** | `model.js financials`, `FinanceStep.jsx`, `POST /api/cfd/model` |

## The tender, from its documents

The terms come from the RfS No. SECI/C&P/IPP/13/0002/26-27 dated 15.07.2026 (`rfp.pdf` in the
repository; it replaces the RfS of 17.04.2026), the standard CfD Agreement (CfDA) and Amendments 02
(03.08.2026) and 03 (08.10.2026). Pages are the numbers printed on each page; the RfS PDF has a cover
first, so its PDF page is the printed page + 1. If documents differ the CfDA prevails, then the RfS
(CfDA 1.2.18). Where an amendment changed a term, the amended term applies:

* Settlement (Amd-03, CfDA 9.2.iv): the RPD receives the strike price for every kWh supplied; the
  CfD Pool pays SP − MCP when the market clears below it and receives MCP − SP when it clears
  above. The draft CfDA's 70:30 / 50:50 / 30:70 slab sharing is replaced.
* Term (Amd-03): 15 years from the SCD (was 12). Ceiling tariff: removed (was ₹5.80/kWh).
* Battery (Amd-02): X MW / 2X MWh for X MW contracted, owned by the RPD. SCD of the battery: 15
  months from the Effective Date; RE generation: 36 months from it.
* Sourcing (Amd-02): all supply RE; up to 25% from the green market or bilateral deals for the
  whole term; a further 75% for charging until month 36; then a further 50% from group-company RE
  for charging; shares measured on the energy discharged.
* Bid (RfS 6.1, 6.2): one bid per group, 50 to 150 MW cumulative in whole MW, at most 150 MW
  awarded. e-RA (41, 42): SE = 0.8 × the qualified bid capacity, at most 500 MW (the H1 bidder is
  dropped when 0.8 × ST exceeds 500 MW); quotes fall by at least ₹0.01/kWh; every bidder within
  L1 + 2% wins in tariff order up to SE; the last may be offered part (never under 50 MW) and must
  accept if it is at least half its bid.
* Securities and charges (RfS): EMD (17) ₹9.68 lakh/MW solar + ₹13.68 lakh/MW wind + ₹2.40 lakh/MWh
  battery, valid 12 months; PBG (18.1) ₹24.20 lakh/MW solar + ₹34.20 lakh/MW wind + ₹6.00 lakh/MWh,
  within 20 days of the LoA, valid to 6 months after the SCD; Contract Administration Charges (19.1)
  ₹1 lakh/MW + GST; bid processing fee ₹20,000/MW (at most ₹20 lakh) and RfS cost ₹50,000, + GST.
  Capacities are installed AC (CfDA 1.1 Installed Capacity).
* Dates (RfS 21): CfDA signed within 30 days of the LoA; Effective Date = the 30th day from the LoA.
* Eligibility (RfS 37): net worth ₹96.8 lakh/MW solar + ₹1.368 crore/MW wind + ₹24 lakh/MWh; and
  one of turnover ₹42.37 lakh, PBDIT ₹8.47 lakh or a line of credit ₹10.59 lakh per contracted MW.
  Shareholding in the project company ≥ 51% until a year after the SCD (23.5). Solar uses domestic
  cells and modules (Annexure-B 1.d).
* Daily supply (CfDA): 2 MWh per contracted MW in 2 hours chosen day-ahead between 18:00 and 24:00,
  cleared on an exchange; weekly shortfall beyond 10% of 14 MWh/MW is penalised at 1.5 × (the week's
  highest evening MCP across exchanges − SP); the RPD gives SECI an LC of 2000 × MW × (₹10 − SP) × 30;
  RECs from brown-market sales are sold within 3 months, half the proceeds to the Pool.

Where the documents still differ (marked "documents differ"; the model follows the CfDA):

* RfS 7.1 lets the battery sit away from the RE; the CfDA's RE Power Project says co-located.
* RfS 2.6 offers existing projects a longer CfDA "pursuant to Clause 11", and Clause 11 reads "Not
  used". The longer term is not defined and not modelled.

Replaced and marked: the ₹5.80 ceiling and the slab sharing (Amd-03); RfS 4.4's third-party battery
(Amd-02, which numbers the clause 4.3); the RfS's 12-year term (Amd-03, RfS 2.3, 21.2, 21.7).

`tests/test_cfd_terms.py` checks every quote against its page (and each RfS page number against the
"Page N of 128" printed on it): the RfS from the repository, the CfDA and amendments when available
(`CFD_DOCS_DIR`).

## Operations (`simulate`)

Every day from the SCD to the end of the term, with the IEX DAM/GDAM/RTM prices of Sep 2025 –
Sep 2026 (escalated by the bidder's rate):

1. The 2 Peak Hours are the two highest-priced hours of 18:00–24:00 in the market the bidder sells
   in (the CfDA asks the RPD to bid to maximise revenue).
2. The day's supply is Contracted MW × 2 h × availability: own wind in those hours, then the battery.
3. The battery charges before 18:00 from own RE first (in the hours its market value is lowest),
   then from GDAM power (hourly price + charges) and group-company RE (price + charges), cheapest
   first, within each Contract Year's limits (April–March; the SCD to 31 March for the first).
4. Own RE not needed is sold in the GDAM within the connection (the Contracted MW) on days the
   supply is met (CfDA 4.4.1.v), or curtailed.
5. Each Contract Week's shortfall beyond 10% is penalised at the strike price being solved.

Shown as assumptions, not tender terms: hourly (not 15-minute) prices; the battery empties each
evening and recharges the next day; group-company power is available in any hour before 18:00; RECs
are counted only on energy from own RE sold in a brown market; surplus RE is sold only after the
day's supply is met (a cautious reading of 4.4.1.v, since the evening obligation comes after the
daytime sale).

## Financial model (`financials`, `solveStrikePrice`)

Construction (battery, line and pre-operative costs; SECI's charges with GST; the cost of the EMD
and PBG bank guarantees over their validity, EMD 12 months and PBG from 20 days after the LoA to 6
months after the SCD, each with the 30-day claim period), then each Contract Year: CfD
revenue (SP × energy supplied), surplus sales, the bidder's half of REC sales; charging power, O&M,
augmentation (degraded MWh replaced every year at a falling price), scheduling and fees, insurance,
exchange fees, the LC cost and penalties. Own RE capex is spent at its commissioning. Straight-line
depreciation, debt at the debt share drawn with each tranche and repaid in equal principal over the
tenor, tax at the corporate rate with losses carried forward. The strike price is the price at which
the equity NPV at the target IRR is nil (bisection); the bid is that price rounded up to two
decimals. Optionally the plant keeps selling at market prices for some years after the term.

**Optimise own RE** tries own solar (and wind, if in the bid) from 0 to 3 × the contracted MW and
keeps the size with the lowest strike price at which every day's supply is met within the sourcing
limits.

**The CfD Pool at your strike price**: the project's net pay-in to the Pool each year,
(MCP − SP) × energy supplied. At a strike price above the evening market price the Pool pays out;
scaled to 500 MW this shows how long the ₹76 crore Pool would last, which is the bidder's payment
security (CfDA 10.4(b)).

## Checks

* `tools/check_cfd_model.mjs`: the terms, dates and Contract Years, the RfS's EMD, PBG, charges and
  eligibility amounts, the 50–150 MW bid, the LC and penalty formulas, the
  benchmarks, operation within the sourcing limits on synthetic prices, too little own RE falling
  short, the strike price earning exactly the target IRR, debt repaid, the Pool flows, and the real
  IEX year with the optimiser.
* `tests/test_cfd_terms.py`: every quote on its page.
