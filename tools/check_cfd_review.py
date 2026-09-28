"""Verify supplied CfD documents using cached extraction from the real parser run."""
import json
import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import fdre_tender_rag as rag

names = [
    "Amendment-01-SECI-CfD-I-final_upload.pdf",
    "Revised_RfS_for_1000_MWh_assured_Peak_Supply_under_CfD_Mechanism_(CfD-I).pdf",
]
for index, name in enumerate(names):
    extraction = json.loads(Path(f"/private/tmp/fdre-cfd-{index}.json").read_text())
    payload = (Path.home() / "Downloads" / name).read_bytes()
    native = []
    rag._extract_pdf_text(payload, name, native)
    for page, original in zip(extraction[1], native):
        page["native_text"] = original["text"]
    with patch.object(rag, "extract_tender_document", return_value=extraction):
        result = rag.parse_tender_document(name, payload, parser="docling")
    assert not result["compatibility"]["can_apply"]
    assert result["settings"] == {}
    assert result["tender_schema"]["procurement_mw"] == 500
    assert result["tender_schema"]["peak_supply_mwh"] == 1000
    assert len(result["source_pages"]) == (2 if index == 0 else 129)
    if index == 1:
        assert result["tender_schema"]["ppa_years"] == 12
        assert result["tender_schema"]["storage_required"] is False
        assert result["tender_schema"]["rfs_date"] == "15.07.2026"
    Path(f"/private/tmp/fdre-reviewed-{index}.json").write_text(json.dumps(result))
    print(json.dumps({"name": name, "pages": len(result["source_pages"]), "extraction": result["rag_status"]["extraction"], "schema": result["tender_schema"], "terms": [(term["Topic"], term["Page"]) for term in result["cfd_terms"]], "review_fields": len(result["review_fields"])}))
