# Tender intelligence (`tender_intel`)

Reads an Indian power tender (RfS / RfQ / RfP / NIT, PDF, DOCX or text) into typed fields,
each with the page and a verbatim quote it rests on, and checks them with deterministic rules.
It is a stateless Python package plus FastAPI endpoints; nothing is stored except short-lived
job files.

## What was ported from where

Source: `Ergplan/tender_engine`, commit `bd4959c` (read-only reference). Every ported Python
module says so in its docstring.

| `tender_intel/` | Ported from | Notes |
| --- | --- | --- |
| `packs/core/common.yaml`, `packs/core/prompts/**` | `tender/domain_packs/core/` | copied unchanged, all prompt versions |
| `packs/power/*.yaml`, `packs/power/prompts/**` | `tender/domain_packs/power/` | pack.yaml and every type file (bess, epc, fdre, generation, hybrid, ipp, solar, transmission, wind); `released/` signatures not copied |
| `prompts/extract/v1.md`, `prompts/section_map/v1.md` | `core/llm/prompts/` | copied unchanged |
| `schema.py` | `tender/services/packs.py` (`compile_type`) | simplified: no released-version checks, no document roles, no registry |
| `values.py` | `core/schemas/types.py`, `tender/domain_packs/core/value_types.py` | coercion unchanged; `display()` added |
| `resolver.py` | `core/evidence/resolver.py` | verbatim |
| `pages.py` | `core/services/parse.py` | reimplemented on pymupdf `rawdict` (text + one box per character) |
| `section_map.py` | `core/services/section_map.py` | digest, heading detection, cleaning |
| `extract.py` | `core/services/extract.py`, `core/services/validate.py` | `select_pages`, group models, instructions, quote resolution order, confidence cap 0.3, rejection without quotes; no database, one call per section |
| `rules.py` | `core/validation/rules.py`, `tender/domain_packs/core/{validation,structured}.py`, `tender/domain_packs/power/validation/rules.py` | `range`, `date_order`, `emd_pbg_within_10x`, `structured_agrees_with_scalar`, `bid_capacity_order`, `elements_have_kv`, `power_structured_agrees_with_scalar`; `structured_numbers_quoted` made stateless |
| `llm.py` | `core/llm/client.py`, `core/llm/registry.py` | prompt loading with `extends`; no call log, batches or cache |

Not from tender_engine (FDRE additions):

* `packs/overlay.yaml` — extra fields. In `fdre_profile`: `permitted_re_sources`,
  `biomass_permitted`, `annual_supply_min_pct`, `monthly_supply_min_pct`, `peak_supply_min_pct`,
  `peak_hours_per_day`, `green_share_min_pct`, `non_re_allowed`, `min_solar_capacity_multiple`,
  `supply_start_date`; in `identity_and_scope`: `sector.power.common.greenshoe_capacity_mw`. An
  overlay field joins its section in every tender type that includes the section (so the
  `fdre_profile` ones apply to `fdre` only). The catalog marks them `"source": "fdre_overlay"`.
* `rules_reader.py` — rules mode (below).
* `jobs.py` — file-backed jobs.

## Modes

**llm** (a model reads the PDF pages). Used when `mode=llm`, or `mode=auto` with
`ANTHROPIC_API_KEY` set, and the file is a PDF.

1. Section map: one call over a digest of every page (first 400 characters and heading-like
   lines) returns the document's sections with a kind.
2. For each section of the tender type: pick at most 40 pages (mapped sections whose kind or
   heading the section's hints name, plus up to 12 keyword pages; keyword pages alone when no
   mapped section matches; the first 40 pages when nothing matches), cut them into a sub-PDF
   and send it as a document block with the field list and the page mapping
   ("attached page 3 = document page 22"). The system prompt is the section's prompt version
   (its pinned `prompt_version`, else v1), which extends `extract/v1`. Sections run concurrently
   (`TENDER_INTEL_CONCURRENCY`, default 4). A section whose call fails leaves its fields
   `not_found` ("model call failed: …") and adds a warning; the run completes.

**rules** (no model). Used without a key, for DOCX/text uploads, or with `mode=rules`.
Deterministic extractors fill the headline fields: identity (tender number, issuer, title,
type as stated), key dates (issue, queries, pre-bid, bid deadline, technical opening), EMD and
PBG when stated per MW, capacity (total MW/MWh, greenshoe, min/max bid), location, PPA tenure,
SCOD months and reference, ceiling tariff (₹/kWh), the FDRE profile (availability, demand
profile, peak hours and windows, storage mandatory, shortfall multiple, permitted sources,
biomass, annual/monthly/peak supply floors, green share, non-RE allowed, solar multiple,
supply start date, the structured demand profile), one shortfall rule, and the BESS
performance figures. Each value comes with a verbatim quote: the page's own words in order with
whitespace collapsed, 5 to 40 words, at a sentence or table-line boundary, always containing
the value. Confidence is 0.6 (0.4 when the document prints conflicting values, which the
rationale names). Worked examples and illustrations ("e.g.", "for example", "assuming") are
skipped. Every other field is `not_found` with "Not read in rules mode; set
ANTHROPIC_API_KEY for the full reading."

**Both modes** then run the same checks: each quote is looked up on its stated page, the
neighbouring pages, the rest of the section's pages, then across a page break (resolver
threshold 85); a value with no quote is `rejected`; a value whose quotes are all unlocated has
its confidence capped at 0.3; the value is coerced to its type (a failure is a `type` issue);
then the range rule, the type's cross-field rules and `structured_numbers_quoted` (every number
of a structured value must be printed in that field's own quotes). Status: `validated` (value
coerced, at least one quote located, no failed non-warning rule), `needs_review`,
`not_found`, `rejected`.

The tender type is detected by weighted keyword counts (FDRE: firm and dispatchable, FDRE,
assured peak, demand fulfilment ratio, round the clock / RTC, peak hours; BESS: battery energy
storage, BESS, standalone, MWh, charging; hybrid; solar; wind; transmission; EPC; generation and
IPP as weak fallbacks); the default is `fdre`. A user-chosen type overrides it.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | (unset) | enables llm mode |
| `TENDER_INTEL_MODEL` | (unset) | model id to use; when unset the engine lists the models the key can use once per process and takes the first whose id contains "opus", else the first listed. No model id is written in the code. |
| `TENDER_INTEL_CONCURRENCY` | 4 | sections read in parallel |
| `TENDER_INTEL_TIMEOUT_SECONDS` | 300 | per-request timeout (the SDK retries 3 times) |
| `TENDER_INTEL_JOBS_DIR` | `/tmp/tender_intel_jobs` | job files (shared by the engine's two uvicorn workers) |

`docker-compose.yml` passes `ANTHROPIC_API_KEY` and `TENDER_INTEL_MODEL` to the engine. For a
first install they can be set in `.env` (see `.env.example`); on a running server use the update
below, because `deploy/update.sh` does not read `.env`.

### Setting the key on the server

`deploy/update.sh` reads the deployment's settings from the running containers (not from `.env`),
so give the key to one update run; later updates keep the running engine's key.

```
cd ~/fdre
read -rs ANTHROPIC_API_KEY      # paste the key, press Enter (not echoed, not in shell history)
export ANTHROPIC_API_KEY
bash deploy/update.sh           # rebuilds and restarts with the key; later runs keep it
unset ANTHROPIC_API_KEY
```

Check: the update prints "tender reading: model (key set)", and on the Tender to Bid tab the
Tender step's "Reading" option shows "Full reading (language model)". To pin a model, export
`TENDER_INTEL_MODEL` the same way. To remove the key: `ANTHROPIC_API_KEY=none bash deploy/update.sh`.
Never commit the key; `.env` is ignored by git.

## API

The same handlers are mounted under `/api/bid/tender` and `/api/rtc/tender`
(`react_demo/backend/tender_intel_routes.py`, included in `api.py` before the SPA catch-all).

| Method and path | Result |
| --- | --- |
| `GET …/status` | `{"llm_available", "default_mode": "llm"\|"rules", "types": [...]}` |
| `GET …/catalog?tender_type=fdre` | sections with their fields (path, key, label, type, unit, required, help, enum, min, max, keys, item_keys, source); 422 for an unknown type |
| `POST …/read` body `{"file": {"name", "content_base64"}, "tender_type": "auto", "mode": "auto"\|"llm"\|"rules"}` | 202 `{"job_id", "status": "queued", "mode"}`; with `?sync=1` the result itself. 400 undecodable or unreadable file, 413 over 60 MB, 422 unknown type or mode, 400 `mode=llm` without a key |
| `GET …/read/{job_id}` | `{"job_id", "status": "queued"\|"running"\|"done"\|"failed", "progress": {"done", "total", "step"}, "error", "result", "created_at", "updated_at", …}`; 404 unknown |

Result:

```
{
  "engine": "tender_intel", "mode": "llm"|"rules", "model": str|null,
  "document": {"name", "pages", "sha256", "text_pages", "scanned_pages": [int]},
  "tender_type": str, "type_source": "auto"|"user", "type_scores": {type: number},
  "sections": [{"name", "label", "fields": [Field]}],
  "values": {path: coerced value},      // validated or needs_review fields with a coerced value
  "rules": [{"rule", "fields": [path], "passed", "message", "warning"}],
  "counts": {"fields", "found", "located", "validated", "needs_review", "not_found", "rejected", "required_missing": [path]},
  "usage": {"calls", "input_tokens", "output_tokens", "seconds"},
  "warnings": [str]
}
Field = {"path", "key", "label", "type", "unit", "required", "help", "enum", "value", "display",
         "confidence", "status", "rationale",
         "evidence": [{"page", "quote", "located", "method", "score", "resolution", "bbox": [x0, y0, x1, y1]|null}],
         "issues": [{"rule", "message", "warning"}]}
```

`bbox` is in PDF points (origin top-left, as pymupdf reports it); it is null for DOCX/text and
for unlocated quotes. Money values are plain rupees (`display` adds ₹, Indian grouping and
lakh/crore wording); records display as `key: value; …`.

## Limitations

* Rules mode reads the headline fields only, by pattern; unusual wording is missed (reported
  `not_found`) and a value printed differently in two places gets confidence 0.4. It does not
  read scanned pages (no text layer); llm mode sends the page images, but evidence on scanned
  pages cannot be located.
* One model call per section caps the pages a section sees at 40; a clause outside the chosen
  pages is not read. Sub-PDFs over 20 MB are cut to fewer pages (with a warning).
* Structured-output schemas are compiled per section by the API on first use; a schema the API
  refuses fails that section only (warning).
* Jobs live in the worker process that started them; a job whose worker restarts is reported
  `failed` after an hour without progress. Job files are deleted after 24 hours.
* No corrigendum handling, review workflow or storage of approved values (tender_engine's
  versioning, approvals and audit log were not ported).
* `emd_pbg_within_10x` is ported as is: a tender whose PBG is more than ten times its EMD per MW
  (for example ₹1 lakh and ₹20 lakh) is flagged for review.
