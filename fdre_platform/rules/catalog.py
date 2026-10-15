"""The requirement catalogue: every tender requirement the platform tracks, keyed by the
field paths tender_engine uses (core.*, sector.power.*) plus a few platform-only paths
(platform.*). Each entry says how the requirement maps to an engine input (if at all),
which executable rule it feeds, and whether an approved change may update draft inputs
automatically (unambiguous scalar mappings only; interpretations stay manual)."""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class FieldDef:
    path: str
    label: str
    section: str                  # review section
    value_type: str               # text, long_text, decimal, int, percent, bool, date, enum, record, record_list
    unit: str | None = None
    required: bool = False
    summary_group: str = "other"  # which summary block it feeds
    input_path: str | None = None # dotted path into the scenario inputs (project.tender.x / settings.x)
    transform: str | None = None  # percent_to_fraction, identity
    auto_apply: bool = False
    rule_type: str | None = None  # executable rule it feeds
    constraint: str | None = None # engine constraint name, for impact mapping
    enum: tuple[str, ...] = field(default_factory=tuple)


F = FieldDef
FIELDS: tuple[FieldDef, ...] = (
    # Identity
    F("core.identity.issuing_agency", "Issuing agency / procurer", "identity", "text", required=True, summary_group="identity"),
    F("core.identity.tender_number", "Tender / RfS number", "identity", "text", summary_group="identity"),
    F("core.identity.title", "Title", "identity", "text", summary_group="identity"),
    F("core.identity.tender_type_as_stated", "Tender family as stated", "identity", "text", summary_group="identity"),
    F("sector.power.common.total_capacity_mw", "Bid capacity procured", "identity", "decimal", "MW", required=True, summary_group="identity", input_path="settings.tenderProcurementMw", auto_apply=True, constraint="procurement_quantum"),
    F("sector.power.common.min_bid_mw", "Minimum bid / project size", "identity", "decimal", "MW", summary_group="identity", input_path="project.tender.min_project_mw", auto_apply=True, rule_type="capacity_bounds", constraint="capacity_bounds"),
    F("sector.power.common.max_bid_mw", "Maximum capacity per bidder", "identity", "decimal", "MW", summary_group="identity", input_path="project.tender.max_bidder_capacity_mw", auto_apply=True, rule_type="capacity_bounds", constraint="capacity_bounds"),
    F("platform.capacity.bid_multiple_mw", "Bid capacity multiple", "identity", "decimal", "MW", summary_group="identity", input_path="project.tender.project_mw_multiple", auto_apply=True, rule_type="capacity_bounds", constraint="capacity_bounds"),
    # Locations, dates, eligibility, submission
    F("sector.power.common.location_constraint", "Location constraint", "locations_dates", "text", summary_group="locations_dates"),
    F("sector.power.common.delivery_point", "Delivery point", "locations_dates", "text", summary_group="locations_dates"),
    F("sector.power.common.metering_point", "Metering point", "locations_dates", "text", summary_group="locations_dates"),
    F("core.key_dates.pre_bid_meeting_date", "Pre-bid meeting", "locations_dates", "date", summary_group="locations_dates"),
    F("core.key_dates.bid_submission_deadline", "Bid submission deadline", "locations_dates", "date", required=True, summary_group="locations_dates"),
    F("core.key_dates.technical_opening_date", "Technical bid opening", "locations_dates", "date", summary_group="locations_dates"),
    F("core.key_dates.era_date", "e-Reverse auction", "locations_dates", "date", summary_group="locations_dates"),
    F("core.key_dates.bid_validity", "Bid validity", "locations_dates", "int", "days", summary_group="locations_dates"),
    F("core.eligibility.net_worth_per_mw_inr", "Net worth requirement", "eligibility", "decimal", "INR per MW", summary_group="locations_dates"),
    F("core.eligibility.turnover_requirement_inr", "Turnover requirement", "eligibility", "decimal", "INR", summary_group="locations_dates"),
    F("core.eligibility.consortium_allowed", "Consortium allowed", "eligibility", "bool", summary_group="locations_dates"),
    F("core.documents.required_documents", "Submission requirements", "eligibility", "long_text", summary_group="locations_dates"),
    # Contract duration and delivery obligations
    F("sector.power.common.ppa_tenure_years", "Contract (PPA) duration", "contract", "int", "years", required=True, summary_group="contract", input_path="project.tender.ppa_years", auto_apply=True, rule_type="ppa_term", constraint="ppa_term"),
    F("sector.power.common.scod_months", "Scheduled commissioning", "contract", "int", "months", summary_group="contract"),
    F("sector.power.common.scod_reference", "Commissioning reference", "contract", "text", summary_group="contract"),
    F("sector.power.common.financial_closure_months", "Financial closure", "contract", "int", "months", summary_group="contract"),
    F("sector.power.common.ppa_signing_window_days", "PPA signing window", "contract", "int", "days", summary_group="contract"),
    F("core.commercial.offtaker", "Offtaker / buying entity", "contract", "text", summary_group="contract"),
    # Scheduling, energy, availability, RE requirements
    F("sector.power.fdre.demand_profile", "Supply / demand profile", "delivery", "long_text", required=True, summary_group="delivery"),
    F("sector.power.fdre.peak_window_definition", "Peak window definition", "delivery", "text", summary_group="delivery", rule_type="peak_window", constraint="peak_windows"),
    F("sector.power.fdre.assured_availability_percent", "Peak availability floor", "delivery", "percent", "percent of contracted capacity", required=True, summary_group="delivery", input_path="project.tender.peak_availability_floor", transform="percent_to_fraction", auto_apply=True, rule_type="peak_availability", constraint="peak_availability"),
    F("sector.power.fdre.demand_profile_structured.peak_hours_per_day", "Peak hours per day", "delivery", "decimal", "hours per day", summary_group="delivery", rule_type="peak_window", constraint="peak_windows"),
    F("sector.power.fdre.demand_profile_structured.cuf_declared_min_pct", "Lowest declarable annual CUF", "delivery", "percent", "percent", required=True, summary_group="delivery", input_path="project.tender.declared_annual_cuf", transform="percent_to_fraction", auto_apply=False, rule_type="cuf_band", constraint="annual_cuf"),
    F("sector.power.fdre.demand_profile_structured.cuf_band_lower_pct", "CUF lower limit", "delivery", "decimal", "percent of declared CUF", summary_group="delivery", input_path="project.tender.cuf_lower_tolerance", transform="band_lower_to_tolerance", auto_apply=True, rule_type="cuf_band", constraint="annual_cuf"),
    F("sector.power.fdre.demand_profile_structured.cuf_band_upper_pct", "CUF upper limit", "delivery", "decimal", "percent of declared CUF", summary_group="delivery", input_path="project.tender.cuf_upper_multiplier", transform="band_upper_to_multiplier", auto_apply=True, rule_type="cuf_band", constraint="annual_cuf"),
    F("sector.power.fdre.demand_profile_structured.re_share_min_pct", "Minimum RE share", "delivery", "percent", "percent of annual energy", summary_group="delivery", rule_type="re_share"),
    F("sector.power.fdre.demand_profile_structured.external_sourcing_max_pct", "External sourcing allowance", "delivery", "percent", "percent of annual energy", summary_group="market", input_path="project.tender.external_green_limit_fraction", transform="percent_to_fraction", auto_apply=True, rule_type="external_sourcing", constraint="external_green"),
    # Storage obligations and charging sources
    F("sector.power.fdre.storage_mandatory", "Storage mandatory", "storage", "bool", summary_group="storage", rule_type="storage_obligation"),
    F("sector.power.common.bess_charging_rule.re_only", "Storage charged from RE only", "storage", "bool", summary_group="storage", rule_type="charging_source", constraint="charging_source"),
    F("sector.power.common.bess_charging_rule.co_located_required", "Storage must be co-located", "storage", "bool", summary_group="storage", rule_type="charging_source"),
    F("sector.power.common.source_mix_rules", "Supply source rules", "storage", "record_list", summary_group="storage", rule_type="source_eligibility"),
    # Market purchases/sales, penalties, securities, commercial terms
    F("sector.power.fdre.excess_energy_structured.price_basis", "Excess energy treatment", "commercial", "enum", summary_group="market", rule_type="excess_energy", enum=("ppa_tariff", "pct_of_tariff", "fixed", "not_purchased")),
    F("sector.power.fdre.excess_energy_price_inr_per_kwh", "Excess energy price", "commercial", "decimal", "INR per kWh", summary_group="market", rule_type="excess_energy"),
    F("platform.market.merchant_sale_allowed", "Third-party / exchange sale of surplus allowed", "commercial", "bool", summary_group="market", rule_type="merchant_sales"),
    F("sector.power.fdre.shortfall_compensation_multiple", "Shortfall compensation multiple", "commercial", "decimal", "x tariff", required=True, summary_group="penalties", input_path="project.tender.penalty_multiplier", auto_apply=True, rule_type="penalty", constraint="penalty"),
    F("sector.power.fdre.availability_shortfall_penalty", "Availability shortfall penalty (clause)", "commercial", "long_text", summary_group="penalties", rule_type="penalty"),
    F("core.penalties.delay_ld_per_mw_per_day_inr", "Commissioning delay LD", "commercial", "decimal", "INR per MW per day", summary_group="penalties"),
    F("sector.power.common.tariff_ceiling_inr_per_kwh", "Ceiling tariff", "commercial", "decimal", "INR per kWh", summary_group="commercial", rule_type="tariff_ceiling", constraint="tariff_ceiling"),
    F("core.commercial.payment_security_mechanism", "Payment security", "commercial", "long_text", summary_group="commercial"),
    F("platform.commercial.psm_charge_inr_per_kwh", "PSM / trading charge deducted", "commercial", "decimal", "INR per kWh", summary_group="commercial", input_path="project.tender.psm_charge_rs_per_kwh", auto_apply=True, constraint="psm_charge"),
    F("core.guarantees.emd_per_mw_inr", "Earnest money deposit", "commercial", "decimal", "INR per MW", summary_group="securities"),
    F("core.guarantees.pbg_per_mw_inr", "Performance bank guarantee", "commercial", "decimal", "INR per MW", summary_group="securities"),
    F("core.guarantees.success_charge_inr", "Success charge", "commercial", "decimal", "INR per MW", summary_group="securities"),
    F("core.guarantees.processing_fee_inr", "Processing fee", "commercial", "decimal", "INR", summary_group="securities"),
    F("core.commercial.change_in_law_clause", "Change in law", "commercial", "long_text", summary_group="commercial"),
)

BY_PATH: dict[str, FieldDef] = {f.path: f for f in FIELDS}
SECTIONS = ("identity", "locations_dates", "eligibility", "contract", "delivery", "storage", "commercial")
SUMMARY_GROUPS = (
    ("identity", "Procurer, tender family and bid capacity"),
    ("locations_dates", "Locations, dates, eligibility and submission"),
    ("contract", "Contract duration and delivery obligations"),
    ("delivery", "Scheduling, energy, availability and renewable requirements"),
    ("storage", "Storage obligations and permitted charging sources"),
    ("market", "Market purchases and sales"),
    ("penalties", "Penalties"),
    ("securities", "Securities"),
    ("commercial", "Commercial terms"),
)
PROVENANCES = ("extracted", "inferred", "defaulted", "user_entered")
REVIEW_STATES = ("unreviewed", "accepted", "corrected", "rejected", "conflicted")


def field_def(path: str) -> FieldDef:
    try:
        return BY_PATH[path]
    except KeyError as exc:
        raise KeyError(f"unknown requirement field {path}") from exc


def to_input_value(fdef: FieldDef, value):
    """Convert a requirement value into the engine input's unit."""
    if value is None:
        return None
    if fdef.transform == "percent_to_fraction":
        return float(value) / 100.0
    if fdef.transform == "band_lower_to_tolerance":      # 85 (% of declared) -> 0.15
        return round(1.0 - float(value) / 100.0, 6)
    if fdef.transform == "band_upper_to_multiplier":     # 110 (% of declared) -> 1.10
        return round(float(value) / 100.0, 6)
    if fdef.value_type in ("decimal", "percent"):
        return float(value)
    if fdef.value_type == "int":
        return int(value)
    return value
