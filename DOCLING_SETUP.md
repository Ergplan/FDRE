# Optional Docling tender extraction

Install in the Python environment used to run the FastAPI backend:

```sh
python -m pip install -r requirements-docling.txt
```

Restart the backend, select **Automatic** or **Docling** in Tender Upload, then
upload the document. Standard mode skips Docling for fast text extraction.
Docling enables layout, table recognition and OCR for PDFs and structured DOCX
extraction. PDF page boundaries are retained for clause evidence. DOCX has no
stable physical page numbering; its extracted content uses a single logical page.

This machine has Docling installed in `.venv-docling` (Python 3.12). From
`react_demo`, start the API with:

```sh
../.venv-docling/bin/python -m uvicorn backend.api:app --host 127.0.0.1 --port 8000
```

The first PDF conversion may download Docling/OCR model weights and take longer.
Remote document-processing services are disabled; model downloads may still
require internet access. PDF conversion has a 180-second processing timeout.
Partial or failed conversions fall back to the standard extractor with a visible
warning. No-text documents are rejected rather than populated with tender defaults.

Docling improves extraction only. The existing clause retrieval and tender field
mapping remain responsible for interpretation. Review extracted conditions before
optimization: uploading a new tender does not implement unsupported tender rules.

## Docker (engine image)

The engine image installs Docling with CPU-only PyTorch and downloads its layout, table and
OCR models at build time into `/opt/docling-models` (`DOCLING_ARTIFACTS_PATH`), so tender
parsing needs no internet at runtime. The install is optional: if it fails, the image still
builds and parsing uses the standard extractor. Skip it with `INSTALL_DOCLING=false`. If the
OCR models cannot be loaded, Docling runs without OCR (layout and tables only) before falling
back to the standard extractor. The BESS Tender tab uses the same extraction.
