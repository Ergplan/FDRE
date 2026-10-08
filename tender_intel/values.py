"""Value types: how a raw model value becomes a normalised, JSON-storable value.

Ported from Ergplan/tender_engine core/schemas/types.py and
tender/domain_packs/core/value_types.py (commit bd4959c). Coercion is deterministic,
plain Python, and never converts units: "5 lakh" is not a number here; the reader (model
or rules) writes plain rupees and says what the page printed. `display` (not ported) turns
a coerced value into a short human string.
"""

from __future__ import annotations

import re
from datetime import date
from typing import Any

from tender_intel.schema import FieldSpec, KeySpec

_MONTHS = {
    name: number
    for number, names in enumerate(
        [
            ("jan", "january"),
            ("feb", "february"),
            ("mar", "march"),
            ("apr", "april"),
            ("may",),
            ("jun", "june"),
            ("jul", "july"),
            ("aug", "august"),
            ("sep", "sept", "september"),
            ("oct", "october"),
            ("nov", "november"),
            ("dec", "december"),
        ],
        start=1,
    )
    for name in names
}
# Enum words shown in capitals (display only).
_ABBREVIATIONS = {
    "ists": "ISTS", "loa": "LoA", "ppa": "PPA", "cuf": "CUF", "bg": "BG", "om": "O&M", "ess": "ESS",
    "sldc": "SLDC", "rfq": "RfQ", "rfp": "RfP", "rtc": "RTC", "pct": "percent", "mw": "MW", "mwh": "MWh",
    "npv": "NPV", "otgt": "OTGT", "spv": "SPV", "inr": "INR",
}  # fmt: skip
_MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
_ISO = re.compile(r"^(\d{4})-(\d{1,2})-(\d{1,2})$")
_DMY = re.compile(r"^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$")
_D_MON_Y = re.compile(r"^(\d{1,2})(?:st|nd|rd|th)?[\s\-.,]+([a-z]+)[\s\-.,]+(\d{4})$")
_MON_D_Y = re.compile(r"^([a-z]+)[\s\-.]+(\d{1,2})(?:st|nd|rd|th)?[\s,]+(\d{4})$")
_NUMBER = re.compile(r"^-?\d+(\.\d+)?$")
# What a model or a reviewer writes for a key the document does not state.
_UNSTATED = {"", "null", "none", "not stated", "not specified", "n/a", "na", "-"}
_TIME = re.compile(r"^([01]?\d|2[0-4])[:.]?([0-5]\d)$")

# JSON kind of each type: what the model is asked to return for it.
JSON_KINDS: dict[str, str] = {
    "text": "string",
    "long_text": "string",
    "int": "integer",
    "decimal": "number",
    "date": "string",
    "bool": "boolean",
    "enum": "string",
    "list_text": "string_list",
    "money_inr": "number",
    "percent": "number",
    "duration_months": "integer",
    "mw": "number",
    "mwh": "number",
    "kv": "number",
    "km": "number",
    "time": "string",
    "record_list": "string_list",
    "record": "string_list",
}
NUMBER_KEY_TYPES = frozenset(
    {"int", "decimal", "money_inr", "percent", "duration_months", "mw", "mwh", "kv", "km"}
)


def _text(raw: Any, spec: Any) -> str:
    if not isinstance(raw, str) or not raw.strip():
        raise ValueError("expected non-empty text")
    return raw.strip()


def parse_number(raw: Any) -> float | int:
    """A number from a number or a numeric string (thousands separators allowed)."""
    if isinstance(raw, bool):
        raise ValueError("expected a number, got a boolean")
    if isinstance(raw, int | float):
        number: float | int = raw
    elif isinstance(raw, str) and _NUMBER.match(raw.replace(",", "").strip()):
        number = float(raw.replace(",", "").strip())
    else:
        raise ValueError(f"expected a number, got {raw!r}")
    return int(number) if float(number).is_integer() else float(number)


def _decimal(raw: Any, spec: Any) -> float | int:
    return parse_number(raw)


def _int(raw: Any, spec: Any) -> int:
    number = parse_number(raw)
    if not isinstance(number, int):
        raise ValueError(f"expected a whole number, got {raw!r}")
    return number


def _date(raw: Any, spec: Any) -> str:
    """Accepts ISO and the day-first forms Indian documents use. Returns YYYY-MM-DD."""
    if not isinstance(raw, str):
        raise ValueError(f"expected a date string, got {raw!r}")
    text = raw.strip().lower()
    year = month = day = 0
    if match := _ISO.match(text):
        year, month, day = (int(part) for part in match.groups())
    elif match := _DMY.match(text):
        day, month, year = (int(part) for part in match.groups())
    elif match := _D_MON_Y.match(text):
        day, year = int(match.group(1)), int(match.group(3))
        month = _MONTHS.get(match.group(2), 0)
    elif match := _MON_D_Y.match(text):
        day, year = int(match.group(2)), int(match.group(3))
        month = _MONTHS.get(match.group(1), 0)
    else:
        raise ValueError(f"unrecognised date {raw!r}")
    try:
        return date(year, month, day).isoformat()
    except ValueError as exc:
        raise ValueError(f"invalid date {raw!r}") from exc


def _bool(raw: Any, spec: Any) -> bool:
    if isinstance(raw, bool):
        return raw
    if isinstance(raw, str) and raw.strip().lower() in {"yes", "true"}:
        return True
    if isinstance(raw, str) and raw.strip().lower() in {"no", "false"}:
        return False
    raise ValueError(f"expected yes/no, got {raw!r}")


def _enum(raw: Any, spec: Any) -> str:
    if not isinstance(raw, str):
        raise ValueError(f"expected one of {spec.enum}, got {raw!r}")
    value = re.sub(r"[\s\-]+", "_", raw.strip().lower())
    if value not in (spec.enum or []):
        raise ValueError(f"expected one of {spec.enum}, got {raw!r}")
    return value


def _list_text(raw: Any, spec: Any) -> list[str]:
    if not isinstance(raw, list) or not all(isinstance(item, str) for item in raw):
        raise ValueError("expected a list of text items")
    items = [item.strip() for item in raw if item.strip()]
    if not items:
        raise ValueError("expected at least one item")
    return items


def _non_negative(raw: Any, spec: Any) -> float | int:
    number = parse_number(raw)
    if number < 0:
        raise ValueError(f"expected a non-negative number, got {raw!r}")
    return number


def _percent(raw: Any, spec: Any) -> float | int:
    number = parse_number(raw)
    if not 0 <= number <= 100:
        raise ValueError(f"expected a percentage between 0 and 100, got {raw!r}")
    return number


def _months(raw: Any, spec: Any) -> int:
    number = parse_number(raw)
    if not isinstance(number, int) or number < 0:
        raise ValueError(f"expected a whole number of months, got {raw!r}")
    return number


def _time(raw: Any, spec: Any) -> str:
    """A time of day as HH:MM (24 hours)."""
    match = _TIME.match(str(raw).strip().lower().replace(" hrs", "").replace("hrs", ""))
    if not match:
        raise ValueError(f"expected a time as HH:MM, got {raw!r}")
    return f"{int(match.group(1)):02d}:{match.group(2)}"


_SCALARS = {
    "text": _text,
    "long_text": _text,
    "int": _int,
    "decimal": _decimal,
    "date": _date,
    "bool": _bool,
    "enum": _enum,
    "list_text": _list_text,
    "money_inr": _non_negative,
    "percent": _percent,
    "duration_months": _months,
    "mw": _non_negative,
    "mwh": _non_negative,
    "kv": _non_negative,
    "km": _non_negative,
    "time": _time,
}


def _unstated(raw: Any) -> bool:
    return raw is None or (isinstance(raw, str) and raw.strip().lower() in _UNSTATED)


def _key_value(raw: Any, key: KeySpec, where: str) -> Any:
    """One key's value in its type, or None when it is not stated."""
    if _unstated(raw):
        return None
    if key.type in ("text", "long_text") and not isinstance(raw, str):
        raw = str(raw)
    coercer = _SCALARS.get(key.type)
    if coercer is None:
        raise ValueError(f"{where}`{key.name}`: unknown value type {key.type!r}")
    try:
        value = coercer(raw, key)
    except ValueError as exc:
        raise ValueError(f"{where}`{key.name}`: {exc}") from exc
    if isinstance(value, int | float) and not isinstance(value, bool):
        if key.min is not None and value < key.min:
            raise ValueError(f"{where}`{key.name}`: {value} is below {key.min}")
        if key.max is not None and value > key.max:
            raise ValueError(f"{where}`{key.name}`: {value} is above {key.max}")
    return value


def _pairs(text: str, outer: str, inner: str, what: str) -> dict[str, str]:
    """`key<inner>value<outer>key<inner>value` as a dict; keys in lower case."""
    record = {}
    for part in text.split(outer):
        if not part.strip():
            continue
        key, sep, value = part.partition(inner)
        if not sep:
            raise ValueError(f"expected {what}, got {text!r}")
        record[key.strip().lower()] = value.strip()
    return record


def _typed(record: dict[str, Any], keys: list[KeySpec], where: str = "") -> dict[str, Any]:
    """Every key of `keys`, in their order, each in its type or None. A key that is not
    among them is an error."""
    unknown = sorted(set(record) - {key.name for key in keys})
    if unknown:
        raise ValueError(f"{where}unknown key(s) {unknown}; expected {[k.name for k in keys]}")
    typed: dict[str, Any] = {}
    for key in keys:
        raw = record.get(key.name)
        if key.keys is None:
            typed[key.name] = _key_value(raw, key, where)
            continue
        items = [] if _unstated(raw) else raw
        if not isinstance(items, list):
            raise ValueError(f"{where}`{key.name}`: expected a list")
        rows = []
        for item in items:
            row = (
                item
                if isinstance(item, dict)
                else _pairs(str(item), ";", "=", "`key=value; key=value`")
            )
            row = _typed(row, key.keys, f"{where}`{key.name}`: ")
            if any(value is not None for value in row.values()):
                rows.append(row)
        typed[key.name] = rows or None
    return typed


def parse_record(raw: Any, keys: list[KeySpec]) -> dict[str, Any]:
    """A record from what the model writes (a list of `key: value` lines; a key that holds
    a list is written once per item, as `key: sub=value; sub=value`) or from a record
    itself (a reviewer's edit, a stored value)."""
    lists = {key.name for key in keys if key.keys is not None}
    if isinstance(raw, dict):
        record: dict[str, Any] = {str(key).strip().lower(): value for key, value in raw.items()}
    elif isinstance(raw, list) and all(isinstance(line, str) for line in raw):
        record = {}
        for line in raw:
            if not line.strip():
                continue
            key, sep, value = line.partition(":")
            key = key.strip().lower()
            if not sep:
                raise ValueError(f"expected `key: value`, got {line!r}")
            if key in lists:
                if not _unstated(value):
                    record.setdefault(key, []).append(value.strip())
            elif key in record:
                raise ValueError(f"`{key}` is given twice")
            else:
                record[key] = value.strip()
    else:
        raise ValueError("expected a list of `key: value` lines")
    typed = _typed(record, keys)
    if all(value is None for value in typed.values()):
        raise ValueError("no key has a value; a record nothing is stated for must be null")
    return typed


def _record(raw: Any, spec: FieldSpec) -> dict[str, Any]:
    if not spec.keys:
        raise ValueError(f"{spec.path} is a record without keys")
    return parse_record(raw, spec.keys)


def _record_list(raw: Any, spec: FieldSpec) -> list[dict[str, Any]]:
    """A list of records. The model writes each item as `key: value | key: value`; a
    reviewer's edit may send the records themselves. With typed `keys` every record has
    all of them, each in its type or None, and the first must be stated. With `item_keys`
    only, values stay text and the first item key is required."""
    if not isinstance(raw, list) or not raw:
        raise ValueError("expected a list with at least one item")
    names = [key.name for key in spec.keys] if spec.keys else (spec.item_keys or [])
    records: list[dict[str, Any]] = []
    for item in raw:
        if isinstance(item, dict):
            record = {str(key).strip(): value for key, value in item.items()}
        elif isinstance(item, str):
            record = dict(_pairs(item, "|", ":", "`key: value | key: value`"))
        else:
            raise ValueError(f"expected text items, got {item!r}")
        if spec.keys:
            typed = _typed(record, spec.keys)
            if typed[names[0]] is None:
                raise ValueError(f"every item needs `{names[0]}`")
            records.append(typed)
            continue
        record = {key: str(value).strip() for key, value in record.items()}
        record = {key: value for key, value in record.items() if value}
        unknown = sorted(set(record) - set(names))
        if unknown:
            raise ValueError(f"unknown key(s) {unknown}; expected {names}")
        if not names or names[0] not in record:
            raise ValueError(f"every item needs `{names[0] if names else 'a key'}`")
        records.append(record)
    return records


COERCERS = {**_SCALARS, "record": _record, "record_list": _record_list}


def coerce(raw: Any, spec: FieldSpec) -> Any:
    """Normalise raw to the field's type, or raise ValueError with a plain message."""
    coercer = COERCERS.get(spec.type)
    if coercer is None:
        raise ValueError(f"unknown value type {spec.type!r}")
    return coercer(raw, spec)


# ----------------------------------------------------------------------------- display


def format_number(value: float | int) -> str:
    """A number without exponent or trailing zeros."""
    if isinstance(value, bool):
        return "Yes" if value else "No"
    if float(value).is_integer():
        return str(int(value))
    return f"{float(value):.4f}".rstrip("0").rstrip(".")


def indian_grouping(value: float | int) -> str:
    """12345678 -> 1,23,45,678 (Indian digit grouping)."""
    negative = value < 0
    number = abs(value)
    whole = int(number)
    fraction = number - whole
    digits = str(whole)
    if len(digits) > 3:
        head, tail = digits[:-3], digits[-3:]
        groups = []
        while len(head) > 2:
            groups.insert(0, head[-2:])
            head = head[:-2]
        if head:
            groups.insert(0, head)
        digits = ",".join(groups) + "," + tail
    text = digits
    if fraction:
        text += f"{fraction:.2f}"[1:]
    return ("-" if negative else "") + text


def format_inr(value: float | int, unit: str | None = None) -> str:
    """₹ amount with Indian grouping, lakh or crore wording, and the per-unit tail."""
    text = f"₹{indian_grouping(value)}"
    if value >= 1e7:
        text += f" ({format_number(round(value / 1e7, 4))} crore)"
    elif value >= 1e5:
        text += f" ({format_number(round(value / 1e5, 4))} lakh)"
    tail = (unit or "").strip()
    if tail.upper().startswith("INR"):
        tail = tail[3:].strip()
    return f"{text} {tail}".strip()


def _unit_text(value: Any, unit: str | None, value_type: str) -> str:
    shown = format_number(value)
    if value_type == "percent" or (unit or "").startswith("percent"):
        rest = (unit or "").removeprefix("percent").strip()
        return f"{shown}%" + (f" {rest}" if rest else "")
    if value_type == "money_inr":
        return format_inr(value, unit)
    if value_type == "duration_months" and not unit:
        unit = "months"
    if value_type in ("mw", "mwh", "kv", "km") and not unit:
        unit = {"mw": "MW", "mwh": "MWh", "kv": "kV", "km": "km"}[value_type]
    if unit and unit.upper().startswith("INR"):
        return f"₹{shown} {unit[3:].strip()}".strip()
    return f"{shown} {unit}".strip() if unit else shown


def _scalar_display(value: Any, value_type: str, unit: str | None) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "Yes" if value else "No"
    if value_type == "date" and isinstance(value, str) and _ISO.match(value):
        year, month, day = (int(part) for part in value.split("-"))
        return f"{day} {_MONTH_NAMES[month - 1]} {year}"
    if value_type == "enum" and isinstance(value, str):
        return " ".join(_ABBREVIATIONS.get(word, word) for word in value.split("_"))
    if isinstance(value, int | float):
        return _unit_text(value, unit, value_type)
    if isinstance(value, list):
        return "; ".join(str(item) for item in value)
    return str(value)


def _record_display(value: dict[str, Any], keys: list[KeySpec] | None) -> str:
    parts = []
    specs = {key.name: key for key in keys or []}
    for name, part in value.items():
        if part is None:
            continue
        key = specs.get(name)
        if isinstance(part, list):
            subs = key.keys if key else None
            shown = ", ".join(
                "(" + _record_display(item, subs).replace("; ", ", ") + ")"
                if isinstance(item, dict)
                else str(item)
                for item in part
            )
        else:
            shown = _scalar_display(part, key.type if key else "text", key.unit if key else None)
        parts.append(f"{name}: {shown}")
    return "; ".join(parts)


def display(value: Any, spec: FieldSpec, limit: int = 240) -> str:
    """A short human string for a coerced value (or a raw one that did not coerce)."""
    if value is None:
        return ""
    if spec.type == "record" and isinstance(value, dict):
        text = _record_display(value, spec.keys)
    elif spec.type == "record_list" and isinstance(value, list):
        text = " | ".join(
            _record_display(item, spec.keys) if isinstance(item, dict) else str(item) for item in value
        )
    elif isinstance(value, list):
        text = "; ".join(str(item) for item in value)
    else:
        text = _scalar_display(value, spec.type, spec.unit)
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"
