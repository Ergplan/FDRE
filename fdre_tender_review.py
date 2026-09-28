"""Review drafts retain extracted evidence separately from model inputs."""
from __future__ import annotations

import hashlib
import re


def document_role(name: str, text: str) -> str:
    if re.search(r"amendment|corrigendum|addendum", name, re.I):
        return "amendment"
    heading = re.sub(r"\s+", " ", text[:700])
    return "amendment" if re.search(r"(?:amendment|corrigendum)\s*[-:]?\s*\d+\s+to", heading, re.I) else "base tender"


def attach_review(result: dict, text: str, pages: list[dict], payload: bytes) -> dict:
    role = document_role(result["source_name"], text)
    is_cfd = bool(re.search(r"contract\s+for\s+difference|\bCfD\s+(?:mechanism|settlement)", text, re.I))
    result["document_id"] = hashlib.sha256(payload).hexdigest()
    result["source_pages"] = pages
    result["rag_status"]["amendment_role"] = role
    result["compatibility"] = {
        "type": "CfD" if is_cfd else "FDRE candidate",
        "can_apply": not is_cfd and role == "base tender",
        "message": (
            "Extraction supported. CfD dispatch, weekly shortfall and market-price settlement are not implemented in the FDRE optimizer. Review only; model application is disabled."
            if is_cfd else
            "Review the amendment against its base tender; it is not a standalone project configuration."
            if role == "amendment" else
            "Review all conditions. Only explicitly approved mapped inputs can be applied; other clauses require separate model configuration."
        ),
    }
    if is_cfd:
        _cfd_review(result, pages, role)
    if role == "amendment":
        result["settings"] = {}

    sections = ["tender_schema", "overview", "technical", "constraints", "commercial", "financial", "security", "eligibility", "risk_flags", "timeline", "amendments", "cfd_terms", "settings"]
    fields = []
    for section in sections:
        rows = result.get(section, [])
        if isinstance(rows, dict):
            rows = [{"Field": key, "Value": value} for key, value in rows.items()]
        for index, row in enumerate(rows):
            label = next(iter(row.values()), section)
            source = row.get("Source", "")
            page = row.get("Page")
            if not page and (match := re.search(r"\bp\. (\d+)", source)):
                page = int(match.group(1))
            for key, value in row.items():
                if key in {"Source", "Page", "Confidence", "Field"} or key == next(iter(row)) and len(row) > 1:
                    continue
                fields.append({
                    "id": f"{section}.{index}.{key}", "section": section,
                    "label": f"{label} / {key}", "original": value,
                    "source": source, "page": page,
                    "evidence_status": "Related source; verify value" if source else "No field-level citation; verify against document",
                    "setting_key": row.get("Field") if section == "settings" else None,
                })
    result["review_fields"] = fields
    return result


def _cfd_review(result: dict, pages: list[dict], role: str):
    # These are source excerpts, not executable CfD rules or reviewed conclusions.
    patterns = [
        ("Contract duration", r"CfDAs?\s+shall\s+be\s+valid\s+for\s+a\s+period"),
        ("Daily peak supply and selection", r"choose\s+any\s+2\s+hours"),
        ("Daily energy obligation", r"mandated\s+to\s+sell\s+2000"),
        ("External green energy", r"source\s+up\s+to\s+25%"),
        ("Weekly shortfall", r"shortfall\s+beyond\s+10%"),
        ("CfD sharing slabs", r"Slab[\s-]*1"),
        ("Pool replenishment amendment", r"SECI\s+will\s+maintain\s+the\s+pool"),
        ("MCP above Rs 10 amendment", r"MCP\s+exceeds\s+Rs\.\s*10"),
    ]
    terms = []
    for label, pattern in patterns:
        for page in pages:
            flat = re.sub(r"\s+", " ", page.get("native_text", page["text"]))
            hit = re.search(pattern, flat, re.I)
            if hit:
                terms.append({"Topic": label, "Extracted text": flat[max(0, hit.start() - 80):hit.end() + 900], "Source": f"{result['source_name']}, p. {page['page']}", "Page": page["page"]})
                break
    result["cfd_terms"] = terms
    schema = result["tender_schema"]
    schema["procurement_type"] = "Contract for Difference (CfD)"
    schema["title"] = f"{'Amendment' if role == 'amendment' else 'Revised RfS'}: Contract for Difference (CfD)"
    date = re.search(r"\bDate:\s*(\d{2}\.\d{2}\.\d{4})", pages[0]["text"], re.I) if pages else None
    if date:
        schema["document_date"] = date.group(1)
    full_text = re.sub(r"\s+", " ", " ".join(page["text"] for page in pages))
    duration = re.search(r"CfDAs?\s+shall\s+be\s+valid\s+for\s+a\s+period\s+of\s+(\d+)\s+years", full_text, re.I)
    schema["ppa_years"] = int(duration.group(1)) if duration else None
    schema["storage_required"] = False if re.search(r"with\s+or\s+without\s+Energy\s+Storage", full_text, re.I) else None
    if role == "base tender" and pages:
        dates = re.findall(r"dated\s+(\d{2}\.\d{2}\.\d{4})", pages[0]["text"], re.I)
        if dates:
            schema["rfs_date"] = dates[-1]
    result["settings"] = {}
    result["constraints"] = [{"Constraint": "CfD rules", "Parsed value": "Review daily supply, weekly shortfall, market settlement and amendments. NHPC CUF/availability defaults do not apply.", "Model field": "Not implemented"}]
    result["overview"] = [{"Item": key, "Parsed detail": value if value is not None else "Not extracted"} for key, value in schema.items()]
    result["technical"] = terms
    result["commercial"] = [{"Aspect": "CfD settlement", "Model treatment": "Not implemented in the current FDRE financial model. Review source sharing slabs and amendment before modelling."}]
