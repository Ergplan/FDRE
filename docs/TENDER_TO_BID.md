# Tender to Bid

A dashboard tab that takes a power-sale tender to a priced bid. It is separate from Round the Clock
and the FDRE tabs, and does not change them. The WBSEDCL RE-RTC RfQ/RfP is loaded when the tab
opens (its reading ships built in), so the work starts from what the tender requires.

| Step | What happens | Where |
| --- | --- | --- |
| 1 Tender | Every requirement of the tender on one page: what it says, how the sizing applies it, and the page and quote it comes from. Below it, every field read; then other tenders (read before, or a new upload) | `tenderMap.js` (`buildProposals`, `tenderTerms`), `TenderStep.jsx`, `RequirementsStep.jsx` |
| 2 Bid capacity | The capacity you bid and whether the plant is sized for the greenshoe too, checked against the tender (WBSEDCL: 1,500 MW, no part capacity, 500 MW greenshoe at the same tariff) | `CapacityStep.jsx` |
| 3 Supply sources | The sources you have: solar, wind, hydro, biomass, thermal (non-RE) and battery. For each, fixed capacity or the most the optimizer may build, its parameters (CUF, availability, minimum load, battery duration and efficiency) and its costs; then financing and, where the tender allows it, market sale. Every field starts empty | `SourcesStep.jsx`, `model.js` (`SOURCE_FIELDS`, `missingInputs`) |
| 4 Size | HiGHS finds the least-tariff plant from your sources that meets every tender requirement, with the tender conditions table (met / not met) | `POST /api/rtc/lp` (`fdre_rtc_lp.py`), `SizeStep.jsx`, `Checklist.jsx` |
| 5 Financials | The financial model of that plant: bid tariff at your equity IRR, capex by source, fuel, hydro and thermal costs (with RECs), guarantees, statements | `engine.js runFinancialModel`, `FinanceStep.jsx` |

## Constraints from the tender, inputs from the bidder

The sizing applies only constraints the tender states, each from a field the tender engine read
with a quote located on its page (`tenderTerms`). For WBSEDCL:

* Supply floors: 80% CUF each accounting year, 70% every month, 90% in peak hours (p. 10). The
  peak hours are decided by WBSEDCL (4 h a day), so the 90% floor is checked in every hour of the
  day, every month (the tender does not state the measuring period; the stricter monthly check is
  used and said so on the requirements page).
* Sources: solar, wind, hydro, biomass and storage are named (p. 9); non-RE supply is allowed for
  the balance with RECs (p. 10) with at least 51% traceable green power each accounting year
  (p. 10), a hard constraint of the sizing once a non-RE source is in the bid; solar of twice the
  contracted capacity is mandatory (p. 11).
* Market sale: only the mandated solar may be scheduled in the market (p. 11); the PPA is supplied
  first in every hour and only solar surplus is sold. Non-RE energy is never sold.
* Capacity: 1,500 MW, no part capacity (p. 12); greenshoe 500 MW at the procurer's option, supply
  from 01.04.2029, same tariff (p. 10). PPA term 25 years.

Everything else is the bidder's input and nothing is filled in: capacities, CUF and the other
plant parameters, every cost (capex, O&M, fuel, hydro and thermal fixed and energy charges, REC
cost), financing (equity IRR, debt, interest, tenor, tax, escalations, insurance, pre-operative
costs, transmission) and the market choice. **Size** stays disabled until every source switched on
has all of its inputs; the missing ones are listed. Solar and wind take an hourly profile shape (a
typical profile, or the site's 8,760-hour profile from the library or an upload) scaled to the CUF
entered. The inputs used are listed on the Size step under "Your inputs".

Hydro and thermal are dispatchable sources in the sizing LP (`plants` in the request): output up
to availability × MW each hour, at least the minimum load, energy within the CUF (per year, or per
month for hydro when a monthly CUF is entered); costs are capex per MW, a fixed or capacity charge
per MW per year and an energy charge per kWh (plus the REC cost for thermal), escalating yearly.
Enter capex 0 for power bought under contract.

### Guardrails on the reading

* The model must quote; every quote is searched on the PDF page (capped confidence and review when
  not found; rejected without a quote); every number and date must be printed in its own quote
  (`value_in_quotes`, an FDRE addition); types, ranges and cross-field rules are plain Python.
* The Tender step says which reader produced the values (and, for the model,
  which provider and model). Without `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` the engine falls
  back to the rule-based reader and the screen says so.
* A value is used in the model only when the page proves it: its quote is found on the page and
  prints the value. A value whose quote is not found or does not print it is shown unticked as
  "Not proved by the page" and is applied only if the reviewer ticks it after checking. A review
  raised by a plausibility check alone (a range, the EMD/PBG ratio) does not block a value the
  page prints.
  `TENDER_INTEL_REQUIRE_LLM=1` switches the fallback off: a read that cannot use the model fails.

## Recently extracted tenders

Each tender read is saved (`tender_reads`, migration 006) and listed on the Tender step for every
Tender to Bid user, so a tender read once can be opened again. The WBSEDCL RfQ/RfP reading ships
built in (`web/db/seed/tenders/`).

## Supply floors

The tender's obligations become floors on delivered energy ÷ (contracted capacity × hours):

* **Annual** over all hours of each year (e.g. 80% CUF per accounting year),
* **Monthly** over all hours of every month (e.g. 70% CUF monthly),
* **Peak** over the peak hours, every month or over the year (e.g. 90% in 4 peak hours a day).

Demand is the contracted capacity in every hour (round-the-clock supply), so each floor is the
tender's CUF measure. The LP enforces every floor in every modelled PPA year (year 1, the years
that bind and augmentation years; other years are interpolated), with solar degradation and
battery fade. When the procurer picks the peak hours, the peak floor holds in each hour of the day on its own.

## Biomass

A dispatchable renewable generator with its own size and hourly output:

* output ≤ availability × MW in every hour, ≥ minimum stable load × MW (it runs all year),
* yearly output ≤ fuel-limited PLF × 8,760 × MW,
* capex (₹ cr/MW), O&M (₹ lakh/MW/yr) and fuel (₹/kWh generated, escalating) are costs; fuel
  enters the LP objective and the financial model's operating cost ("Biomass fuel" line).

Biomass may charge the battery; its surplus is curtailed (only what the tender allows is sold).

## Surplus sold on IEX

Where the tender allows a sale, the bidder chooses on the Supply sources step whether to sell; for
WBSEDCL only the mandated solar's surplus, over its own connection, after the PPA is supplied in
every hour. The price is hourly:

* **IEX GDAM** (green day-ahead, the default for renewable surplus), **DAM** or **RTM**, from
  15-minute market-clearing prices (`web/public/market/iex_hourly_prices.json`, built by
  `tools/build_iex_prices.py` from the IEX extracts for 1 Sep 2025 to 24 Sep 2026). Each hour of
  the year is the mean of its four blocks on the latest date with data for that day; missing
  days take the same weekday a week either side. Averages: GDAM ₹4.90, DAM ₹4.45, RTM ₹4.14
  per kWh, with midday near ₹2 and the evening peak near ₹7.5–8.3.
* or a flat price.

The LP values every MWh exported at that hour's price (escalated yearly if set), so it shifts
dispatchable output (biomass) to dear hours and counts cheap midday solar surplus for little.
The sale shows in the year-1 energy stack (MU, ₹ cr, realised ₹/kWh), in the dispatch chart
(with the price line) and in the Financials revenue stack (PPA supply, IEX sale, penalties).

To refresh the prices with a newer extract:

```
python tools/build_iex_prices.py --gdam GDAM.xlsx --dam DAM.xlsx --rtm RTM.xlsx \
    --out web/public/market/iex_hourly_prices.json
```

## What is not modelled yet

* Scenario saving: the model inputs and sizing live in the browser (per user and device); tender
  readings are shared (Recently extracted tenders), the Scenarios library is not used yet.
* The greenshoe is modelled from the base supply start; its own start (01-04-2029 for WBSEDCL) is
  nine months later, so the sizing is slightly conservative.

## Checks

* `tests/test_bid_lp.py` — biomass, hydro (annual and monthly CUF) and thermal sizing, the green
  share cap on non-RE, non-RE never sold, costs reaching the tariff, peak/monthly/annual floors,
  hourly market prices (a constant series equals the flat price; sales are valued at their hour), and that
  Round-the-clock requests are unchanged (results of three RTC cases were compared before and
  after the change and are identical).
* `tools/check_bid_model.mjs` — the WBSEDCL terms from the built-in reading, that every bidder
  input starts empty and sizing waits for it, the HiGHS request, and the financial model with
  hydro and thermal costs (RECs) and the NPV-based tariff solve.
* `tests/test_tender_intel.py` — the tender reader (see `docs/TENDER_INTEL.md`).

## Deploying

`bash deploy/update.sh` on the VM. The engine image no longer installs Docling by default (only the
older tender review on the existing screens uses it, and falls back to its standard reader without
it), so an update builds in a few minutes. `INSTALL_DOCLING=true bash deploy/update.sh` adds it back.
