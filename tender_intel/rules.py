"""Deterministic validation: range, cross-field rules and the structured-number check.

Ported from Ergplan/tender_engine core/validation/rules.py, tender/domain_packs/core/
validation.py, tender/domain_packs/core/structured.py and tender/domain_packs/power/
validation/rules.py (commit bd4959c). Plain Python, no model call. The run rule
structured_numbers_quoted is made stateless: it gets each field's coerced value and its
own quotes instead of reading them from a database.
"""

from __future__ import annotations

import math
import re
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any

from tender_intel.schema import FieldSpec, KeySpec
from tender_intel.values import NUMBER_KEY_TYPES


@dataclass(frozen=True)
class RuleOutcome:
    """Result of a cross-field rule for the fields it concerns. A failed outcome marked
    `warning` is shown to the reviewer but does not send the field to needs_review."""

    field_paths: tuple[str, ...]
    passed: bool
    message: str
    warning: bool = False


CrossFieldRule = Callable[[dict[str, Any]], list[RuleOutcome]]


# ----------------------------------------------------------------------------- field rules


def range_rule(spec: FieldSpec, value: Any) -> tuple[str, bool, str] | None:
    low, high = spec.min, spec.max
    if low is None and high is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    if low is not None and value < low:
        return ("range", False, f"{value} is below the minimum {low:g}")
    if high is not None and value > high:
        return ("range", False, f"{value} is above the maximum {high:g}")
    return ("range", True, "within range")


# ----------------------------------------------------------------------------- core pack

NIT = "core.key_dates.nit_date"
PRE_BID = "core.key_dates.pre_bid_meeting_date"
QUERIES = "core.key_dates.query_deadline"
DEADLINE = "core.key_dates.bid_submission_deadline"
OPENING = "core.key_dates.technical_opening_date"
LABELS = {
    NIT: "date of issue",
    PRE_BID: "pre-bid meeting",
    QUERIES: "last date for queries",
    DEADLINE: "bid submission deadline",
    OPENING: "technical bid opening",
}
DATE_CHAIN = (NIT, PRE_BID, DEADLINE, OPENING)
QUERY_CHAIN = (NIT, QUERIES, DEADLINE)
EMD = "core.guarantees.emd_per_mw_inr"
PBG = "core.guarantees.pbg_per_mw_inr"


def date_order(values: dict[str, Any]) -> list[RuleOutcome]:
    """Issue <= pre-bid <= bid deadline <= technical opening, and issue <= queries <= bid
    deadline, for the dates that have a value; each neighbouring pair is one outcome.
    Queries closing before the pre-bid meeting is normal and only raises a warning."""
    outcomes = []
    chains = [DATE_CHAIN, QUERY_CHAIN] if QUERIES in values else [DATE_CHAIN]
    for chain in chains:
        present = [path for path in chain if path in values]
        for earlier, later in zip(present, present[1:], strict=False):
            if chain is QUERY_CHAIN and QUERIES not in (earlier, later):
                continue
            a, b = values[earlier], values[later]
            relation = "is not after" if a <= b else "is after"
            message = f"{LABELS[earlier]} ({a}) {relation} {LABELS[later]} ({b})"
            outcomes.append(RuleOutcome((earlier, later), a <= b, message))
    if PRE_BID in values and QUERIES in values and values[QUERIES] < values[PRE_BID]:
        message = (
            f"queries close ({values[QUERIES]}) before the pre-bid meeting "
            f"({values[PRE_BID]}); usual when questions are answered at the meeting"
        )
        outcomes.append(RuleOutcome((PRE_BID, QUERIES), False, message, warning=True))
    return outcomes


def emd_pbg_within_10x(values: dict[str, Any]) -> list[RuleOutcome]:
    """EMD and PBG per MW are positive and within ten times of each other."""
    emd, pbg = values.get(EMD), values.get(PBG)
    if emd is None or pbg is None:
        return []
    if emd <= 0 or pbg <= 0:
        return [RuleOutcome((EMD, PBG), False, "EMD and PBG per MW must be positive")]
    ratio = max(emd, pbg) / min(emd, pbg)
    if ratio <= 10:
        return [RuleOutcome((EMD, PBG), True, "EMD and PBG per MW are within 10x of each other")]
    message = f"EMD per MW ({emd:,.0f}) and PBG per MW ({pbg:,.0f}) differ by more than 10x"
    return [RuleOutcome((EMD, PBG), False, message)]


# ----------------------------------------------------------------------------- structured

QUOTED_RULE = "structured_numbers_quoted"
# A limit written as a share of the declared CUF is printed as a distance from it:
# "+10% / -15%" is 110 and 85.
RELATIVE_UNIT = "percent of declared CUF"
_NUMBER = re.compile(r"\d+(?:\.\d+)?")
_SCALE = re.compile(r"(\d+(?:\.\d+)?)\s*(lakhs?|lacs?|crores?|cr\b|paisa|paise)")
_SCALES = {"lakh": 1e5, "lac": 1e5, "crore": 1e7, "cr": 1e7, "pais": 0.01}
_UNITS = {
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8,
    "nine": 9, "ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13, "fourteen": 14,
    "fifteen": 15, "sixteen": 16, "seventeen": 17, "eighteen": 18, "nineteen": 19,
}  # fmt: skip
_TENS = {
    "twenty": 20, "thirty": 30, "forty": 40, "fifty": 50, "sixty": 60, "seventy": 70,
    "eighty": 80, "ninety": 90,
}  # fmt: skip
_OTHER = {"half": 0.5, "twice": 2, "double": 2, "hundred": 100, "single": 1, "once": 1}
_WORD = re.compile(r"[a-z]+")


def numbers_in(text: str) -> set[float]:
    """Every number a passage prints: digits (separators removed), amounts in lakh, crore
    and paise also in rupees, and numbers written as words up to ninety-nine, with "and a
    half"."""
    text = re.sub(r"(?<=\d),(?=\d)", "", text.lower())
    found = {float(match) for match in _NUMBER.findall(text)}
    for amount, scale in _SCALE.findall(text):
        factor = next(value for name, value in _SCALES.items() if scale.startswith(name))
        found.add(float(amount) * factor)
    words = _WORD.findall(text.replace("-", " "))
    for position, word in enumerate(words):
        value: float | None = None
        if word in _TENS:
            following = words[position + 1] if position + 1 < len(words) else ""
            value = _TENS[word] + (
                _UNITS[following] if following in _UNITS and _UNITS[following] < 10 else 0
            )
            found.add(float(_TENS[word]))
        elif word in _UNITS:
            value = _UNITS[word]
        elif word in _OTHER:
            value = _OTHER[word]
        if value is None:
            continue
        found.add(float(value))
        if words[position + 1 : position + 4] == ["and", "a", "half"] or words[
            position + 1 : position + 3
        ] == ["and", "half"]:
            found.add(value + 0.5)
    return found


def _same(a: float, b: float) -> bool:
    return math.isclose(a, b, rel_tol=1e-9, abs_tol=1e-9)


def _numbers_of(value: Any, keys: list[KeySpec], prefix: str = "") -> list[tuple[str, float, KeySpec]]:
    """Every stated number of a record or a list of records, with the key it stands under."""
    if isinstance(value, list):
        return [
            item
            for position, record in enumerate(value, start=1)
            for item in _numbers_of(record, keys, f"{prefix}{position}.")
        ]
    numbers = []
    for key in keys:
        part = value.get(key.name)
        if part is None:
            continue
        if key.keys:
            numbers += _numbers_of(part, key.keys, f"{prefix}{key.name} ")
        elif key.type in NUMBER_KEY_TYPES and not isinstance(part, bool):
            numbers.append((f"{prefix}{key.name}", float(part), key))
    return numbers


def unquoted_numbers(value: Any, spec: FieldSpec, quotes: Sequence[str]) -> list[str]:
    """The numbers of a structured value (already in its type) that none of the quotes
    prints, each as `key value`."""
    printed: set[float] = set()
    for quote in quotes:
        printed |= numbers_in(quote)
    missing = []
    for name, number, key in _numbers_of(value, spec.keys or []):
        wanted = [number]
        if key.unit == RELATIVE_UNIT:
            wanted += [abs(number - 100)]
        if key.type == "decimal":
            # A multiple or a count of months may be printed as a percentage.
            wanted += [number * 100]
        if not any(_same(candidate, seen) for candidate in wanted for seen in printed):
            missing.append(f"{name} {number:g}")
    return missing


def structured_numbers_quoted(spec: FieldSpec, value: Any, quotes: Sequence[str]) -> RuleOutcome | None:
    """Every number of a structured value occurs in one of that field's own quotes."""
    if not spec.keys:
        return None
    missing = unquoted_numbers(value, spec, quotes)
    if missing:
        return RuleOutcome((spec.path,), False, "not printed in this field's quotes: " + ", ".join(missing))
    return RuleOutcome((spec.path,), True, "every number is printed in this field's quotes")


# (scalar field, structured field, key). For a list of records the scalar must equal the
# key of at least one item.
Pair = tuple[str, str, str]
CORE_PAIRS: tuple[Pair, ...] = (
    ("core.guarantees.emd_per_mw_inr", "core.guarantees.emd_structured", "rate_inr_per_mw"),
    ("core.guarantees.pbg_per_mw_inr", "core.guarantees.pbg_structured", "rate_inr_per_mw"),
    (
        "core.penalties.delay_ld_per_mw_per_day_inr",
        "core.penalties.delay_ld_structured",
        "rate_inr_per_mw_per_day",
    ),
)


def agreement(values: dict[str, Any], pairs: Sequence[Pair]) -> list[RuleOutcome]:
    """One outcome per pair whose structured field has a value: the scalar and the key say
    the same, or one of them is missing where the other is stated, or they differ."""
    outcomes = []
    for scalar_path, record_path, key in pairs:
        record = values.get(record_path)
        if record is None:
            continue
        scalar = values.get(scalar_path)
        items = record if isinstance(record, list) else [record]
        stated = [item[key] for item in items if item.get(key) is not None]
        name = f"`{key}` of {record_path.rsplit('.', 1)[1]}"
        label = scalar_path.rsplit(".", 1)[1]
        paths = (scalar_path, record_path)
        if scalar is None and not stated:
            continue
        if scalar is None:
            shown = ", ".join(f"{value:g}" for value in stated)
            message = f"{name} is {shown} but {label} has no value"
            if isinstance(record, list):
                continue  # a list may hold rules the scalar does not speak of
            outcomes.append(RuleOutcome((record_path,), False, message))
        elif not stated:
            message = f"{label} is {scalar:g} but {name} is not stated"
            outcomes.append(RuleOutcome((record_path,), False, message))
        elif any(_same(float(scalar), float(value)) for value in stated):
            outcomes.append(RuleOutcome(paths, True, f"{name} agrees with {label} ({scalar:g})"))
        else:
            shown = ", ".join(f"{value:g}" for value in stated)
            message = f"{name} is {shown} but {label} is {scalar:g}"
            outcomes.append(RuleOutcome(paths, False, message))
    return outcomes


def structured_agrees_with_scalar(values: dict[str, Any]) -> list[RuleOutcome]:
    return agreement(values, CORE_PAIRS)


# ----------------------------------------------------------------------------- power pack

MIN_BID = "sector.power.common.min_bid_mw"
MAX_BID = "sector.power.common.max_bid_mw"
TOTAL = "sector.power.common.total_capacity_mw"
ELEMENTS = "sector.power.transmission.elements"


def bid_capacity_order(values: dict[str, Any]) -> list[RuleOutcome]:
    """min_bid_mw <= max_bid_mw <= total_capacity_mw, for the values present."""
    chain = [
        (path, label, values[path])
        for path, label in (
            (MIN_BID, "minimum bid"),
            (MAX_BID, "maximum bid"),
            (TOTAL, "total capacity"),
        )
        if path in values
    ]
    outcomes = []
    for (path_a, label_a, a), (path_b, label_b, b) in zip(chain, chain[1:], strict=False):
        if a <= b:
            message = f"{label_a} ({a:g} MW) does not exceed {label_b} ({b:g} MW)"
        else:
            message = f"{label_a} ({a:g} MW) exceeds {label_b} ({b:g} MW)"
        outcomes.append(RuleOutcome((path_a, path_b), a <= b, message))
    return outcomes


def elements_have_kv(values: dict[str, Any]) -> list[RuleOutcome]:
    """A transmission scheme lists at least one element with a voltage."""
    elements = values.get(ELEMENTS)
    if elements is None:
        return []
    if any(str(element.get("kv") or "").strip() for element in elements):
        return [RuleOutcome((ELEMENTS,), True, "at least one element states its voltage")]
    return [RuleOutcome((ELEMENTS,), False, "no element states a voltage (kv)")]


FDRE = "sector.power.fdre"
PAIRS: tuple[Pair, ...] = (
    (
        f"{FDRE}.assured_availability_percent",
        f"{FDRE}.demand_profile_structured",
        "peak_availability_pct",
    ),
    (
        f"{FDRE}.excess_energy_price_inr_per_kwh",
        f"{FDRE}.excess_energy_structured",
        "fixed_inr_per_kwh",
    ),
    (
        f"{FDRE}.shortfall_compensation_multiple",
        "core.penalties.shortfall_rules",
        "penalty_multiple_of_tariff",
    ),
    ("sector.power.solar.min_cuf_percent", "sector.power.solar.cuf_terms", "declared_min_pct"),
    ("sector.power.wind.min_cuf_percent", "sector.power.wind.cuf_terms", "declared_min_pct"),
    (
        "sector.power.hybrid.combined_cuf_floor_percent",
        "sector.power.hybrid.cuf_terms",
        "declared_min_pct",
    ),
    (
        "sector.power.bess.availability_floor_percent",
        "core.penalties.shortfall_rules",
        "threshold_pct",
    ),
)


def power_structured_agrees_with_scalar(values: dict[str, Any]) -> list[RuleOutcome]:
    """A structured key of the power pack agrees with the scalar that holds the same fact."""
    return agreement(values, PAIRS)


CROSS_FIELD_RULES: dict[str, CrossFieldRule] = {
    "date_order": date_order,
    "emd_pbg_within_10x": emd_pbg_within_10x,
    "structured_agrees_with_scalar": structured_agrees_with_scalar,
    "bid_capacity_order": bid_capacity_order,
    "elements_have_kv": elements_have_kv,
    "power_structured_agrees_with_scalar": power_structured_agrees_with_scalar,
}
