"""tender_intel: schema, values, resolver, rules, rules-mode and model-mode reading, jobs, API.

No network: model mode runs against a fake SDK object that answers from canned quotes
copied from RFS.pdf.
"""
from __future__ import annotations

import base64
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tender_intel import TENDER_TYPES, catalog, compile_type, read_tender  # noqa: E402
from tender_intel import extract as X  # noqa: E402
from tender_intel import jobs  # noqa: E402
from tender_intel import rules as R  # noqa: E402
from tender_intel import rules_reader  # noqa: E402
from tender_intel import values as V  # noqa: E402
from tender_intel.llm import LLMClient, load_prompt  # noqa: E402
from tender_intel.pages import read_pages  # noqa: E402
from tender_intel.resolver import Match, Miss, PageText, resolve  # noqa: E402
from tests.bess_rfs_sample import make_pdf  # noqa: E402

RFS = ROOT / "RFS.pdf"
RFP_NAME = "RFQ_RFP_Final_22_09.pdf"


def _rfp_path() -> Path | None:
    """The WBSEDCL RE-RTC RfQ/RfP is the user's own document and is not in the repo: set
    TENDER_INTEL_RFP to its path, or put it at the repo root (or the local scratch copy
    used during development is picked up)."""
    candidates = [os.environ.get("TENDER_INTEL_RFP") or "", str(ROOT / RFP_NAME)]
    candidates += sorted(glob.glob(os.path.join(tempfile.gettempdir(), "claude-*", "*", "*", "scratchpad", "rfp", RFP_NAME)))
    return next((Path(c) for c in candidates if c and Path(c).is_file()), None)


def _page(text: str, page_no: int = 1) -> PageText:
    return PageText(page_no=page_no, text=text, char_boxes=[[float(i), 0.0, float(i + 1), 10.0] for i in range(len(text))])


def _collapse(text: str) -> str:
    return " ".join(text.split())


def _by_path(result: dict) -> dict[str, dict]:
    return {f["path"]: f for section in result["sections"] for f in section["fields"]}


# ----------------------------------------------------------------------------- resolver


def test_resolver_exact_fuzzy_reordered_and_miss():
    page = _page("4.2 The bid security shall be Rs. 9,28,000 per MW of capacity offered by the Bidder.")
    exact = resolve("bid security shall be Rs. 928000 per MW", page)
    assert isinstance(exact, Match) and exact.method == "exact" and exact.bbox is not None
    assert page.text[exact.char_start : exact.char_end].startswith("bid security")

    page = _page("Before signing, the Successful Bidder shall submit the Performance Bank Guarantee to the Procurer.")
    fuzzy = resolve("the Successful Bidder shall submitt the Performance Bank Guarantee to the Procurer", page)
    assert isinstance(fuzzy, Match) and fuzzy.method == "fuzzy" and fuzzy.score >= 85

    page = _page("vi) Bid Submission Closing 12.04.2024\nDate & Time\nvii) Offline submission")
    reordered = resolve("Bid Submission Closing Date & Time 12.04.2024", page)
    assert isinstance(reordered, Match) and reordered.method == "reordered"

    miss = resolve("The ceiling tariff is Rs 3.50 per kWh for the whole term", _page("No tariff is stated on this page at all."))
    assert isinstance(miss, Miss) and miss.reason == "not_found"
    # "50 MW" is not evidence on a page that says "250 MW"
    assert isinstance(resolve("50 MW", _page("Maximum bid capacity is 250 MW.")), Miss)


# ----------------------------------------------------------------------------- schema


def test_every_type_compiles_with_unique_paths_and_registered_prompts():
    assert {"fdre", "bess", "hybrid", "solar", "wind", "transmission", "epc", "ipp", "generation"} <= set(TENDER_TYPES)
    for tender_type in TENDER_TYPES:
        schema = compile_type(tender_type)
        paths = [f.path for f in schema.fields]
        assert len(paths) == len(set(paths)), tender_type
        for section in schema.sections:
            assert schema.fields_in(section.name), (tender_type, section.name)
            prompt = load_prompt(section.prompt, section.prompt_version)
            assert prompt.text.strip()
        json.dumps(catalog(tender_type))
    assert "sector.power.common.ppa_tenure_years" not in compile_type("epc").paths  # excluded by epc.yaml


def test_fdre_and_bess_schemas():
    fdre = compile_type("fdre")
    names = [s.name for s in fdre.sections]
    assert "fdre_profile" in names and names[0] == "summary"
    assert next(s for s in fdre.sections if s.name == "fdre_profile").prompt_version == "v2"
    assert next(s for s in fdre.sections if s.name == "identity_and_scope").prompt_version == "v1"
    overlay = {f.path: f for f in fdre.fields if f.source == "fdre_overlay"}
    for path in (
        "sector.power.fdre.permitted_re_sources",
        "sector.power.fdre.biomass_permitted",
        "sector.power.fdre.annual_supply_min_pct",
        "sector.power.fdre.monthly_supply_min_pct",
        "sector.power.fdre.peak_supply_min_pct",
        "sector.power.fdre.peak_hours_per_day",
        "sector.power.fdre.green_share_min_pct",
        "sector.power.fdre.non_re_allowed",
        "sector.power.fdre.min_solar_capacity_multiple",
        "sector.power.fdre.supply_start_date",
        "sector.power.common.greenshoe_capacity_mw",
    ):
        assert path in overlay, path
    assert overlay["sector.power.fdre.permitted_re_sources"].type == "list_text"
    assert overlay["sector.power.fdre.permitted_re_sources"].section == "fdre_profile"
    assert overlay["sector.power.common.greenshoe_capacity_mw"].section == "identity_and_scope"
    assert {"date_order", "bid_capacity_order", "power_structured_agrees_with_scalar"} <= set(fdre.cross_field_rules)

    bess = compile_type("bess")
    assert "bess_performance" in [s.name for s in bess.sections]
    assert "fdre_profile" not in [s.name for s in bess.sections]
    assert "sector.power.fdre.permitted_re_sources" not in bess.paths  # overlay joins only included sections
    assert "sector.power.common.greenshoe_capacity_mw" in bess.paths
    assert bess.field("sector.power.bess.capacity_mwh").required


# ----------------------------------------------------------------------------- values


def test_value_coercion():
    fdre = compile_type("fdre")
    date_field = fdre.field("core.key_dates.bid_submission_deadline")
    assert V.coerce("05.06.2026", date_field) == "2026-06-05"
    assert V.coerce("5th June 2026", date_field) == "2026-06-05"
    with pytest.raises(ValueError):
        V.coerce("as per NIT", date_field)

    emd = fdre.field("core.guarantees.emd_per_mw_inr")
    assert V.coerce("5,00,000", emd) == 500000
    with pytest.raises(ValueError):  # coercion never converts lakh: the reader writes rupees
        V.coerce("5 lakh", emd)
    assert V.display(400000, emd) == "₹4,00,000 (4 lakh) per MW"
    assert V.display(90, fdre.field("sector.power.fdre.assured_availability_percent")) == "90%"
    assert V.display(True, fdre.field("sector.power.fdre.storage_mandatory")) == "Yes"

    structured = fdre.field("sector.power.fdre.demand_profile_structured")
    record = V.coerce(
        [
            "basis: availability_pct",
            "peak_availability_pct: 90",
            "peak_hours_per_day: 4",
            "peak_blocks: window_start=05:00; window_end=10:00; hours=2",
            "peak_blocks: window_start=18.00; window_end=23:00; hours=2",
            "cuf_band_upper_pct: 110",
        ],
        structured,
    )
    assert record["peak_availability_pct"] == 90 and record["peak_hours_per_day"] == 4
    assert record["peak_blocks"] == [
        {"window_start": "05:00", "window_end": "10:00", "hours": 2},
        {"window_start": "18:00", "window_end": "23:00", "hours": 2},
    ]
    assert record["cuf_declared_min_pct"] is None
    with pytest.raises(ValueError):
        V.coerce(["cuf_band_upper_pct: 50"], structured)  # below the key's minimum of 100

    rules_list = fdre.field("core.penalties.shortfall_rules")
    items = V.coerce(["metric: peak_availability | threshold_pct: 90 | penalty_multiple_of_tariff: 1.5"], rules_list)
    assert items[0]["metric"] == "peak_availability" and items[0]["threshold_pct"] == 90
    assert items[0]["penalty_multiple_of_tariff"] == 1.5 and items[0]["measured"] is None
    with pytest.raises(ValueError):
        V.coerce(["threshold_pct: 90"], rules_list)  # every item needs its first key


# ----------------------------------------------------------------------------- rules


def test_cross_field_and_structured_rules():
    dates = R.date_order({R.NIT: "2026-05-01", R.PRE_BID: "2026-04-10", R.DEADLINE: "2026-04-01"})
    assert any(not o.passed and not o.warning for o in dates)

    capacity = R.bid_capacity_order({R.MIN_BID: 300, R.MAX_BID: 200, R.TOTAL: 1000})
    assert [o.passed for o in capacity] == [False, True]

    fdre = compile_type("fdre")
    structured = fdre.field("sector.power.fdre.demand_profile_structured")
    value = V.coerce(["peak_availability_pct: 95", "peak_hours_per_day: 4"], structured)
    quotes = ["The declared minimum availability shall in no case be less than 90% during peak hours", "Peak hours will be four hours"]
    outcome = R.structured_numbers_quoted(structured, value, quotes)
    assert outcome is not None and not outcome.passed and "peak_availability_pct 95" in outcome.message
    good = V.coerce(["peak_availability_pct: 90", "peak_hours_per_day: 4"], structured)
    assert R.structured_numbers_quoted(structured, good, quotes).passed

    emd = R.emd_pbg_within_10x({R.EMD: 100000, R.PBG: 2000000})
    assert not emd[0].passed
    pairs = R.power_structured_agrees_with_scalar(
        {"sector.power.fdre.assured_availability_percent": 85, "sector.power.fdre.demand_profile_structured": {"peak_availability_pct": 90}}
    )
    assert pairs and not pairs[0].passed


# ----------------------------------------------------------------------------- rules mode


def _check_evidence(field: dict, pages: dict[int, PageText], expected_pages: set[int] | None = None) -> None:
    assert field["evidence"], field["path"]
    for evidence in field["evidence"]:
        assert evidence["located"], (field["path"], evidence)
        assert evidence["bbox"] is not None, field["path"]
        # verbatim: the page's own words in order (whitespace collapsed), 5 to 40 words
        assert _collapse(evidence["quote"]) in _collapse(pages[evidence["page"]].text), (field["path"], evidence)
        assert 5 <= len(evidence["quote"].split()) <= 40, (field["path"], evidence["quote"])
    if expected_pages is not None:
        assert field["evidence"][0]["page"] in expected_pages, (field["path"], field["evidence"][0]["page"])


@pytest.fixture(scope="module")
def rfs_pages():
    return {page.page_no: page for page in read_pages(RFS.name, RFS.read_bytes())}


@pytest.fixture(scope="module")
def rfs_rules(rfs_pages):
    return read_tender(RFS.name, RFS.read_bytes(), tender_type="auto", mode="rules")


def test_rules_mode_reads_rfs(rfs_rules, rfs_pages):
    result = rfs_rules
    json.dumps(result)
    assert result["engine"] == "tender_intel" and result["mode"] == "rules" and result["model"] is None
    assert result["tender_type"] == "fdre" and result["type_source"] == "auto"
    assert result["type_scores"]["fdre"] == max(result["type_scores"].values())
    assert result["document"]["pages"] == 264 and result["document"]["scanned_pages"] == []
    fields = _by_path(result)
    values = result["values"]
    expected = {
        "core.identity.tender_number": ("2024_NHPC_800202_1", {1, 17, 21}),
        "sector.power.common.total_capacity_mw": (1200, {1, 8, 9, 20, 56}),
        "sector.power.common.min_bid_mw": (50, {8, 20}),
        "sector.power.common.max_bid_mw": (600, {8, 20}),
        "sector.power.common.location_constraint": ("ists_anywhere", {1, 8, 9, 20, 22}),
        "sector.power.common.ppa_tenure_years": (25, {8, 9, 29, 34, 47, 61}),
        "sector.power.common.scod_months": (24, {16, 48}),
        "core.key_dates.bid_submission_deadline": ("2024-04-12", {22}),
        "core.key_dates.pre_bid_meeting_date": ("2024-03-28", {22}),
        "core.key_dates.nit_date": ("2024-03-15", {17, 22}),
        "sector.power.fdre.storage_mandatory": (True, {56}),
        "sector.power.fdre.assured_availability_percent": (90, {29, 61, 63, 64}),
        "sector.power.fdre.shortfall_compensation_multiple": (1.5, {35, 63}),
        "sector.power.fdre.peak_hours_per_day": (4, {29, 62}),
        "sector.power.fdre.peak_supply_min_pct": (90, {29, 61, 63, 64}),
    }
    for path, (value, pages) in expected.items():
        assert values.get(path) == value, (path, values.get(path))
        assert fields[path]["status"] == "validated", (path, fields[path]["issues"])
        _check_evidence(fields[path], rfs_pages, pages)
    assert "NHPC" in values["core.identity.issuing_agency"]
    profile = values["sector.power.fdre.demand_profile_structured"]
    assert profile["peak_availability_pct"] == 90 and profile["cuf_band_upper_pct"] == 110 and profile["cuf_band_lower_pct"] == 85
    assert [(b["window_start"], b["window_end"]) for b in profile["peak_blocks"]] == [("05:00", "10:00"), ("18:00", "23:00")]
    assert values["core.penalties.shortfall_rules"][0]["penalty_multiple_of_tariff"] == 1.5
    assert {"Solar", "Wind"} <= set(values["sector.power.fdre.permitted_re_sources"])
    # every value the rules reader gave carries located, verbatim evidence
    for field in fields.values():
        if field["value"] is not None:
            _check_evidence(field, rfs_pages)
            assert field["confidence"] in (0.4, 0.6)
    # the EMD is a per-component formula in this RfS: no single per-MW figure is claimed
    assert fields["core.guarantees.emd_per_mw_inr"]["status"] == "not_found"
    assert fields["core.eligibility.consortium_allowed"]["rationale"] == rules_reader.NOT_READ
    assert all(r["passed"] or r["warning"] for r in result["rules"])
    assert any(r["rule"] == "bid_capacity_order" and r["passed"] for r in result["rules"])
    counts = result["counts"]
    assert counts["fields"] == len(fields) and counts["validated"] >= 25 and counts["rejected"] == 0
    assert counts["found"] == counts["located"]
    assert "sector.power.fdre.availability_shortfall_penalty" in counts["required_missing"]


def test_rules_mode_reads_bess_sample(tmp_path):
    pdf = Path(make_pdf(str(tmp_path / "rfs.pdf")))
    result = read_tender("GUVNL_BESS_RfS.pdf", pdf.read_bytes(), mode="rules")
    pages = {p.page_no: p for p in read_pages("GUVNL_BESS_RfS.pdf", pdf.read_bytes())}
    assert result["tender_type"] == "bess"
    fields, values = _by_path(result), result["values"]
    expected = {
        "sector.power.bess.capacity_mw": (500, {1, 2}),
        "sector.power.bess.capacity_mwh": (1000, {1, 2}),
        "sector.power.bess.cycles_per_day": (2, {2}),
        "sector.power.bess.round_trip_efficiency_guarantee_percent": (85, {3}),
        "sector.power.bess.availability_floor_percent": (95, {3}),
        "core.guarantees.emd_per_mw_inr": (400000, {5}),
        "core.guarantees.pbg_per_mw_inr": (1000000, {5}),
        "sector.power.common.ppa_tenure_years": (12, {2}),
        "sector.power.common.scod_months": (18, {2}),
        "core.key_dates.bid_submission_deadline": ("2026-09-15", {5}),
    }
    for path, (value, expected_pages) in expected.items():
        assert values.get(path) == value, (path, values.get(path))
        assert fields[path]["status"] == "validated", (path, fields[path]["issues"])
        _check_evidence(fields[path], pages, expected_pages)
    assert "lakh" in fields["core.guarantees.emd_per_mw_inr"]["rationale"]
    assert fields["core.guarantees.emd_per_mw_inr"]["display"] == "₹4,00,000 (4 lakh) per MW"


def test_rules_mode_reads_the_wbsedcl_re_rtc_rfp():
    path = _rfp_path()
    if path is None:
        pytest.skip(f"{RFP_NAME} is not available (set TENDER_INTEL_RFP to its path)")
    payload = path.read_bytes()
    result = read_tender(path.name, payload, mode="rules")
    pages = {p.page_no: p for p in read_pages(path.name, payload)}
    assert result["tender_type"] == "fdre"
    fields, values = _by_path(result), result["values"]
    expected = {
        "core.identity.tender_number": ("WBSEDCL/PT&P/RE-RTC/2026/01", {1, 45}),
        "sector.power.common.total_capacity_mw": (1500, {1, 5, 10, 17, 45}),
        "sector.power.common.greenshoe_capacity_mw": (500, {1, 5, 10, 45}),
        "sector.power.common.location_constraint": ("ists_anywhere", {11, 48, 62}),
        "sector.power.common.ppa_tenure_years": (25, {1, 5, 10, 45}),
        "core.guarantees.emd_per_mw_inr": (100000, {5, 14, 46}),
        "core.guarantees.pbg_per_mw_inr": (2000000, {5}),
        "sector.power.fdre.biomass_permitted": (True, {9}),
        "sector.power.fdre.annual_supply_min_pct": (80, {10}),
        "sector.power.fdre.monthly_supply_min_pct": (70, {10}),
        "sector.power.fdre.peak_supply_min_pct": (90, {10}),
        "sector.power.fdre.peak_hours_per_day": (4, {10}),
        "sector.power.fdre.green_share_min_pct": (51, {10, 11}),
        "sector.power.fdre.non_re_allowed": (True, {10, 11, 15, 47}),
        "sector.power.fdre.min_solar_capacity_multiple": (2, {11, 48, 62}),
        "sector.power.fdre.supply_start_date": ("2028-07-01", {61}),
        "sector.power.common.part_capacity_allowed": (False, {12}),
        "sector.power.common.greenshoe_supply_start_date": ("2029-04-01", {10}),
        "sector.power.common.greenshoe_same_tariff": (True, {10}),
        "sector.power.common.greenshoe_offer_date": ("2027-09-30", {10}),
        "core.key_dates.era_date": ("2026-11-06", {16}),
        "core.key_dates.query_response_date": ("2026-10-09", {16}),
        "core.key_dates.document_sale_end_date": ("2026-10-14", {16}),
        "core.key_dates.loa_date": ("2026-11-20", {16}),
        "core.key_dates.ppa_execution_date": ("2026-12-16", {16}),
    }
    for field_path, (value, expected_pages) in expected.items():
        assert values.get(field_path) == value, (field_path, values.get(field_path))
        _check_evidence(fields[field_path], pages, expected_pages)
    assert "WBSEDCL" in values["core.identity.issuing_agency"]
    _check_evidence(fields["core.identity.issuing_agency"], pages, {1})
    assert {"Solar", "Wind", "Hydro", "Biomass"} <= set(values["sector.power.fdre.permitted_re_sources"])
    _check_evidence(fields["sector.power.fdre.permitted_re_sources"], pages, {9})
    assert values.get("sector.power.fdre.storage_mandatory") is not True  # storage is optional here
    # the per-MW EMD and PBG are 20x apart: the ported rule flags it for review
    assert fields["core.guarantees.pbg_per_mw_inr"]["status"] == "needs_review"
    # what may be sold outside the PPA, and who sets the peak hours, come from the tender itself
    assert values.get("sector.power.fdre.market_sale_scope") == "mandated_solar"
    _check_evidence(fields["sector.power.fdre.market_sale_scope"], pages, {11})
    assert values.get("sector.power.fdre.peak_hours_set_by") == "procurer"
    _check_evidence(fields["sector.power.fdre.peak_hours_set_by"], pages, {10})
    assert fields["sector.power.fdre.ppa_priority_before_sale"]["status"] == "not_found"  # the RFP does not say
    # the mandated solar is quoted in full, with the GW it means and where it may be built
    solar_quote = fields["sector.power.fdre.min_solar_capacity_multiple"]["evidence"][0]["quote"]
    assert "3 GW corresponding to the Base Supply Capacity" in solar_quote and "anywhere in India" in solar_quote
    # the summary is assembled only from fields read above, each quoted on its page
    summary = fields["core.summary.plain_english_summary"]
    assert summary["status"] == "validated" and all(e["located"] for e in summary["evidence"])
    for fact in ("1,500 MW", "500 MW greenshoe", "51%", "80% CUF", "3,000 MW", "no part capacity", "01.07.2028", "27.10.2026", "₹1,00,000 per MW"):
        assert fact in summary["value"], fact
    # every number and date read is printed in its own quote
    checked = [o for o in result["rules"] if o["rule"] == "value_in_quotes"]
    assert len(checked) >= 15 and all(o["passed"] for o in checked)


def test_prebid_queries_quote_the_wbsedcl_rfp_word_for_word():
    """Every RFP provision the pre-bid queries cite (web/src/bid/preBidQueries.js) is on its page."""
    path = _rfp_path()
    if path is None:
        pytest.skip(f"{RFP_NAME} is not available (set TENDER_INTEL_RFP to its path)")
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is not installed")
    script = (
        "import { PREBID_HOW, PREBID_QUERIES } from './web/src/bid/preBidQueries.js';"
        "console.log(JSON.stringify([PREBID_HOW, ...PREBID_QUERIES.flatMap((q) => q.refs)]));"
    )
    out = subprocess.run([node, "--input-type=module", "-e", script], cwd=ROOT, capture_output=True, text=True, check=True)
    refs = json.loads(out.stdout)
    pages = {p.page_no: p for p in read_pages(path.name, path.read_bytes())}
    assert len(refs) >= 11
    for ref in refs:
        assert _collapse(ref["quote"]) in _collapse(pages[ref["page"]].text), ref


# ----------------------------------------------------------------------------- model mode (fake SDK)

# (section, key) -> (value, confidence, [(document page, quote)]); copied from RFS.pdf
CANNED = {
    ("identity_and_scope", "total_capacity_mw"): (
        1200,
        0.9,
        [(8, "intends to procure Firm and Dispatchable RE power coupled with energy storage system up to capacity of 1200 MW")],
    ),
    ("identity_and_scope", "issuing_agency"): ("NHPC Limited", 0.9, [(1, "ISSUED BY: NHPC Limited")]),
    ("identity_and_scope", "min_bid_mw"): (50, 0.9, [(8, "The minimum project size will be 50 MW and in multiples of 10 MW thereafter under OPEN category.")]),
    ("identity_and_scope", "max_bid_mw"): (600, 0.9, [(8, "The cumulative capacity offered should not exceed 600 MW.")]),
    ("key_dates", "bid_submission_deadline"): ("2024-04-12", 0.95, [(22, "Online Bid Submission Closing Date & Time 12.04.2024 (17:30 Hrs.)")]),
    ("key_dates", "pre_bid_meeting_date"): ("2024-03-28", 0.95, [(22, "Pre bid meeting Date & Time 28.03.2024 (15:00 Hrs.)")]),
    # a type error: not a date
    ("key_dates", "nit_date"): ("as per NIT", 0.8, [(22, "Publishing Date & Time 15.03.2024 (18:00 Hrs.)")]),
    # a quote that is on no page: located False, confidence capped
    ("key_dates", "query_deadline"): ("2024-03-26", 0.95, [(22, "Queries shall be posted to the Chief Executive in Mumbai by registered letter only")]),
    # a value without quotes: rejected
    ("key_dates", "ppa_signing_window_days"): (30, 0.9, []),
    ("fdre_profile", "storage_mandatory"): (True, 0.9, [(56, "Energy Storage Systems (ESS) shall mandatorily constitute part of the Project.")]),
    ("fdre_profile", "assured_availability_percent"): (
        90,
        0.9,
        [(29, "The declared minimum availability shall in no case be less than 90% of contracted capacity during peak hours")],
    ),
    ("fdre_profile", "demand_profile_structured"): (
        ["basis: availability_pct", "peak_availability_pct: 90", "peak_hours_per_day: 4"],
        0.85,
        [
            (29, "The declared minimum availability shall in no case be less than 90% of contracted capacity during peak hours"),
            (29, "Peak hours will be four hours out of 24 hours on daily basis."),
        ],
    ),
}
# A quote whose page position is outside the attached pages: found by the window search.
OUT_OF_RANGE = {("identity_and_scope", "issuing_agency")}
FAKE_SECTION_MAP = [
    (1, 7, "Cover and contents", "cover_and_notice"),
    (8, 11, "Notice inviting tender", "introduction_and_scope"),
    (12, 18, "Definitions", "definitions"),
    (19, 22, "Critical date sheet", "dates_and_schedule"),
    (23, 30, "Qualification and technical criteria", "technical_requirements"),
    (31, 54, "Bidding process", "bidding_process"),
    (55, 70, "Power supply", "technical_requirements"),
    (71, 264, "Formats and draft PPA", "formats_and_annexures"),
]


class _FakeMessages:
    def __init__(self) -> None:
        self.calls: list[dict] = []
        self.positions: list[tuple[int, int]] = []  # (attached position, document page)
        self.missing: list[tuple[str, str, int]] = []

    def parse(self, *, model, max_tokens, system, messages, output_format):
        text = next(b["text"] for b in messages[0]["content"] if b["type"] == "text")
        self.calls.append({"model": model, "schema": output_format.__name__, "system": system})
        usage = SimpleNamespace(input_tokens=1000, output_tokens=200)
        if output_format.__name__ == "SectionMapOutput":
            sections = [
                {"start_page": a, "end_page": b, "heading": h, "kind": k, "confidence": 0.9} for a, b, h, k in FAKE_SECTION_MAP
            ]
            return SimpleNamespace(parsed_output=output_format.model_validate({"sections": sections}), usage=usage, stop_reason="end_turn")
        section = output_format.__name__.removeprefix("Extract_")
        if section == "documents":
            raise RuntimeError("simulated outage")
        assert any(b["type"] == "document" and b["source"]["media_type"] == "application/pdf" for b in messages[0]["content"])
        mapping = {int(doc): int(pos) for pos, doc in re.findall(r"attached page (\d+) = document page (\d+)", text)}
        answer = {}
        for key in output_format.model_fields:
            canned = CANNED.get((section, key))
            if canned is None:
                answer[key] = {"value": None, "confidence": 0, "rationale": "Not stated on these pages.", "evidence": []}
                continue
            value, confidence, quotes = canned
            evidence = []
            for page, quote in quotes:
                if (section, key) in OUT_OF_RANGE:
                    position = len(mapping) + 5
                elif page in mapping:
                    position = mapping[page]
                    self.positions.append((position, page))
                else:
                    self.missing.append((section, key, page))
                    position = 1
                evidence.append({"page_no": position, "quote": quote})
            answer[key] = {"value": value, "confidence": confidence, "rationale": "canned", "evidence": evidence}
        return SimpleNamespace(parsed_output=output_format.model_validate(answer), usage=usage, stop_reason="end_turn")


class _FakeSDK:
    def __init__(self) -> None:
        self.messages = _FakeMessages()
        self.models = SimpleNamespace(list=lambda: [SimpleNamespace(id="fake-small-1"), SimpleNamespace(id="fake-opus-large-2")])


def test_model_mode_with_fake_sdk(rfs_pages, monkeypatch):
    monkeypatch.delenv("TENDER_INTEL_MODEL", raising=False)
    monkeypatch.setenv("TENDER_INTEL_CONCURRENCY", "4")
    sdk = _FakeSDK()
    steps: list[tuple[int, int, str]] = []
    result = read_tender(RFS.name, RFS.read_bytes(), tender_type="fdre", mode="llm", progress=lambda d, t, s: steps.append((d, t, s)), sdk=sdk)
    json.dumps(result)
    assert result["mode"] == "llm" and result["type_source"] == "user"
    assert result["model"] == "fake-opus-large-2"  # picked from the listed models, never hard-coded
    assert sdk.messages.missing == []
    schema = compile_type("fdre")
    assert len(sdk.messages.calls) == 1 + len(schema.sections)
    assert {c["model"] for c in sdk.messages.calls} == {"fake-opus-large-2"}
    fdre_call = next(c for c in sdk.messages.calls if c["schema"] == "Extract_fdre_profile")
    assert fdre_call["system"].startswith(load_prompt("extract", "v1").text) and "Domain guidance" in fdre_call["system"]
    assert steps[-1][0] == steps[-1][1] == 1 + len(schema.sections)
    usage = result["usage"]
    assert usage["calls"] == 1 + len(schema.sections)
    assert usage["input_tokens"] == 1000 * len(schema.sections)  # the failed section has no usage
    assert usage["seconds"] >= 0

    fields = _by_path(result)
    deadline = fields["core.key_dates.bid_submission_deadline"]
    assert deadline["status"] == "validated" and deadline["value"] == "2024-04-12" and deadline["confidence"] == 0.95
    assert deadline["evidence"][0]["page"] == 22 and deadline["evidence"][0]["resolution"] == "stated_page"
    # attached-page positions were mapped back to document pages
    assert any(position != page for position, page in sdk.messages.positions)
    for path in ("sector.power.common.total_capacity_mw", "sector.power.fdre.storage_mandatory", "sector.power.fdre.demand_profile_structured"):
        assert fields[path]["status"] == "validated", (path, fields[path]["issues"])
        _check_evidence(fields[path], rfs_pages)
    assert fields["sector.power.common.total_capacity_mw"]["evidence"][0]["page"] == 8
    agency = fields["core.identity.issuing_agency"]
    assert agency["evidence"][0]["located"] and agency["evidence"][0]["resolution"] == "window_page" and agency["evidence"][0]["page"] == 1

    unlocated = fields["core.key_dates.query_deadline"]
    assert unlocated["status"] == "needs_review" and unlocated["confidence"] == 0.3
    assert not unlocated["evidence"][0]["located"] and unlocated["evidence"][0]["resolution"] == "unresolved"
    assert any(i["rule"] == "evidence_not_located" for i in unlocated["issues"])

    assert fields["sector.power.common.ppa_signing_window_days"]["status"] == "rejected"
    assert "sector.power.common.ppa_signing_window_days" not in result["values"]
    typed = fields["core.key_dates.nit_date"]
    assert typed["status"] == "needs_review" and any(i["rule"] == "type" for i in typed["issues"])
    assert "core.key_dates.nit_date" not in result["values"]

    for field in compile_type("fdre").fields_in("documents"):
        assert fields[field.path]["status"] == "not_found"
        assert fields[field.path]["rationale"].startswith("model call failed")
    assert any("model call failed" in w and "simulated outage" in w for w in result["warnings"])
    counts = result["counts"]
    assert counts["rejected"] == 1 and counts["needs_review"] >= 2 and counts["validated"] >= 7
    assert any(r["rule"] == "structured_numbers_quoted" and r["passed"] for r in result["rules"])


def test_model_mode_falls_back_to_rules_when_every_call_fails(tmp_path, monkeypatch):
    monkeypatch.setenv("TENDER_INTEL_MODEL", "configured-model")

    class Down:
        def parse(self, **params):
            raise ConnectionError("network unreachable")

    pdf = Path(make_pdf(str(tmp_path / "rfs.pdf")))
    result = read_tender("GUVNL_BESS_RfS.pdf", pdf.read_bytes(), mode="llm", sdk=SimpleNamespace(messages=Down()))
    assert result["mode"] == "rules" and result["model"] is None
    assert any("Every model call failed" in w for w in result["warnings"])
    assert result["values"]["sector.power.bess.capacity_mw"] == 500


def test_llm_client_falls_back_to_tool_use_without_parse(monkeypatch):
    monkeypatch.setenv("TENDER_INTEL_MODEL", "configured-model")
    sent: list[dict] = []

    class Messages:
        def create(self, **params):
            sent.append(params)
            if params["tool_choice"]["type"] == "tool":
                raise type("BadRequest", (Exception,), {"status_code": 400})("forced tool use is not supported")
            block = SimpleNamespace(type="tool_use", input={"sections": []})
            return SimpleNamespace(content=[block], usage=SimpleNamespace(input_tokens=5, output_tokens=7), stop_reason="tool_use")

    from tender_intel.section_map import SectionMapOutput

    client = LLMClient(SimpleNamespace(messages=Messages()))
    parsed, usage = client.call("section_map", "v1", [{"type": "text", "text": "pages"}], SectionMapOutput, 100)
    assert parsed.sections == [] and usage == {"input_tokens": 5, "output_tokens": 7}
    assert [p["tool_choice"]["type"] for p in sent] == ["tool", "auto"] and sent[0]["model"] == "configured-model"


def test_llm_client_with_the_real_sdk_over_a_mock_transport(monkeypatch):
    """The real SDK forms the request (no network): model picked from /v1/models, the
    registered prompt as system text, the response model as output_config.format."""
    anthropic = pytest.importorskip("anthropic")
    httpx2 = pytest.importorskip("httpx2")
    from tender_intel.section_map import SectionMapOutput

    monkeypatch.delenv("TENDER_INTEL_MODEL", raising=False)
    for tender_type in TENDER_TYPES:  # every group model's schema is accepted by the SDK
        for section in compile_type(tender_type).sections:
            anthropic.transform_schema(X._group_model(tender_type, section.name))
    sent: dict = {}

    def handler(request):
        if request.url.path.endswith("/v1/models"):
            models = [{"type": "model", "id": i, "display_name": i, "created_at": "2026-01-01T00:00:00Z"} for i in ("m-small", "m-opus-big")]
            return httpx2.Response(200, json={"data": models, "has_more": False, "first_id": "m-small", "last_id": "m-opus-big"})
        sent.update(json.loads(request.content))
        answer = {"sections": [{"start_page": 1, "end_page": 3, "heading": "Cover", "kind": "cover_and_notice", "confidence": 0.9}]}
        return httpx2.Response(
            200,
            json={
                "id": "msg_test", "type": "message", "role": "assistant", "model": sent["model"],
                "content": [{"type": "text", "text": json.dumps(answer)}],
                "stop_reason": "end_turn", "stop_sequence": None, "usage": {"input_tokens": 11, "output_tokens": 22},
            },
        )  # fmt: skip

    sdk = anthropic.Anthropic(
        api_key="test-key", max_retries=0, http_client=anthropic.DefaultHttpxClient(transport=httpx2.MockTransport(handler))
    )
    client = LLMClient(sdk)
    parsed, usage = client.call("section_map", "v1", [{"type": "text", "text": "=== page 1 ==="}], SectionMapOutput, 1000)
    assert client.model == "m-opus-big" and sent["model"] == "m-opus-big"
    assert parsed.sections[0].heading == "Cover" and usage == {"input_tokens": 11, "output_tokens": 22}
    assert sent["system"] == load_prompt("section_map", "v1").text and sent["output_config"]["format"]["type"] == "json_schema"


# ----------------------------------------------------------------------------- OpenAI provider


def test_provider_follows_the_keys(monkeypatch):
    from tender_intel import llm

    for name in ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "TENDER_INTEL_PROVIDER"):
        monkeypatch.delenv(name, raising=False)
    assert llm.provider() == "" and llm.api_key() == "" and not llm.llm_available()
    monkeypatch.setenv("OPENAI_API_KEY", "sk-openai-test")
    assert llm.provider() == "openai" and llm.api_key() == "sk-openai-test"
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test")
    assert llm.provider() == "anthropic"  # both keys: Anthropic unless told otherwise
    monkeypatch.setenv("TENDER_INTEL_PROVIDER", "openai")
    assert llm.provider() == "openai" and llm.api_key() == "sk-openai-test"
    monkeypatch.delenv("OPENAI_API_KEY")
    assert llm.api_key() == "" and not llm.llm_available()  # the named provider has no key
    monkeypatch.setenv("TENDER_INTEL_MAX_OUTPUT_TOKENS", "")
    assert llm.max_output_tokens(16000) == llm.OPENAI_MIN_OUTPUT_TOKENS
    monkeypatch.setenv("TENDER_INTEL_MAX_OUTPUT_TOKENS", "64000")
    assert llm.max_output_tokens(16000) == 64000


def test_openai_client_with_the_real_sdk_over_a_mock_transport(monkeypatch):
    """The real OpenAI SDK forms the request (no network): model picked from /v1/models,
    the registered prompt as instructions, the PDF pages as an input file and the response
    model as a strict JSON schema."""
    openai = pytest.importorskip("openai")
    httpx = pytest.importorskip("httpx")
    from openai.lib._parsing._responses import type_to_text_format_param

    from tender_intel.section_map import SectionMapOutput

    monkeypatch.delenv("TENDER_INTEL_MODEL", raising=False)
    monkeypatch.delenv("TENDER_INTEL_MAX_OUTPUT_TOKENS", raising=False)
    monkeypatch.delenv("TENDER_INTEL_REASONING_EFFORT", raising=False)
    for tender_type in TENDER_TYPES:  # every group model is a valid strict schema
        for section in compile_type(tender_type).sections:
            assert type_to_text_format_param(X._group_model(tender_type, section.name))["strict"] is True
    sent: dict = {}
    listed = ("gpt-4o", "gpt-5", "gpt-5.1", "gpt-5.1-mini", "gpt-5-2025-08-07", "text-embedding-3-large", "o3")

    def handler(request):
        if request.url.path.endswith("/models"):
            return httpx.Response(200, json={"object": "list", "data": [{"id": i, "object": "model", "created": 0, "owned_by": "x"} for i in listed]})
        sent.update(json.loads(request.content))
        answer = {"sections": [{"start_page": 1, "end_page": 3, "heading": "Cover", "kind": "cover_and_notice", "confidence": 0.9}]}
        return httpx.Response(
            200,
            json={
                "id": "resp_test", "object": "response", "created_at": 0, "status": "completed", "model": sent["model"],
                "output": [{"type": "message", "id": "msg_1", "status": "completed", "role": "assistant",
                            "content": [{"type": "output_text", "text": json.dumps(answer), "annotations": []}]}],
                "usage": {"input_tokens": 11, "output_tokens": 22, "total_tokens": 33,
                          "input_tokens_details": {"cached_tokens": 0}, "output_tokens_details": {"reasoning_tokens": 0}},
                "parallel_tool_calls": True, "tool_choice": "auto", "tools": [], "error": None, "incomplete_details": None,
                "instructions": None, "metadata": {}, "temperature": 1, "top_p": 1,
            },
        )  # fmt: skip

    sdk = openai.OpenAI(api_key="test-key", max_retries=0, http_client=openai.DefaultHttpxClient(transport=httpx.MockTransport(handler)))
    client = LLMClient(sdk, "openai")
    pdf = base64.standard_b64encode(b"%PDF-1.4 test").decode("ascii")
    blocks = [
        {"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": pdf}, "title": "rfp"},
        {"type": "text", "text": "=== page 1 ==="},
    ]
    parsed, usage = client.call("section_map", "v1", blocks, SectionMapOutput, 1000)
    assert client.model == "gpt-5.1" and sent["model"] == "gpt-5.1"  # highest plain gpt-N, never hard-coded
    assert parsed.sections[0].heading == "Cover" and usage == {"input_tokens": 11, "output_tokens": 22}
    assert sent["instructions"] == load_prompt("section_map", "v1").text
    content = sent["input"][0]["content"]
    assert content[0] == {"type": "input_file", "filename": "rfp.pdf", "file_data": f"data:application/pdf;base64,{pdf}"}
    assert content[1] == {"type": "input_text", "text": "=== page 1 ==="}
    assert sent["text"]["format"]["type"] == "json_schema" and sent["text"]["format"]["strict"] is True
    assert sent["max_output_tokens"] == 32000 and "reasoning" not in sent


class _FakeResponses:
    """OpenAI responses.parse with canned answers for the BESS sample: one honest value,
    one value its quote does not print, one quote that is not in the document and one
    value without a quote."""

    CANNED = {
        "capacity_mw": (500, "GUVNL invites bids for setting up 500 MW / 1000 MWh (2 hours) Battery Energy Storage System"),
        "capacity_mwh": (1200, "GUVNL invites bids for setting up 500 MW / 1000 MWh (2 hours) Battery Energy Storage System"),
        "emd_per_mw_inr": (400000, "EMD of Rs 4 lakh per MW payable by demand draft in favour of GUVNL"),
        "pbg_per_mw_inr": (1000000, None),
    }

    def __init__(self, pages: dict[int, PageText]) -> None:
        self.pages = pages
        self.calls: list[dict] = []

    def parse(self, *, model, instructions, input, max_output_tokens, text_format):
        content = input[0]["content"]
        self.calls.append({"model": model, "schema": text_format.__name__, "instructions": instructions, "kinds": [c["type"] for c in content]})
        usage = SimpleNamespace(input_tokens=100, output_tokens=20)
        if text_format.__name__ == "SectionMapOutput":
            return SimpleNamespace(status="completed", output=[], output_parsed=text_format.model_validate({"sections": []}), usage=usage)
        text = next(c["text"] for c in content if c["type"] == "input_text")
        position = {int(doc): int(pos) for pos, doc in re.findall(r"attached page (\d+) = document page (\d+)", text)}
        answer = {}
        for key in text_format.model_fields:
            if key not in self.CANNED:
                answer[key] = {"value": None, "confidence": 0, "rationale": "Not stated.", "evidence": []}
                continue
            value, quote = self.CANNED[key]
            evidence = []
            if quote:
                page = next((n for n, p in self.pages.items() if _collapse(quote) in _collapse(p.text)), min(position))
                evidence.append({"page_no": position.get(page, 1), "quote": quote})
            answer[key] = {"value": value, "confidence": 0.95, "rationale": "canned", "evidence": evidence}
        return SimpleNamespace(status="completed", output=[], output_parsed=text_format.model_validate(answer), usage=usage)


def test_openai_reading_keeps_every_guardrail(tmp_path, monkeypatch):
    """The OpenAI answer is a draft like any other: a value its quote does not print, a quote
    that is not in the document and a value without a quote are all caught."""
    for name in ("ANTHROPIC_API_KEY", "TENDER_INTEL_MODEL", "TENDER_INTEL_REQUIRE_LLM"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("TENDER_INTEL_PROVIDER", "openai")
    pdf = Path(make_pdf(str(tmp_path / "rfs.pdf"))).read_bytes()
    pages = {p.page_no: p for p in read_pages("GUVNL_BESS_RfS.pdf", pdf)}
    responses = _FakeResponses(pages)
    sdk = SimpleNamespace(responses=responses, models=SimpleNamespace(list=lambda: [SimpleNamespace(id="gpt-4o"), SimpleNamespace(id="gpt-5")]))
    result = read_tender("GUVNL_BESS_RfS.pdf", pdf, tender_type="bess", mode="llm", sdk=sdk)
    json.dumps(result)
    assert result["mode"] == "llm" and result["provider"] == "openai" and result["model"] == "gpt-5"
    extract_calls = [c for c in responses.calls if c["schema"] != "SectionMapOutput"]
    assert extract_calls and all(c["kinds"] == ["input_file", "input_text"] for c in extract_calls)
    assert all(c["instructions"].startswith(load_prompt("extract", "v1").text) for c in extract_calls)
    fields, values = _by_path(result), result["values"]

    honest = fields["sector.power.bess.capacity_mw"]
    assert honest["status"] == "validated" and values["sector.power.bess.capacity_mw"] == 500
    assert honest["evidence"][0]["located"]

    # needs_review values stay in result["values"] for review (as in tender_engine); the Bid
    # tab does not use them unless the user ticks them (tools/check_bid_model.mjs)
    invented = fields["sector.power.bess.capacity_mwh"]  # 1200 is not printed in its quote
    assert invented["status"] == "needs_review" and any(i["rule"] == "value_in_quotes" and not i["warning"] for i in invented["issues"])

    unlocated = fields["core.guarantees.emd_per_mw_inr"]  # the quote is not in the document
    assert unlocated["status"] == "needs_review" and unlocated["confidence"] == 0.3
    assert not unlocated["evidence"][0]["located"] and any(i["rule"] == "evidence_not_located" for i in unlocated["issues"])

    unquoted = fields["core.guarantees.pbg_per_mw_inr"]  # no quote at all
    assert unquoted["status"] == "rejected" and "core.guarantees.pbg_per_mw_inr" not in values


# ----------------------------------------------------------------------------- jobs and API


def test_jobs_store_rejects_bad_ids_and_cleans_up(tmp_path, monkeypatch):
    monkeypatch.setenv("TENDER_INTEL_JOBS_DIR", str(tmp_path))
    assert jobs.get("../../etc/passwd") is None and jobs.get("0" * 31) is None and jobs.get("0" * 32) is None
    old = tmp_path / ("a" * 32 + ".json")
    old.write_text("{}")
    os.utime(old, (time.time() - 2 * 86400, time.time() - 2 * 86400))
    assert jobs.cleanup() == 1 and not old.exists()


@pytest.fixture()
def client(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from react_demo.backend.api import app

    monkeypatch.setenv("TENDER_INTEL_JOBS_DIR", str(tmp_path / "jobs"))
    for name in ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "TENDER_INTEL_PROVIDER"):
        monkeypatch.delenv(name, raising=False)
    return TestClient(app)


def _upload(path: Path, **extra) -> dict:
    return {"file": {"name": path.name, "content_base64": base64.b64encode(path.read_bytes()).decode()}, **extra}


def test_api_status_catalog_and_read(client, tmp_path, monkeypatch):
    for prefix in ("/api/bid/tender", "/api/rtc/tender"):
        status = client.get(f"{prefix}/status").json()
        assert status == {"llm_available": False, "provider": None, "default_mode": "rules", "require_llm": False, "types": list(TENDER_TYPES)}
    cat = client.get("/api/bid/tender/catalog", params={"tender_type": "fdre"})
    assert cat.status_code == 200 and "fdre_profile" in [s["name"] for s in cat.json()["sections"]]
    assert client.get("/api/bid/tender/catalog", params={"tender_type": "nuclear"}).status_code == 422

    pdf = Path(make_pdf(str(tmp_path / "GUVNL_BESS_RfS.pdf")))
    sync = client.post("/api/bid/tender/read?sync=1", json=_upload(pdf, mode="rules"))
    assert sync.status_code == 200, sync.text
    body = sync.json()
    assert body["engine"] == "tender_intel" and body["tender_type"] == "bess" and body["mode"] == "rules"
    assert body["values"]["sector.power.bess.capacity_mwh"] == 1000

    started = client.post("/api/rtc/tender/read", json=_upload(pdf, tender_type="bess"))
    assert started.status_code == 202, started.text
    job = started.json()
    assert job["status"] == "queued" and job["mode"] == "rules" and re.fullmatch(r"[0-9a-f]{32}", job["job_id"])
    deadline = time.time() + 60
    while True:
        polled = client.get(f"/api/bid/tender/read/{job['job_id']}").json()
        if polled["status"] in ("done", "failed") or time.time() > deadline:
            break
        time.sleep(0.1)
    assert polled["status"] == "done", polled.get("error")
    assert polled["result"]["values"]["sector.power.bess.cycles_per_day"] == 2
    assert polled["progress"]["done"] == polled["progress"]["total"]

    assert client.get("/api/bid/tender/read/" + "f" * 32).status_code == 404
    assert client.get("/api/bid/tender/read/not-a-job").status_code == 404
    assert client.post("/api/bid/tender/read", json=_upload(pdf, tender_type="nuclear")).status_code == 422
    assert client.post("/api/bid/tender/read", json=_upload(pdf, mode="guess")).status_code == 422
    assert client.post("/api/bid/tender/read", json=_upload(pdf, mode="llm")).status_code == 400
    bad = {"file": {"name": "x.pdf", "content_base64": "not base64 !!"}}
    assert client.post("/api/bid/tender/read", json=bad).status_code == 400
    junk = {"file": {"name": "x.pdf", "content_base64": base64.b64encode(b"%PDF-1.4 broken").decode()}}
    assert client.post("/api/bid/tender/read?sync=1", json=junk).status_code == 400

    import react_demo.backend.tender_intel_routes as routes

    monkeypatch.setattr(routes, "MAX_UPLOAD_BYTES", 100)
    assert client.post("/api/bid/tender/read", json=_upload(pdf)).status_code == 413


def test_text_upload_is_read_in_rules_mode():
    text = (
        "Request for Selection for procurement of 250 MW Firm and Dispatchable RE power with assured peak supply.\n"
        "The minimum project size will be 50 MW. The PPA shall be for a period of 25 years from the Scheduled "
        "Commencement of Supply Date. Peak hours will be four hours out of 24 hours on daily basis.\n"
    ).encode()
    result = read_tender("notes.txt", text, mode="auto")
    assert result["mode"] == "rules" and result["tender_type"] == "fdre"
    assert result["values"]["sector.power.common.ppa_tenure_years"] == 25
    assert result["values"]["sector.power.fdre.peak_hours_per_day"] == 4
    field = _by_path(result)["sector.power.common.ppa_tenure_years"]
    assert field["evidence"][0]["located"] and field["evidence"][0]["bbox"] is None  # no boxes outside PDFs


def test_value_must_be_printed_in_its_quote():
    """FDRE guardrail: a real quote cannot carry a number or date it does not print."""
    from tender_intel.rules import dates_in, value_in_quotes
    from tender_intel.schema import compile_type

    fields = {f.path: f for f in compile_type("fdre").fields}
    cap = fields["sector.power.common.total_capacity_mw"]
    assert value_in_quotes(cap, 1200, ["Supply of 1200MW 'Firm & Dispatchable' power"]).passed
    assert not value_in_quotes(cap, 1500, ["Supply of 1200MW 'Firm & Dispatchable' power"]).passed
    emd = fields["core.guarantees.emd_per_mw_inr"]
    assert value_in_quotes(emd, 100000, ["Amount of ₹1,00,000/- (Indian rupees One Lakh only) per MW"]).passed
    deadline = fields["core.key_dates.bid_submission_deadline"]
    assert value_in_quotes(deadline, "2024-04-12", ["Online Bid Submission Closing Date & Time 12.04.2024 (17:30 Hrs.)"]).passed
    assert not value_in_quotes(deadline, "2024-04-13", ["Online Bid Submission Closing Date & Time 12.04.2024 (17:30 Hrs.)"]).passed
    assert {"2028-07-01", "2029-04-01"} <= dates_in("SSD shall be 01-July-28. … SSD shall be 01-Apr-29.")
    # text and choices are not checked by this rule
    assert value_in_quotes(fields["core.identity.issuing_agency"], "NHPC Limited", ["ISSUED BY: NHPC Limited"]) is None


def test_require_llm_never_falls_back_to_rules(monkeypatch):
    from tender_intel.extract import resolve_mode

    pdf = b"%PDF-1.4\n"
    monkeypatch.setenv("TENDER_INTEL_REQUIRE_LLM", "1")
    with pytest.raises(ValueError):
        resolve_mode("t.pdf", pdf, "auto", False)  # no key
    with pytest.raises(ValueError):
        resolve_mode("t.pdf", pdf, "rules", True)  # rules asked for
    with pytest.raises(ValueError):
        resolve_mode("t.txt", b"plain text", "auto", True)  # not a PDF
    assert resolve_mode("t.pdf", pdf, "auto", True) == "llm"
    monkeypatch.setenv("TENDER_INTEL_REQUIRE_LLM", "")
    assert resolve_mode("t.pdf", pdf, "auto", False) == "rules"
