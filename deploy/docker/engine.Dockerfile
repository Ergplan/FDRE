# Python engine: optimizer, finance, EYA and tender review behind FastAPI.
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app
COPY requirements.txt requirements-docling.txt ./
RUN pip install -r requirements.txt
# Docling (layout, tables and OCR for tender PDFs) with CPU-only PyTorch. Optional: if it cannot
# be installed the engine still builds and tender parsing falls back to the standard extractor.
# Off by default (only the older tender review uses it); build with INSTALL_DOCLING=true to add it.
ARG INSTALL_DOCLING=false
ENV DOCLING_ARTIFACTS_PATH=/opt/docling-models
RUN if [ "$INSTALL_DOCLING" = "true" ]; then \
      (apt-get update && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 && rm -rf /var/lib/apt/lists/*) || true; \
      (pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu \
        && pip install -r requirements-docling.txt \
        && (docling-tools models download layout tableformer rapidocr -o /opt/docling-models \
            || echo "WARNING: Docling models not downloaded; they will be fetched on first use")) \
      || echo "WARNING: Docling was not installed; tender parsing will use the standard extractor"; \
    fi
COPY . .
WORKDIR /app/react_demo
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=5 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/docs', timeout=4)"
CMD ["python", "-m", "uvicorn", "backend.api:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2", "--timeout-keep-alive", "120"]
