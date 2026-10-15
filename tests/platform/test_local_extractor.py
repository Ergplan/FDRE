"""The deterministic local extractor: every hit carries page and sentence evidence; a field
with no hit is absent, never defaulted."""

from __future__ import annotations

from fdre_platform.rules import local_extractor


def test_regex_extractor_cites_page_and_sentence():
    pages = [
        {
            "page": 1,
            "text": "NHPC Limited invites bids. Request for Selection for supply of 1200 MW 'Firm and Dispatchable' power from ISTS connected RE projects coupled with energy storage system. RfS No. NHPC/CP&M/FDRE-II/2024.",
        },
        {
            "page": 2,
            "text": "The PPA shall be valid for a period of 25 (twenty five) years from the SCOD. The RE Power Developer shall ensure minimum availability of 90% of the Contracted Capacity during peak hours.",
        },
        {
            "page": 3,
            "text": "Compensation at 1.5 (one point five) times the PPA tariff shall be payable for the shortfall. The annual CUF shall be not less than 40% of the contracted capacity. The ESS shall be charged only from the renewable energy sources of the project.",
        },
    ]
    cands = {c.field_path: c for c in local_extractor.extract(pages, document_id="doc1")}
    assert cands["sector.power.common.total_capacity_mw"].value == 1200 and cands["sector.power.common.total_capacity_mw"].evidence["page"] == 1
    assert cands["sector.power.common.ppa_tenure_years"].value == 25 and cands["sector.power.common.ppa_tenure_years"].evidence["page"] == 2
    assert cands["sector.power.fdre.assured_availability_percent"].value == 90
    assert (
        cands["sector.power.fdre.shortfall_compensation_multiple"].value == 1.5
        and "1.5" in cands["sector.power.fdre.shortfall_compensation_multiple"].evidence["excerpt"]
    )
    assert cands["sector.power.fdre.demand_profile_structured.cuf_declared_min_pct"].value == 40
    assert cands["sector.power.common.bess_charging_rule.re_only"].value is True
    assert cands["core.identity.issuing_agency"].value == "NHPC Limited"
    assert "sector.power.common.tariff_ceiling_inr_per_kwh" not in cands  # not stated: not defaulted
    assert all(c.extractor == "local_regex_v1" and c.provenance == "extracted" and c.source == "local" and c.confidence == 0.6 for c in cands.values())


def test_extractor_on_the_bundled_rfs_pages():
    """The real NHPC RfS: only the first pages, so the test stays fast."""
    import pathlib

    import fitz

    pdf = pathlib.Path(__file__).resolve().parents[2] / "RFS.pdf"
    doc = fitz.open(pdf)
    pages = [{"page": i + 1, "text": doc[i].get_text()} for i in range(min(12, len(doc)))]
    cands = {c.field_path: c for c in local_extractor.extract(pages, document_id="rfs")}
    assert cands["sector.power.common.total_capacity_mw"].value == 1200
    assert cands["core.identity.issuing_agency"].value.startswith("NHPC")
    assert cands["sector.power.common.total_capacity_mw"].evidence["page"] >= 1 and cands["sector.power.common.total_capacity_mw"].evidence["excerpt"]
