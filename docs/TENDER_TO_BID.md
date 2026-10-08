# Tender to Bid

A dashboard tab that takes a power-sale tender (RfS / RfQ / RfP) from upload to a priced bid in
four steps. It is separate from Round the Clock and the FDRE tabs, and does not change them.

| Step | What happens | Where |
| --- | --- | --- |
| 1 Tender | Upload the PDF/DOCX; the tender intelligence engine reads it in the background (progress shown) | `POST /api/bid/tender/read`, `GET /api/bid/tender/read/{job}` (`tender_intel/`) |
| 2 Requirements | What the tender sets (capacity, supply floors, peak hours, sources, term, ceiling, EMD, PBG) with the page and quote of each; untick anything you do not want applied. Below it, every field read, by section, with its evidence and checks | `web/src/bid/tenderMap.js`, `RequirementsStep.jsx` |
| 3 Size | The plant the optimizer may build (solar, wind, **biomass**, battery), the supply floors and the peak window; HiGHS finds the least-tariff design and its hour-by-hour dispatch | `POST /api/rtc/lp` (`fdre_rtc_lp.py`), `SizeStep.jsx` |
| 4 Financials | The 25-year financial model of that design: bid tariff at the target equity IRR, headroom to the ceiling, capex by source, guarantees, biomass fuel, statements | `engine.js runFinancialModel` with the LP's yearly energy, `FinanceStep.jsx` |

Every model input set from the tender shows a page chip; hover it for the quote it rests on.
A dashed red chip means the quote was not found on the page and the value should be checked.

## Supply floors

The tender's obligations become floors on delivered energy ÷ (contracted capacity × hours):

* **Annual** over all hours of each year (e.g. 80% CUF per accounting year),
* **Monthly** over all hours of every month (e.g. 70% CUF monthly),
* **Peak** over the peak hours, every month or over the year (e.g. 90% in 4 peak hours a day).

Demand is the contracted capacity in every hour (round-the-clock supply), so each floor is the
tender's CUF measure. The LP enforces every floor in every modelled PPA year (year 1, the years
that bind and augmentation years; other years are interpolated), with solar degradation and
battery fade. The peak window start is an input: tenders often let the procurer choose the hours.

## Biomass

A dispatchable renewable generator with its own size and hourly output:

* output ≤ availability × MW in every hour, ≥ minimum stable load × MW (it runs all year),
* yearly output ≤ fuel-limited PLF × 8,760 × MW,
* capex (₹ cr/MW), O&M (₹ lakh/MW/yr) and fuel (₹/kWh generated, escalating) are costs; fuel
  enters the LP objective and the financial model's operating cost ("Biomass fuel" line).

Biomass may charge the battery and its surplus is sold or curtailed like solar and wind.
Default costs are planning assumptions; set them from quotes.

## Surplus sold on IEX

Energy the contract and the battery cannot take may be sold on the exchange (switch on the Size
step; a tender that mandates solar beyond the contracted capacity switches it on, with that
solar's own connection as extra export capacity). The price is hourly:

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

* Non-RE supply with RECs (some RE-RTC tenders allow up to 49%): the design is 100% renewable,
  which meets any minimum green share but may price above bidders who buy non-RE power.
* Greenshoe capacity: sized for the base capacity; resize for base + greenshoe if needed.
* Scenario saving: the tab keeps its state in the browser (per user and device); the shared
  Scenarios library is not used yet.

## Checks

* `tests/test_bid_lp.py` — biomass sizing, fuel cost, peak/monthly/annual floors, hourly market
  prices (a constant series equals the flat price; sales are valued at their hour), and that
  Round-the-clock requests are unchanged (results of three RTC cases were compared before and
  after the change and are identical).
* `tools/check_bid_model.mjs` — tender fields → model inputs, the HiGHS request, the financial
  model with fuel and the NPV-based tariff solve.
* `tests/test_tender_intel.py` — the tender reader (see `docs/TENDER_INTEL.md`).
