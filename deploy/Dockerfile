# FDRE enterprise platform: API (serves the built workspace) and worker share this image.
# Stage 1 builds the React workspace; stage 2 is the Python runtime with LibreOffice for the
# workbook verification and the DPR PDF export, and HiGHS through the highspy wheel.
FROM node:20-bookworm-slim AS web
WORKDIR /src/react_demo
COPY react_demo/package.json react_demo/package-lock.json ./
RUN npm ci
COPY react_demo/ ./
RUN npm run build

FROM python:3.12-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
RUN apt-get update && apt-get install -y --no-install-recommends \
        libreoffice-calc-nogui libreoffice-writer-nogui fonts-dejavu-core \
        postgresql-client curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt requirements-platform.txt ./
RUN pip install -r requirements.txt -r requirements-platform.txt
COPY . .
COPY --from=web /src/react_demo/dist ./react_demo/dist
RUN useradd --create-home --uid 1000 fdre && mkdir -p /data && chown -R fdre:fdre /app /data
USER fdre
ENV DATA_DIR=/data
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD curl -fs http://127.0.0.1:8000/api/v1/health || exit 1
CMD ["python", "-m", "uvicorn", "fdre_platform.api.app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2"]
