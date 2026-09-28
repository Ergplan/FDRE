# Enterprise FDRE Optimization Engine

## Developer Handoff

Start with the [Enterprise Development Handoff](docs/enterprise/README.md) for
the current-system inventory, multiple tender families, rule-engine design,
enterprise UI specifications, data/API contracts, input dictionary, validation
matrix and phased delivery backlog. Proposed features are clearly separated
from what is implemented today.

## React Application

The current frontend is in `react_demo/`, with a FastAPI backend and the Python
optimization, finance, yield-assessment and tender-review modules in this repository.
Use Python 3.12 and a recent Node.js LTS release.

From the repository root:

```sh
python3.12 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
# Optional layout, table and OCR extraction:
python -m pip install -r requirements-docling.txt
cd react_demo
npm ci
python -m uvicorn backend.api:app --host 127.0.0.1 --port 8000
```

In a second terminal, run `npm run dev` from `react_demo`, then open
http://127.0.0.1:5173/. See `DOCLING_SETUP.md` for parser setup. Tender reviewer
drafts are stored in the browser and can be downloaded as JSON; they are not
shared server-side records. CfD documents can be reviewed but their settlement
and dispatch rules are not implemented by the FDRE optimizer.

Installed Python environments, `node_modules`, build output, and unrelated local
documents are excluded from Git. External resource inputs such as the Bikaner
wind CSV are not bundled here; see `react_demo/README.md` for the current input path.

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
