# Known limitations (release candidate, 2026-10-15)

What the seven-day build does not do, or does with a stated simplification. Nothing here
is hidden in the product: every item is labelled where it appears.

## Not exercised in this build environment (configuration, not code, is missing)

| Area | Limitation | Where it shows |
|---|---|---|
| Docker | No daemon in the build container: `deploy/Dockerfile` and `deploy/docker-compose.staging.yml` are written and reviewed, the image build and compose bring-up are untested. Processes were run directly (`tools/restart_dev.sh`). | `docs/platform/OPERATIONS.md` |
| tender_engine extraction | The deployed instance is unreachable from the container and no `ANTHROPIC_API_KEY` is present. A local tender_engine was run for the HTTP contract; extraction fell back to the local regex extractor or the recorded fixture, both labelled (`extractor`, `source`). | requirement rows, `tender-engine/health` |
| Model provider | No `OPENAI_API_KEY` and no route to the provider. Chat answers come from the recorded model (`provider: recorded` on each message); the OpenAI chat adapter and the RealTalk WebRTC path are untested live. | assistant messages, voice session `mode` |
| Email/push delivery | Notifications are stored and delivered in-app with retry columns; no SMTP or push transport is wired. | `notification.delivered_at` |

## Modelling simplifications (stated in the product)

| Area | Simplification |
|---|---|
| Contract-term dispatch | "fast" mode solves selected years and interpolates the rest; interpolated years are marked per year and in the DPR. Full-resolution runs are an explicit option (`years_mode: exact`). |
| Tariff search | Dispatch is tariff-invariant when the merchant price never exceeds the tariff band; the search reports whether that shortcut applied and the certification boundary. A confirmation solve at the found tariff is listed as an open item in `DAY-4-REPORT.md`. |
| Financial model | Annual resolution; DSRA on year-1 debt service; WDV tax with loss carry-forward; no MAT, GST or state-specific duties unless entered as assumptions with a source. Defaults are marked `defaulted` and must be replaced before a bid. |
| Workbook | Dispatch is a snapshot sheet (the MILP is not a spreadsheet); finance is formula-driven and verified by LibreOffice recalculation. Excel data tables are not generated. |
| Historical results | A research snapshot (583 of 623 records; 40 from non-admissible hosts refused). Units are preserved and never converted; comparables are a filter with reasons, not a forecast. |
| Knowledge retrieval | Lexical token overlap over the platform's own records; no embeddings, no document-corpus search beyond the extracted requirements. |
| DPR | Generated sections and traced values from the award baseline; narrative is free text. Obligations come from the approved requirement version at the time of award; an award without one has an empty obligations section with a note. |

## Operational

- One organisation per deployment is assumed for capacity; the schema and every query are tenant-scoped, but no per-tenant quotas exist.
- Sessions are server-side with a 14-day default TTL; there is no SSO, MFA or password policy beyond length. Passwords are bcrypt.
- The worker is a single process per replica; long MILP runs hold their lease by heartbeat; a dead worker's job is reclaimed after `JOB_LEASE_SECONDS`.
- Object storage is a local volume (`DATA_DIR`); the `Storage` interface has one implementation. S3/GCS is a second implementation, not written.
- Backups are a daily `pg_dump` plus a tar of the object store (`deploy/backup.sh`); point-in-time recovery is not configured.
- Browser support: current Chromium-based and Firefox; the voice feature's recorded mode needs the Web Speech API (Chromium).
