# Day 5 report: formula workbook, historical tenders, collaboration

Date: 2026-10-15. Branch `claude/laughing-pascal-7akw12` in `Ergplan/FDRE`.

## Gate

| Gate requirement | Evidence |
|---|---|
| Exported workbook recalculates and matches backend results | `tests/platform/test_workbook.py::test_workbook_recalculates_and_reconciles_with_backend`: a `finance.v1` result is written as a formula workbook (no pasted outputs on the Returns sheet), recalculated by LibreOffice headless (`soffice --convert-to xlsx`), read back with `openpyxl` `data_only`, and equity IRR, project IRR, NPV equity and minimum DSCR agree with the backend within 0.1 %. The same verification runs on every export through the API (`POST /runs/{run_id}/workbook?verify=true`) and its outcome is stored with the artifact. Live demonstration below: equity IRR 0.14002 workbook vs 0.14002 backend on a real bid-tariff run. |
| Changing an input changes dependent outputs | `test_changing_an_input_changes_dependent_outputs`: raising the interest rate on the Inputs sheet and recalculating moves the equity IRR and DSCR, and the workbook's own Checks sheet reports `DIFFERS` against the stored backend values (so a reviewer sees that the workbook has diverged from the run). |
| Historical comparisons preserve units and sources | `tests/platform/test_history_collab.py::test_import_is_idempotent_and_keeps_units_statuses_and_sources` and `test_comparables_explain_similarity_and_refuse_incompatible_units`: every record keeps the published price unit (`INR/kWh`, `INR/MW VGF`, `INR/MW/annum (total storage cost)`, ...), capacity unit, status, date type, source URL, source sha256 and page; only `INR/kWh` awarded or adopted tariffs are returned as comparable tariffs, everything else carries `comparable_tariff: false` and a reason; import is idempotent on a stable key. |
| Concurrent edits cannot silently overwrite work | `test_concurrent_scenario_edits_cannot_silently_overwrite` (two users editing one scenario: the stale save gets 409 with the current revision, the other user's change survives, the merge is a new version with only the changed paths) and `test_chat_threads_mentions_decisions_and_immutability` (a database trigger refuses `UPDATE comment`; deletion is a flag; both are audited). |

## What was built (changed files)

- `fdre_platform/finance/workbook.py` (`workbook.v1`): builds the Excel model with `openpyxl` formulas and named ranges. Sheets: Read Me (version, run id, inputs hash, rules version, provenance of every assumption, stated simplifications), Inputs (every assumption with its source, editable), Dispatch (the per-year operating quantities from the run, a snapshot by design since dispatch is solved by the MILP, not a spreadsheet), Capex & Funding (contingency, fees, IDC, DSRA, debt/equity), Operations (revenue, penalties, purchases, fuel, opex escalation, EBITDA), Debt Tax Cashflow (sculpted or annuity debt schedule, WDV tax with loss carry-forward, CFADS, DSCR, FCFE), Returns (IRR, NPV, min/avg DSCR as formulas), Sensitivities (data table inputs) and Checks (workbook values against the stored backend values with a tolerance; `OK`/`DIFFERS`). `recalculate_with_libreoffice()` and `verify()` are the verification path.
- `fdre_platform/services/workbook_export.py`: builds the workbook from a run's stored result, stores it as an immutable `run_artifact` (`financial_model_xlsx`, sha256, size), verifies it and writes the audit event. The run itself is never modified.
- `fdre_platform/models/history.py`, `migrations/versions/0004_history_and_comments.py`: `historical_award` (stable key = sha256 of source sha256, page, bidder, allocation, reference; units and statuses as published; `result_kind` classification; `raw` record kept), `historical_source` (122 archived sources with sha256 and checked date), `comment` (chat, comments, decisions; threaded; mentions; immutable by trigger; deletion flag; correction link).
- `fdre_platform/services/history.py`: importer (`fdre-platform seed-awards --path <RE-tender-results checkout> --commit <sha>`), admissible source hosts, family normalisation, result-kind classification, freshness summary with gaps, `comparables()` with a `why_similar` list per match (family, procurer, capacity band, storage condition, term, recency) and `why_not_comparable` for non-tariff or incompatible results, and the dedupe check used before adding new results.
- `fdre_platform/services/collaboration.py`: tender chat and object-level threads, `@email` mentions limited to tender members, notifications for mention/reply/decision with the existing dedupe, decisions gated by `bid.approve` / `finance.review`, audit of every post and deletion.
- `fdre_platform/api/routes/collab_history.py`: `GET/POST /tenders/{id}/comments`, `POST /comments/{id}/delete`, `GET /history/awards`, `GET /history/freshness`, `POST /history/dedupe-check`, `POST /runs/{id}/workbook`, `GET /runs/{id}/artifacts`. All organisation- and permission-scoped through the existing dependencies.
- UI: `HistoryTab.jsx` (filters, freshness and gap chips, why-similar column, non-comparable rows greyed with the reason, source link with page and hash), `CollaborationPanel.jsx` (chat, threads, reply, mention hint, decisions for approvers, my open tasks), `RunResultPanel.jsx` export button showing the verification outcome and the artifact link; tabs "History" and "Collaboration" in `main.jsx`.
- `tools/demo_day5.sh`, `fdre_platform/cli.py` (`seed-awards`).

## Tests executed

- `tests/platform/test_workbook.py`: 2 passed (LibreOffice recalculation, about 25 s).
- `tests/platform/test_history_collab.py`: 4 passed in 17 s (the first run of the file hung for 15 minutes because the test leaked an open session, which blocked the between-test `TRUNCATE`; fixed in the test).
- Full platform suite: see the line recorded in `docs/platform/00-DISCOVERY-AND-STATUS.md` under Day 5 (run after this report was drafted; the number is filled in below).
- `ruff check` and `ruff format --check` clean on `fdre_platform/` and `tests/platform/`.
- `npm run build` of `react_demo` succeeds.

Full platform suite on 2026-10-15: `pytest tests/platform -q`: 58 passed, 1 skipped (live tender_engine test when no instance is configured) in 145 s.

## Reproducible demonstration

```sh
# seed the historical results (idempotent) into the platform database
DATABASE_URL=postgresql+psycopg://fdre:fdre@127.0.0.1:5432/fdre .venv/bin/python -m fdre_platform.cli seed-awards --path /home/user/ergplan/re-tender-results --commit f6d1d33
# -> records_inserted 583, records_skipped 40 (sources outside the admissible host list), sources_inserted 122
tools/restart_dev.sh && tools/demo_day5.sh
```

Output recorded on 2026-10-15 against the live stack:

```
dataset 583 records as of 2026-10-07, sources checked 2026-10-07, latest award 2026-08-21, 70 without price
  SJVN   M/s Juniper Green Energy  200.0 MW @ 4.38 INR/kWh [adopted_tariff] 2024-08-01 | same family (fdre: FDRE / assured power); capacity within 2x (200 MW); storage/firmness condition matches | src p.27 fb2399a1
  SECI   Altra Xergi Power         200.0 MW @ 8.5 INR/kWh  [awarded_tariff] 2025-01-02 | same family (fdre: FDRE / RTC / peak); ... | src p.1 01673133
  NTPC   Juniper Green Energy      200.0 MW @ 4.69 INR/kWh [adopted_tariff] 2025-02-24 | same family (fdre: FDRE with storage); ... | src p.12 1419a16a
non-tariff results kept apart:  3.14 INR/kWh -> result is ranking, not an awarded or adopted tariff ; None None -> no price ; ...
[('mention', 'bids@ergplan.test mentioned you in Day 4 demo tender')]
reply f5110640 by engineer@ergplan.test -> parent d69c3c1a ; thread has 3 messages
artifact financial-model-d254028a.xlsx sha256 ec646c643b45 size 28895 B | verification verified
  equity_irr: workbook 0.14002 backend 0.14002 ok | project_irr: 0.12406 / 0.12406 ok | npv_equity: 4271277597.003 / 4271277597.003 ok | min_dscr: 1.10000 / 1.10000 ok
```

## Labels and honesty

- The workbook's Dispatch sheet is a snapshot of the MILP result; a reviewer changing a capacity in Excel does not re-dispatch. The Read Me says so. Finance (capex, funding, debt, tax, returns) is fully formula-driven.
- The DSRA is a formula on year-1 debt service (months configurable); the backend models the DSRA on the same basis, and the workbook reconciliation tolerance is 0.1 % relative (absolute 0.0001 for ratios below 10 in the Checks sheet).
- The Sensitivities sheet lists the cases and their backend results; Excel data tables are not generated by `openpyxl`, so the reviewer re-runs a case by editing Inputs (the Checks sheet then shows the divergence from the stored run).
- Historical data is a research snapshot (583 of 623 records; 40 records whose source host is not on the admissible list were refused and counted). It is labelled as such in the UI and the API (`freshness.note`). Nothing is converted between units.
- `comparables()` ranks by a similarity score built from the listed reasons; it is a filter with explanations, not a tariff forecast.

## Remaining defects and blockers

- Workbook verification needs LibreOffice on the API host (`soffice` in `PATH`); without it the export still succeeds and is labelled `verification: unavailable`.
- Comments are polled every 5 s in the UI; no websocket/SSE yet.
- Seeding reads the dataset from a local checkout; there is no scheduled refresh (by design: new results arrive through the importer and are reviewed).

## Next stage

Day 6: server-authorised tool registry shared by chat and voice, versioned knowledge layer, assistant and RealTalk voice with a recorded-response fake (no key or network here), post-award DPR workspace, adversarial tests.
