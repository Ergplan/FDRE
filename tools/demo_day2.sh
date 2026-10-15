#!/usr/bin/env bash
# Day 2 demonstration against a running platform API (:8000) and worker, with tender_engine
# either live (TENDER_ENGINE_URL set on the API) or in fixture mode. Uses the bundled NHPC
# RfS (RFS.pdf, 264 pages) as the base document and a generated Amendment-01 PDF.
# Shows: dedupe, requirement version 1 with evidence, review and approval, a completed run,
# the amendment diff, stale flags, notifications, tasks, auto-apply on approval, timeline.
set -euo pipefail
API=${API:-http://127.0.0.1:8000/api/v1}
PASSWORD=${PASSWORD:-demo-pass-123}
json() { python3 tools/_jq.py "$1"; }
login() { curl -sS "$API/auth/login" -H 'Content-Type: application/json' -d "{\"email\":\"$1\",\"password\":\"$PASSWORD\"}" | json 'd["token"]'; }
ADMIN=$(login admin@ergplan.test); BIDS=$(login bids@ergplan.test); ENG=$(login engineer@ergplan.test)
ORG=$(curl -sS "$API/auth/me" -H "Authorization: Bearer $ADMIN" | json 'd["organizations"][0]["id"]')
echo "tender_engine: $(curl -sS "$API/orgs/$ORG/tender-engine/health" -H "Authorization: Bearer $ADMIN")"

T=$(curl -sS "$API/orgs/$ORG/tenders" -H "Authorization: Bearer $BIDS" -H 'Content-Type: application/json' -d '{"name":"NHPC FDRE Tranche-II (Day 2 demo)","procurer":"NHPC Limited","tender_family":"fdre","reference":"NHPC/FDRE-II"}' | json 'd["id"]')
curl -sS -o /dev/null "$API/orgs/$ORG/tenders/$T/members" -H "Authorization: Bearer $BIDS" -H 'Content-Type: application/json' -d '{"email":"engineer@ergplan.test"}'
INPUTS=$(.venv/bin/python - <<'PY' 2>/dev/null
import json, fdre_enterprise_engine as E
p = E.default_fdre2_project(); p.finance.hard_compliance_required = False
print(json.dumps({"name": "Base case", "inputs": {"project": E.project_to_dict(p), "settings": {"tenderProcurementMw": 1200}, "run_options": {"years_mode": "fast"}}}))
PY
)
S=$(echo "$INPUTS" | curl -sS "$API/orgs/$ORG/tenders/$T/scenarios" -H "Authorization: Bearer $BIDS" -H 'Content-Type: application/json' -d @- | json 'd["id"]')
R=$(curl -sS "$API/orgs/$ORG/scenarios/$S/runs" -H "Authorization: Bearer $ENG" -H 'Content-Type: application/json' -d '{"kind":"evaluate"}' | json 'd["id"]')
for i in $(seq 1 90); do ST=$(curl -sS "$API/orgs/$ORG/runs/$R?include_result=false" -H "Authorization: Bearer $ENG" | json 'd["status"]'); [ "$ST" != queued ] && [ "$ST" != running ] && break; sleep 2; done
echo "run $R: $ST"

echo "== base document: the bundled NHPC RfS (264 pages)"
BASE=$(curl -sS "$API/orgs/$ORG/tenders/$T/documents" -H "Authorization: Bearer $BIDS" -F "file=@RFS.pdf" -F kind=original -F issued_on=2024-08-01)
echo "$BASE" | json '"document", d["document"]["publication_order"], d["document"]["filename"], "extractor:", d["extractor"], "| requirement version", d["requirement_version"]["version_no"], "| candidates:", len(d["changes"])'
echo "$BASE" | json "'\n'.join(f'  {c[\"field_path\"]}: {c[\"new_value\"]} (p.{(c[\"new_evidence\"] or {}).get(\"page\")})' for c in d['changes'][:8])"
curl -sS -o /dev/null -w "same bytes again: HTTP %{http_code}\n" "$API/orgs/$ORG/tenders/$T/documents" -H "Authorization: Bearer $BIDS" -F "file=@RFS.pdf" -F kind=original
V1=$(echo "$BASE" | json 'd["requirement_version"]["id"]')
echo "== engineer accepts every requirement; bid manager approves version 1"
ROWS=$(curl -sS "$API/orgs/$ORG/tenders/$T/requirements" -H "Authorization: Bearer $ENG" | json '" ".join(r["id"] for r in d["version"]["requirements"] if r["value"] is not None)')
for ID in $ROWS; do curl -sS -o /dev/null "$API/orgs/$ORG/requirements/$ID/review" -H "Authorization: Bearer $ENG" -H 'Content-Type: application/json' -d '{"decision":"accept"}'; done
curl -sS "$API/orgs/$ORG/requirement-versions/$V1/approve" -H "Authorization: Bearer $BIDS" -X POST | json '"approved version", d["version"]["version_no"], "rule set", d["rule_set"]["version_no"], "rules", len(d["rule_set"]["rules"]), "certifiable", d["rule_set"]["certifiable"], "| blocking:", d["rule_set"]["blocking"][:3]'

echo "== Amendment-01 arrives (generated PDF: PPA tenure 25 -> 20 years, availability 90 -> 95%)"
.venv/bin/python - <<'PY'
import fitz
doc = fitz.open(); page = doc.new_page()
page.insert_text((72, 80), "NHPC Limited - Amendment-01 to RfS for supply of 1200 MW Firm and Dispatchable power", fontsize=11)
page.insert_text((72, 120), "Clause 7.1: The PPA shall be valid for a period of 20 (twenty) years from the SCOD.", fontsize=10)
page.insert_text((72, 140), "Clause 4.4.1: the RE Power Developer shall ensure minimum availability of 95% of the Contracted Capacity during peak hours.", fontsize=10)
doc.save("/tmp/Amendment-01.pdf")
PY
AM=$(curl -sS "$API/orgs/$ORG/tenders/$T/documents" -H "Authorization: Bearer $BIDS" -F "file=@/tmp/Amendment-01.pdf" -F kind=amendment -F issued_on=2024-09-15 -F effective_on=2024-09-15 -F "summary_of_change=Amendment-01: PPA tenure and peak availability revised")
echo "$AM" | json "'\n'.join(f'  {c[\"kind\"]:9} {c[\"field_path\"]}: {c[\"old_value\"]} -> {c[\"new_value\"]}  (p.{(c[\"new_evidence\"] or {}).get(\"page\")}: {((c[\"new_evidence\"] or {}).get(\"excerpt\") or \"\")[:70]})' for c in d['changes'] if c['kind'] != 'restated')"
echo "$AM" | json '"impact:", d["impact"]["summary"], "| owner", d["impact"]["owner_user_id"][:8]'
curl -sS "$API/orgs/$ORG/runs/$R?include_result=false" -H "Authorization: Bearer $ENG" | json '"run", d["id"][:8], d["status"], "stale:", d["stale"], "-", (d["stale_reason"] or "")[:90]'
curl -sS "$API/orgs/$ORG/notifications?unread_only=true" -H "Authorization: Bearer $ENG" | json '"engineer unread notifications:", len(d), "|", d[0]["title"] if d else ""'
curl -sS "$API/orgs/$ORG/tasks?tender_id=$T" -H "Authorization: Bearer $BIDS" | json "'open tasks:\n' + '\n'.join(f'  [{t[\"kind\"]}] {t[\"title\"]}' for t in d)"
V2=$(echo "$AM" | json 'd["requirement_version"]["id"]')
echo "== review the changed requirements and approve version 2 (auto-apply)"
ROWS=$(curl -sS "$API/orgs/$ORG/tenders/$T/requirements" -H "Authorization: Bearer $ENG" | json '" ".join(r["id"] for r in d["version"]["requirements"] if r["review_state"] == "unreviewed" and r["value"] is not None)')
for ID in $ROWS; do curl -sS -o /dev/null "$API/orgs/$ORG/requirements/$ID/review" -H "Authorization: Bearer $ENG" -H 'Content-Type: application/json' -d '{"decision":"accept"}'; done
curl -sS "$API/orgs/$ORG/requirement-versions/$V2/approve" -H "Authorization: Bearer $BIDS" -X POST | json '"approved version", d["version"]["version_no"], "| applied to scenarios:", d["applied"]'
curl -sS "$API/orgs/$ORG/tenders/$T/requirements/versions" -H "Authorization: Bearer $ENG" | json '"versions:", [(v["version_no"], v["status"]) for v in d]'
curl -sS "$API/orgs/$ORG/scenarios/$S" -H "Authorization: Bearer $ENG" | json '"scenario revision", d["revision"], "ppa_years now", d["current_input_version"]["inputs"]["project"]["tender"]["ppa_years"], "peak floor", d["current_input_version"]["inputs"]["project"]["tender"]["peak_availability_floor"], "|", d["current_input_version"]["note"][:80]'
echo "== timeline"
curl -sS "$API/orgs/$ORG/tenders/$T/timeline" -H "Authorization: Bearer $ENG" | json "'\n'.join(f'  {e[\"at\"][11:19]} {e[\"actor\"]:22} {e[\"action\"]}' for e in reversed(d[:40]))"
