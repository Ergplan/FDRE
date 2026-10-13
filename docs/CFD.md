# CfD bid (SECI CfD-I)

A dashboard tab for bidding SECI's CfD-I tender: assured peak supply of 1000 MWh a day (500 MW ×
2 hours) from ISTS-connected RE projects, sold on the power exchanges and settled by SECI's CfD Pool
against the bidder's strike price. It is a separate tab (`cfd`, "CfD Bid") and runs in the browser;
an administrator grants it like the other tabs.

| Step | What it shows | Where |
| --- | --- | --- |
| 1 How it works | The tender as a picture: a flow diagram of energy and money (RE plant, group RE, green market → battery → exchange → CfD Pool → the bidder), the timeline from the Effective Date to the end of the term, a day of supply on IEX evening prices, the winning bidder's obligations in order, and the money in one line | `VisualModel.jsx` |
| 2 Tender terms | 57 terms in 7 groups, each with its document, clause, page and quote; terms an amendment replaced are kept and marked | `terms.js`, `TermsStep.jsx` |
| 3 Plant and sourcing | Contracted MW, Effective Date (the tender's dates follow), battery, own solar and wind, charging sources and markets; **Fill up for me please**; **Optimise own RE** | `InputsStep.jsx` |
| 4 Costs and finance | Capex, O&M, augmentation, exchange fees, LC, PBG, financing | `InputsStep.jsx` |
| 5 Operations | Every day of the term: supply, where the energy came from against the limits, surplus sold, curtailment, weekly penalties; any day's hourly operation | `model.js simulate`, `OperationsStep.jsx` |
| 6 Bid and financials | The strike price for the target equity IRR (rounded up to two decimals), IRRs, DSCR, levelised cost, the CfD Pool at that price, revenue and costs by year, the statements; **Download financial model (Excel)** | `model.js financials`, `FinanceStep.jsx`, `POST /api/cfd/model` |

## The tender, from its documents

The terms come from the standard CfD Agreement (CfDA) and Amendments 02 (03.08.2026) and 03
(08.10.2026). The RfS itself (No. SECI/C&P/IPP/13/0002/26-27 dated 15.07.2026) was not loaded: the
EMD and PBG amounts, the capacity a bidder may apply for, eligibility, dates and e-RA rules, the
contract administration charges and the technical annexures are listed as not loaded; the PBG is a
bidder input. Where an amendment changed a term, the amended term applies:

* Settlement (Amd-03, CfDA 9.2.iv): the RPD receives the strike price for every kWh supplied; the
  CfD Pool pays SP − MCP when the market clears below it and receives MCP − SP when it clears
  above. The draft CfDA's 70:30 / 50:50 / 30:70 slab sharing is replaced.
* Term (Amd-03): 15 years from the SCD (was 12). Ceiling tariff: removed (was ₹5.80/kWh).
* Battery (Amd-02): X MW / 2X MWh for X MW contracted, owned by the RPD. SCD of the battery: 15
  months from the Effective Date; RE generation: 36 months from it.
* Sourcing (Amd-02): all supply RE; up to 25% from the green market or bilateral deals for the
  whole term; a further 75% for charging until month 36; then a further 50% from group-company RE
  for charging; shares measured on the energy discharged.
* Daily supply (CfDA): 2 MWh per contracted MW in 2 hours chosen day-ahead between 18:00 and 24:00,
  cleared on an exchange; weekly shortfall beyond 10% of 14 MWh/MW is penalised at 1.5 × (the week's
  highest evening MCP across exchanges − SP); the RPD gives SECI an LC of 2000 × MW × (₹10 − SP) × 30;
  RECs from brown-market sales are sold within 3 months, half the proceeds to the Pool.

`tests/test_cfd_terms.py` checks every quote against its page of the PDFs when they are available
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

Construction (battery, line and pre-operative costs; PBG cost), then each Contract Year: CfD
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

* `tools/check_cfd_model.mjs`: the terms, dates and Contract Years, the LC and penalty formulas, the
  benchmarks, operation within the sourcing limits on synthetic prices, too little own RE falling
  short, the strike price earning exactly the target IRR, debt repaid, the Pool flows, and the real
  IEX year with the optimiser.
* `tests/test_cfd_terms.py`: every quote on its page.
