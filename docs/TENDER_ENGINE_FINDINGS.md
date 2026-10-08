# Tender engine findings from the WBSEDCL RE-RTC RFP

Feedback for the tender_engine team (Ergplan/tender_engine at commit bd4959c), from porting the
extraction into FDRE (`tender_intel/`, Tender to Bid tab) and running it on one tender. Each
finding names the field or rule, the page that shows it, and a proposal.

| | |
| --- | --- |
| Tender | WBSEDCL RfQ/RfP for 1500 MW with 500 MW greenshoe RE-RTC power, WBSEDCL/PT&P/RE-RTC/2026/01, dated 23.09.2026 (79 pages) |
| Date | 8 October 2026 |
| Port | FDRE `tender_intel/`; packs and prompts copied unchanged; tender_engine not modified |

## How this was tested

No Anthropic API key was available in this environment, so the tender was read with FDRE's
rule-based reader. It fills tender_engine's schema with verbatim page quotes and runs
tender_engine's quote resolver, value types and validation rules. The model (LLM) reading path was
exercised only with a fake SDK.

Findings about the **schema and rules** hold in any mode. How the LLM reads this tender has
**not** been verified (see "Not yet verified").

| Fields in the fdre schema (with FDRE overlay) | Found | Located quotes | To review |
| --- | --- | --- | --- |
| 111 | 32 | 32 | 2 (EMD and PBG, F5) |

## Findings register

| # | Finding | Severity |
| --- | --- | --- |
| F1 | No field for what may be sold outside the PPA | High |
| F2 | Supply floors are not separate, measurable obligations (no monthly floor; no basis for the peak floor) | High |
| F3 | Who sets the peak hours is free text, so a model cannot act on it | High |
| F4 | A single value is not checked against its own quote | High |
| F5 | No RE-RTC terms: green share, non-RE supply with RECs, mandated solar, greenshoe, early supply | Medium |
| F6 | `emd_pbg_within_10x` fails a guarantee pair the tender states plainly (20×) | Medium |
| F7 | Two statements of the same date in one document are not compared | Medium |
| F8 | Schedule dates with no field: LoA date, PPA execution date, response to queries | Medium |
| F9 | Date type rejects two-digit years printed in the tender | Low |
| F10 | Porting notes: PyMuPDF thread safety, tool-use fallback | Low |
| OK | Working as designed: quote resolver, date-order warning | — |

## F1 · No field for what may be sold outside the PPA (High)

The tender lets the supplier schedule its mandated solar capacity in the market. The schema has
nowhere to put this, so a bid model built on the extraction either ignores market sales or makes
up its own rule. When FDRE's sizing model was allowed to sell surplus at exchange prices without
such a term, it diverted PPA energy to the exchange in evening hours.

> **WBSEDCL RfQ p. 11, cl. 1.1.2**: "The Selected Bidder shall be entitled to schedule the entire
> Solar Power capacity so developed at its discretion, towards the RE RTC PPA or in the market, in
> accordance with the applicable Grid Code, scheduling regulations and provisions of the PPA."

The tender does not say whether the PPA must be supplied before any market sale; the schema
should be able to record that as not stated rather than leave it to the model.

**Proposal.** Add `market_sale_scope` (enum: mandated solar only, any capacity, unscheduled
energy only, not allowed) and `ppa_priority_before_sale` (bool) to the power pack, with
`in the market`, `power exchange`, `third party` and `priority` among the routing keywords. FDRE
added both as overlay fields; this tender reads as mandated solar only (p. 11), priority not
stated.

## F2 · Supply floors are not separate, measurable obligations (High)

The tender sets three floors at once, each measured differently. The fdre type has one
`assured_availability_percent`, plus `cuf_declared_min_pct` and `peak_availability_pct` inside
`demand_profile_structured`. There is no monthly floor, and nothing says whether the peak floor is
measured per month or per year. A sizing model needs each floor with its measure.

> **WBSEDCL RfQ p. 10, cl. 1.1.1**: "… maintaining a Supply of minimum 80% CUF for each Accounting
> Year along with maintaining a Supply of minimum 70% CUF on monthly basis and Supply of minimum
> 90% CUF during Peak hours (Discharging 4 Hours Daily …"

**Proposal.** A `supply_floors` record list: `hours` (all, peak), `measured` (daily, monthly,
annual), `min_pct`, `of` (contracted capacity, declared CUF). FDRE added scalar overlay fields for
the annual, monthly and peak floors and the peak hours per day as a stop-gap.

## F3 · Who sets the peak hours is free text (High)

`demand_profile_structured.peak_hours_chosen_by` is a text key. Whether the tender prints the
window, the procurer decides it, or the supplier picks it changes how compliance must be checked:
when the procurer decides, a bidder can only be sure of compliance if the floor holds in any hours
the procurer may choose. A model cannot branch on free text.

> **WBSEDCL RfQ p. 10**: "Supply of minimum 90% CUF during Peak hours (Discharging 4 Hours Daily -
> single stretch of 4 hours or 4 hours in total in multiple stretches, as decided by WBSEDCL)"

**Proposal.** Make it an enum (tender, procurer, supplier). FDRE added `peak_hours_set_by` as an
overlay field; this tender reads as procurer (p. 10), and FDRE then checks the 90% floor in every
hour of the day, every month.

## F4 · A single value is not checked against its own quote (High)

tender_engine checks that each quote is found on its page, and that every number in a structured
value appears in that field's quotes (`structured_numbers_quoted`). A single value (a percentage,
an amount, a date) is not checked against its quote. A model can therefore copy a real sentence
and still return a number the sentence does not print, and the field would pass as validated.

**Proposal.** A rule that a number (digits, lakh/crore, or words) or a date (day-first forms,
month names, two-digit years) must be printed in the field's own quotes, failing to review
otherwise. FDRE added it as `value_in_quotes`; on this tender all 18 numbers and dates read pass
it.

## F5 · No RE-RTC terms (Medium)

The tender is detected as fdre (score 10.3 against 2.8 for the next type), the nearest type, but
several RE-RTC terms that drive the bid have no field:

- Minimum traceable green share, 51% each accounting year (p. 10, p. 11).
- Non-RE supply allowed with RECs, and its price: 70% of the applicable tariff is the fixed charge
  when the procurer does not schedule non-RE power (p. 15).
- Mandated solar of twice the contracted capacity, anywhere in India, with its own CTU
  interconnection (p. 11, p. 61–62).
- Greenshoe 500 MW with its own supply start date, 01-Apr-29 (p. 10, p. 61).
- Early supply bought at 50% of the PPA tariff, or sold to a third party until SSD (p. 62).

**Proposal.** An `re_rtc` type, or these fields on fdre. FDRE added green share, non-RE allowed,
solar multiple, greenshoe and supply start date as overlay fields.

## F6 · `emd_pbg_within_10x` fails a guarantee pair the tender states plainly (Medium)

Both EMD and PBG were read correctly from the Bid Information Sheet, and both were sent to review
because the PBG is 20 times the EMD. The values are what the tender prints, so the rule creates
review work for a correct reading.

> **WBSEDCL RfQ p. 5**: "Amount of ₹1,00,000/- (Indian rupees One Lakh only) per MW … Performance
> Bank Guarantee (PBG) for a value @ ₹[20,00,000]/- (Rupees Twenty Lakh only per MW)"

**Proposal.** Report the ratio as a warning rather than a failure, or widen the band from the gold
set.

## F7 · Two statements of the same date are not compared (Medium)

The Bid Information Sheet defers the pre-bid meeting to the portal, while the schedule and clause
1.4 print a date. The extract prompt says a deferral is not a value, so the model may return null
from page 5 while page 16 prints 07.10.2026. Nothing in validation compares the two.

> **WBSEDCL RfQ p. 5**: "PRE-BID MEETING To be held as per date & time mentioned on TCIL ETS portal."

> **WBSEDCL RfQ p. 16, cl. 1.3 and 1.4**: "3 Pre Bid Meeting 07.10.2026 … Date: 07.10.2026
> Time: 11.00 Hrs."

**Proposal.** Keep every statement of a field as evidence and add a run rule that flags a field
whose statements disagree (a printed date against a deferral, or two different dates).

## F8 · Schedule dates with no field (Medium)

The schedule of bidding process prints ten dated steps. The key-dates group holds issue, queries,
pre-bid, bid submission, opening and e-RA, but has no date field for the Letter of Award, PPA
execution, response to queries or the last date to obtain the document. `loa_timeline` is text and
`ppa_signing_window_days` is a count of days.

> **WBSEDCL RfQ p. 16**: "4 Response to Queries 09.10.2026 · 5 Last date for procurement of Tender
> document 14.10.2026 · 8 e-Reverse Auction 06.11.2026 · 9 Placement of LOA 20.11.2026 · 10 PPA
> execution 16.12.2026"

**Proposal.** Add `loa_date`, `ppa_execution_date` and `query_response_date`, and extend
`date_order` to them.

## F9 · Date type rejects two-digit years (Low)

The core `date` value type accepts four-digit years only. The tender prints the supply start dates
with two-digit years, so a model that copies the printed form fails coercion; the prompt's
YYYY-MM-DD instruction relies on the model expanding it.

> **WBSEDCL RfP p. 61, cl. 5.1.1**: "1. Phase 1 – Base Supply Capacity 1500 MW PPA: SSD shall be
> 01-July-28. 2. Phase 2 – Greenshoe Supply Capacity 500 MW PPA: SSD shall be 01-Apr-29."

**Proposal.** Accept a two-digit year as 20YY in the deterministic coercion and record that it was
expanded (FDRE's rule reader does this and says so in the rationale).

## F10 · Porting notes (Low)

- PyMuPDF is not thread-safe. Reading sections in parallel (one window per section) needs a lock
  around building the sub-PDFs; FDRE added a process-wide lock.
- The FDRE port keeps a tool-use fallback for SDKs without `messages.parse`, and retries it with
  `tool_choice: auto` if a forced tool choice is refused (HTTP 400). This was tested only against a
  mock; tender_engine's own path uses `messages.parse` and does not depend on it.
- Quotes that run across a line break resolve only after whitespace normalisation, which the
  resolver already does; every quote on this tender resolved as `exact`.

## Working as designed

- Quote resolver: all 32 values found have a located quote on the stated page.
- `date_order` correctly raises only a warning when queries close (05.10.2026) before the pre-bid
  meeting (07.10.2026).

## Not yet verified

- The LLM reading of this tender. Please run tender_engine on the WBSEDCL RfQ/RfP (79 pages) and
  compare with the values and pages above; it is a useful gold record for RE-RTC.
- Whether the fdre_profile prompt (v2) fills the FDRE overlay fields from their help text alone.
- Summary and long-text fields (`plain_english_summary`, `availability_shortfall_penalty`), which
  the rule reader does not attempt; both are required and missing in rules mode.

## How FDRE uses the extraction

The Tender to Bid tab builds the bid model only from fields the engine extracted with a located
quote. A term the tender does not state is shown as not stated and is not modelled; the bidder's
own inputs (costs, financing, resource profiles, market prices) are listed separately as not from
the tender. The overlay fields named above live in `tender_intel/packs/overlay.yaml` in the FDRE
repository until they can come from tender_engine.
