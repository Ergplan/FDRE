# Enterprise FDRE Optimization Engine

## Developer Handoff

Start with the [Enterprise Development Handoff](docs/enterprise/README.md) for
the current-system inventory, multiple tender families, rule-engine design,
enterprise UI specifications, data/API contracts, input dictionary, validation
matrix and phased delivery backlog. Proposed features are clearly separated
from what is implemented today.

## Web application (Next.js + Postgres)

The product is the Next.js app in `web/`. It has email/password login, and saved scenarios
with version history, comparison and Excel export, stored in Postgres. The Python modules in
this repository (optimizer, finance, EYA, tender review) run as a FastAPI service
(`react_demo/backend/api.py`). The web app forwards `/api/*` engine calls to it for
signed-in users. Each client deployment has its own database.

Run everything with Docker:

```sh
cp .env.example .env   # set POSTGRES_PASSWORD and SESSION_SECRET
docker compose up -d --build
```

Then open http://localhost/ and create the administrator account. For VM deployment and
backups, see `deploy/gce/README.md`.

Local development without Docker (Python 3.12, Node 22, a local Postgres):

```sh
python3.12 -m venv .venv && source .venv/bin/activate
python -m pip install -r requirements.txt
# Optional layout, table and OCR extraction:
python -m pip install -r requirements-docling.txt
(cd react_demo && python -m uvicorn backend.api:app --host 127.0.0.1 --port 8000) &
cd web && cp .env.example .env.local   # point DATABASE_URL at your Postgres
npm ci && npm run dev                   # http://localhost:3000
```

Database migrations in `web/db/migrations` are applied automatically when the web app
starts.

The app carries Joulewise branding on every page (logo files in `web/public/brand/`). An
administrator sets which dashboard tabs other users can open under **Users → Tab access**.
There is a deployment default plus optional per-user custom lists. Tabs a user may not open
are greyed out with "Contact Administrator". Users without any engine-backed tab are also
refused by the engine API.

**Administration → Activity** (`/admin/activity`) shows who signed in when and how much they
used the app, for the last 24 hours up to a year:

- **By user:** sign-ins and failed sign-ins, active time and open time, and optimizer runs.
  It also shows engine calls and compute time, scenario saves, exports and the most used tab.
- **Sign-ins:** each session with its start, last seen, sign-out, active time, browser and IP.
- **Event log:** filterable by user and event.

Each view downloads as CSV. Active time counts minutes with the app visible and used within
the last 5 minutes, reported by a heartbeat every minute. Sign-ins, engine calls, saves,
exports and profile uploads are logged by the server. Tab views and optimizer runs are
reported by the browser. Records are kept for 400 days (tables `user_sessions` and
`activity_log`). See `DOCLING_SETUP.md` for parser setup. Tender reviewer
drafts are stored in the browser and can be downloaded as JSON; they are not
shared server-side records. CfD documents can be reviewed but their settlement
and dispatch rules are not implemented by the FDRE optimizer.

Installed Python environments, `node_modules`, build output, and unrelated local
documents are excluded from Git. External resource inputs such as the Bikaner
wind CSV are not bundled here; see `react_demo/README.md` for the current input path.

## Round the Clock (RTC) tab

The dashboard opens on **Round the Clock**, a least-tariff sizing workspace for firm RE supply
(default case: 2,455 MU/yr, 285 MW plant capacity, 85% DFR, Beed, Maharashtra; capex solar
₹3.5 cr/MW, wind ₹6.5 cr/MW, BESS ₹1.2 cr/MWh). Its engine (`web/src/rtc/engine.js`) runs in
the browser; only the HiGHS sizing LP (below) runs in the Python service.

It reads as a story. Six chapters sit in a vertical rail, each with its own icon and colour:

1. **Energy needed**: annual energy, plant capacity and load factor (linked by locks), plus
   demand growth and losses.
2. **Supply type**: round-the-clock, peak-weighted, day-time or night-weighted presets,
   seasonality, or a profile drawn with the mouse or uploaded (8760 / 15-minute CSV).
3. **DFR**: target, measured annually or every month, a lifetime design check, shortfall
   penalty and surplus sales.
4. **Solar** and 5. **Wind**: size (fixed by lock, or an optimizer range), capex, O&M and
   degradation. The generation profile comes from a shared **profile library** in Postgres,
   the synthetic site profile, or an upload, and its monthly CUF can be redrawn. Uploads can
   be SCADA or meter exports with dates (15-minute or hourly, part of a year) or plain
   8760 / 35040 lists. They are converted to 8760 hourly capacity factors (capacity from the
   CUF column or a reference MW, negatives clipped, readings above capacity dropped, gaps
   filled from the same month and hour), graded Validated / Use with care / Rejected, and can
   be saved to the library for the team. Excel workbooks (`.xlsx`, e.g. PVsyst hourly
   exports with an "AC, 300, MW" header line) are converted on the server. Wind plants below
   25% PLF are kept out of the library (the build tool drops them, the server refuses to save
   them, and built-in rows that are no longer shipped are removed at start-up). Built-in
   profiles live in `web/db/seed/profiles/`: 4 Maharashtra (WRPC) wind plants plus a validated
   Beed-cluster average (`node tools/build_profile_library.mjs <scada-folder> <out.json>`),
   and the Beed 300 MWac / 450 MWp fixed-tilt PVsyst solar profile at 33 kV
   (`node tools/build_solar_seed.mjs <file.xlsx> <out.json> <seedKey>`).
6. **Battery storage**: a 2-hour or 4-hour discharge duration (energy = power × hours, so
   the optimizer sizes only MW), plus cost, efficiency, SoC window, fade and augmentation.

**Optimize least tariff** minimises the 25-year tariff at the target equity IRR, with the DFR
required in every PPA year (solar/wind degradation, battery fade and augmentation, demand
growth). It runs in four steps, shown in a full-screen animation:

1. **Screening** (Web Worker): a grid of solar × wind mixes, with battery power searched and
   the smallest battery that holds the DFR found by bisection.
2. **Tariff map**: the full 25-year financial model (hourly dispatch every year, debt, tax,
   working capital) for the best design at every grid point. This is the isometric surface
   in the animation (mixes that miss the DFR form a red plateau) and the **Tariff for every
   solar and wind size** heatmap afterwards.
3. **HiGHS** (`fdre_rtc_lp.py`, engine route `/api/rtc/lp`): a linear programme with hourly
   dispatch for year 1 and every year that can bind the DFR (70k variables and 105k
   constraints for the default case). Its objective is the equity-IRR tariff. The equity NPV
   is linear in the design, with tax timed by the screening design's loss carry-forward, so
   the tariff (cost ÷ energy) is solved exactly by Dinkelbach iterations. HiGHS proves a lower
   bound: no design in the ranges can beat it under that model. It also reports what one more
   point of DFR costs. The solve takes about 45 s for the default case, and its log streams
   into the animation. **Continue without HiGHS** skips it; without the engine the search
   runs alone. Settings → Solver chooses between the two.
4. **Exact refinement**: the rounded HiGHS optimum and the best screening designs are priced
   with the exact 25-year model, then refined by pattern search and a neighbourhood check.

For the default case HiGHS moves the answer from the search's local optimum (695 / 460 / 400 MW
at ₹5.6562/kWh) to 675 MW solar, 475 MW wind and 395 MW / 1,580 MWh battery at ₹5.6535/kWh,
against a proven floor of ₹5.6522. The least levelised cost and least capital cost objectives
remain available and use the search only.

The answer is then revealed. Below it are:

- the dispatch, with a Day / Month / Year toggle. The Day view uses the
  [Ergplan/charting](https://github.com/Ergplan/charting) `energy-flow-chart` library,
  vendored in `web/vendor/`.
- the full 25-year financial model: P&L, cash flow, debt, DSCR and IRRs, with the tariff
  solved for the target equity IRR or fixed by lock, and CSV export.
- **What ageing does to the tariff**: the same plant solved without ageing, with generation
  degradation, and with battery fade plus augmentation.
- the tariff map.
- the lowest-tariff alternatives.
- the optimizer log, including HiGHS's own output.

Every input has a lock toggle. Save the case to the database from the header.

Engine checks: `node tools/check_rtc_engine.mjs` and `python -m pytest tests/test_rtc_lp.py`.
The synthetic profiles are for screening only, so upload bankable 8760 profiles before
bidding.

## BESS Tender tab

**BESS Tender** reads a standalone battery storage RfS and prices the bid. It follows the same
story flow as Round the Clock:

1. **Tender:** upload the RfS (PDF, Word or text). The engine (`fdre_bess_tender.py`, route
   `/api/bess/parse`) reuses the tender pipeline from `fdre_tender_rag.py`:
   - Docling reads the layout, tables and OCR, with page boundaries kept. If the OCR models
     can't load it retries without OCR, then falls back to the standard extractor.
   - The text is split into clause-aware chunks, and the issuer, RfS number, timeline, risk
     flags and amendments are extracted.
   - It then extracts about 23 BESS requirements: power and energy, duration, cycles per day
     and per year, minimum round-trip efficiency, availability and its basis, contract term,
     SCOD, tariff basis and ceiling, VGF, who supplies charging energy, capacity-maintenance
     (augmentation) obligation, connection voltage, bid limits, EMD and PBG, and the
     availability and RTE penalties.
   - Each requirement has a confidence (found / check / default) and its page, clause and
     snippet.
2. **Requirements:** every value is editable and lockable. Locked values survive a new upload
   or amendment. Click a source to see the tender text.
3. **Battery**, 4. **Costs**, 5. **Finance:**
   - efficiency, depth of discharge, calendar and cycle fade;
   - DC block, PCS and balance-of-plant costs, cell price decline, augmentation campaign cost,
     O&M;
   - debt, tax and target equity IRR.
6. **Optimize:** the engine (`web/src/bess/engine.js`, runs in the browser) prices every
   day-one oversize (0 to 60%) against every augmentation interval (1 to 12 years). Each
   strategy gets a yearly capacity plan that keeps the contracted MWh at the delivery point
   in every year, plus a full financial model. The capacity charge (₹/MW/month) is solved
   for the target equity IRR. The same isometric animation shows the surface, then the
   answer is revealed:
   - the bid against the ceiling;
   - tender compliance, with sources;
   - energy over the term, stacked by battery block, with the RTE;
   - a day of operation for any year;
   - the financial model, with CSV export;
   - the strategy map;
   - tender insights: penalties, securities, risk flags and amendments.

Checks: `node tools/check_bess_engine.mjs` and `python -m pytest tests/test_bess_tender.py`
(which uses a generated sample RfS in `tests/bess_rfs_sample.py`). The engine Docker image
installs Docling with CPU-only PyTorch and pre-downloads its layout, table and OCR models
(`DOCLING_ARTIFACTS_PATH`). Set `INSTALL_DOCLING=false` to skip this; tender parsing then uses
the standard extractor.

## Product page and PDF

`/product` is a public page (no sign-in) pitching the product and its Free, Premium and Ultra
plans. It is a static page in `web/public/product/` with screenshots in `img/`. The brochure
`/product/Joulewise-product.pdf` is rendered from the same page with
`node tools/build_product_pdf.cjs [base-url]` while the app is running. Re-run that script
after editing the page.

## Streamlit Application

Streamlit application and Python engine for modelling the uploaded NHPC Tranche-II Firm & Dispatchable Renewable Energy (FDRE) RfS against the uploaded Rajasthan project configuration.

## Run

```bash
pip install -r requirements.txt
streamlit run app.py
```

From this machine, the prepared app folder is:

```bash
cd /Users/rachitagarwal/Documents/Application/FDRE_Optimizer
python3 -m streamlit run app.py
```

## Main files

- `app.py` - Streamlit application.
- `fdre_enterprise_engine.py` - core enterprise optimization engine used by the app.
- `fdre_eya.py` - Energy Yield Assessment module powering the "EYA Report" tab: wind/solar EYA with
  loss waterfalls and RSS uncertainty, BESS SoH/RTE schedules, P50/P75/P90 hybrid assessment run on
  the dispatch engine, 20-year yearly annexure, and a downloadable printable HTML report. Defaults
  calibrated to the RE4C "Hybrid EYA Report - 250 MW NHPC FDRE" (Bikaner/Jaisalmer portfolio).
- `enterprise_fdre_engine.py` - same engine, retained as a compatibility import/name for audit scripts.
- `project_config_fdre2.json` - default project configuration extracted from the uploaded project file.
- `PROJECT CONFIGURATION_FDRE 2.docx` - uploaded project configuration reference.
- `RFS.pdf` - uploaded RfS reference.
- `tests/` - smoke tests for the engine and full-dispatch export.

## Implemented RfS logic

- 25-year PPA term modelling.
- Peak schedule with 2 morning hours within 05:00-10:00 and 2 evening hours within 18:00-23:00.
- Fixed schedule and worst-deficit daily schedule-risk mode.
- Monthly 90% peak-availability test.
- Annual CUF test using declared CUF, 85% lower band and 110% upper purchase band.
- Monthly peak and annual CUF liquidated damages at 1.5x tariff.
- RE-only BESS charging; no grid/fossil charging is introduced by dispatch.
- BESS state of charge carried over hour-to-hour, with circular-year convergence.
- Uploaded BESS SOH/RTE degradation curve and year-11 augmentation/reset.
- NHPC PSM charge, success charge, processing fee, EMD and PBG formulae.
- Post-tax financial model with capex, IDC, debt annuity, WDV tax depreciation, loss carry-forward, working capital, BESS augmentation and DSCR.
- Capacity optimizer for wind MW, solar MWac, BESS MW, BESS MWh and contracted capacity.
- Capacity optimizer now starts from a SciPy HiGHS LP seed before running nonlinear dispatch/finance evaluation.
- Annual CUF calculations use the RfS illustration convention of 8766 hours.

## App solve modes

The sidebar includes an **Operating solve mode** selector:

- **Fast representative years** simulates years 1, 5, 10, 15, 20 and 25, then interpolates the rest for quicker interaction.
- **Exact full PPA term** simulates every PPA year for audit-quality operating and finance tables.

## Full dispatch export

The **Exports** tab now includes a full PPA-term dispatch download:

- `fdre_hourly_dispatch_ppa_term.csv` - every modelled hour for every PPA year (`8760 x PPA years`; 219,000 rows for a 25-year PPA).
- `fdre_yearly_dispatch_ppa_term.csv` - one exact annual dispatch/compliance row per PPA year.
- `fdre_monthly_compliance_ppa_term.csv` - monthly peak availability, external-green support and shortfall for every PPA year.
- `current_fdre_project_config.json` - the exact app configuration used to generate the dispatch export.

The app also keeps quick downloads for the current project JSON, displayed operating summary, first-year hourly dispatch and finance table.

## Profile input

The app can use synthetic profiles calibrated to solar/wind CUF. Custom profile ingestion can be added through the JSON/model layer using 8760-row hourly capacity-factor traces for the generators.

## Important modelling notes

This is an enterprise screening and bid-sizing engine, not a substitute for bankable resource assessment, lender model audit or legal review. Replace synthetic resource profiles, cost assumptions, tax assumptions and financing terms with project-specific inputs before investment approval.
