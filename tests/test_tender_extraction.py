import pytest

import fdre_tender_rag as rag


def test_standard_does_not_invoke_docling(monkeypatch):
    def unexpected(*args):
        pytest.fail("Standard mode invoked Docling")
    monkeypatch.setattr(rag, "_extract_docling", unexpected)
    text, pages, status = rag.extract_tender_document("tender.txt", b"Annual CUF 40%", "standard")
    assert text == "Annual CUF 40%"
    assert len(pages) == 1
    assert status["engine"] == "Standard"


@pytest.mark.parametrize("failure", [ImportError("missing"), RuntimeError("partial conversion")])
def test_fallback_is_disclosed(monkeypatch, failure):
    def fail(*args):
        raise failure
    monkeypatch.setattr(rag, "_extract_docling", fail)
    monkeypatch.setattr(rag, "extract_text_from_upload", lambda *args: ("Tender text", [{"page": 1, "text": "Tender text"}]))
    text, _, status = rag.extract_tender_document("tender.pdf", b"pdf", "docling")
    assert text == "Tender text"
    assert status["engine"] == "Standard"
    assert status["warning"]


def test_docling_page_boundaries_reach_retrieval(monkeypatch):
    monkeypatch.setattr(rag, "_extract_docling", lambda *args: (
        "First page\fSecond page", [{"page": 1}, {"page": 2}]
    ))
    text, _, status = rag.extract_tender_document("tender.pdf", b"pdf")
    chunks = rag.split_tender_chunks("tender.pdf", text)
    assert [chunk.meta["page_number"] for chunk in chunks] == [1, 2]
    assert status["engine"] == "Docling"
    assert "table" in status["warning"]


def test_empty_extraction_is_not_a_successful_tender():
    with pytest.raises(ValueError, match="No readable text"):
        rag.parse_tender_document("empty.txt", b"", parser="standard")


def test_invalid_parser_rejected():
    with pytest.raises(ValueError, match="Unknown tender parser"):
        rag.extract_tender_document("tender.txt", b"text", "unknown")


def test_markdown_clause_headings_keep_clause_reference():
    chunks = rag.split_tender_chunks("tender.pdf", "## 1.2 Peak availability\nMinimum availability is 90%.")
    assert chunks[0].meta["clause_id"] == "1.2"


def test_cfd_review_does_not_inherit_nhpc_inputs():
    text = """Contract for Difference (CfD) mechanism for 1000 MWh (500 MW x 2 Hrs.)
    The CfDAs shall be valid for a period of 12 years from the SCD.
    Projects with or without Energy Storage System.
    The RPD shall choose any 2 hours between 18:00 and 24:00.
    The RPD is mandated to sell 2000 kWh per MW daily.
    Penalty on shortfall beyond 10% in a Contract Week.
    SECI may issue amendments to this RfS.
    """
    result = rag.parse_tender_document("Revised_RfS.txt", text.encode(), parser="standard")
    assert result["compatibility"]["type"] == "CfD"
    assert not result["compatibility"]["can_apply"]
    assert result["settings"] == {}
    assert result["tender_schema"]["ppa_years"] == 12
    assert result["tender_schema"]["storage_required"] is False
    assert result["tender_schema"]["procurement_mw"] == 500
    assert result["tender_schema"]["peak_supply_mwh"] == 1000
    assert result["rag_status"]["amendment_role"] == "base tender"
    assert len(result["source_pages"]) == 1
    assert result["review_fields"]


def test_amendment_is_not_a_standalone_configuration():
    result = rag.parse_tender_document("Amendment-01.txt", b"Amendment to clause 1.9. Contract for Difference pool replenishment.", parser="standard")
    assert result["rag_status"]["amendment_role"] == "amendment"
    assert result["settings"] == {}
    assert result["tender_schema"]["ppa_years"] is None
    assert not result["compatibility"]["can_apply"]


def test_review_ids_are_bound_to_document_content():
    first = rag.parse_tender_document("a.txt", b"Annual CUF 40%.", parser="standard")
    renamed = rag.parse_tender_document("b.txt", b"Annual CUF 40%.", parser="standard")
    changed = rag.parse_tender_document("a.txt", b"Annual CUF 45%.", parser="standard")
    assert first["document_id"] == renamed["document_id"]
    assert first["document_id"] != changed["document_id"]
    assert all("original" in field for field in first["review_fields"])
