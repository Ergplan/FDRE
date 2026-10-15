#!/usr/bin/env bash
# Day 1 demonstration, reproducible from a fresh checkout with the API on :8000 and the worker
# running (make api, make worker) against a bootstrapped database (make migrate, make bootstrap).
# Shows: two users in one tender, cross-tenant isolation, a saved scenario, a revision
# conflict, a queued run executed by the worker, and the audit trail.
set -euo pipefail
API=${API:-http://127.0.0.1:8000/api/v1}
ADMIN_EMAIL=${ADMIN_EMAIL:-admin@ergplan.test}
ENG_EMAIL=${ENG_EMAIL:-engineer@ergplan.test}
PASSWORD=${PASSWORD:-demo-pass-123}
J='python3 -c'
json() { python3 tools/_jq.py "$1"; }

login() { curl -sS "$API/auth/login" -H 'Content-Type: application/json' -d "{\"email\":\"$1\",\"password\":\"$PASSWORD\"}" | json 'd["token"]'; }
BIDS_EMAIL=${BIDS_EMAIL:-bids@ergplan.test}
ADMIN=$(login "$ADMIN_EMAIL"); ENG=$(login "$ENG_EMAIL"); BIDS=$(login "$BIDS_EMAIL")
ORG=$(curl -sS "$API/auth/me" -H "Authorization: Bearer $ADMIN" | json 'd["organizations"][0]["id"]')
echo "organisation $ORG"

echo "== admin creates a tender; the engineer cannot see it until added"
T=$(curl -sS "$API/orgs/$ORG/tenders" -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' -d '{"name":"NHPC FDRE Tranche-II demo","procurer":"NHPC"}' | json 'd["id"]')
curl -sS -o /dev/null -w "engineer before membership: HTTP %{http_code}\n" "$API/orgs/$ORG/tenders/$T" -H "Authorization: Bearer $ENG"
curl -sS -o /dev/null "$API/orgs/$ORG/tenders/$T/members" -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' -d "{\"email\":\"$ENG_EMAIL\"}"
curl -sS -o /dev/null -w "engineer after membership:  HTTP %{http_code}\n" "$API/orgs/$ORG/tenders/$T" -H "Authorization: Bearer $ENG"

curl -sS -o /dev/null "$API/orgs/$ORG/tenders/$T/members" -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' -d "{\"email\":\"$BIDS_EMAIL\"}"
echo "== the bid manager creates a scenario from the bundled engine project (finance inputs need finance.edit)"
INPUTS=$(.venv/bin/python - <<'PY' 2>/dev/null
import json, fdre_enterprise_engine as E
p = E.default_fdre2_project(); p.finance.hard_compliance_required = False
print(json.dumps({"name": "Base case", "inputs": {"project": E.project_to_dict(p), "settings": {"solarAcMw": 300}, "run_options": {"years_mode": "fast"}}}))
PY
)
S=$(echo "$INPUTS" | curl -sS "$API/orgs/$ORG/tenders/$T/scenarios" -H "Authorization: Bearer $BIDS" -H 'Content-Type: application/json' -d @- | json 'd["id"]')
echo "scenario $S"

echo "== admin and engineer both loaded revision 1; admin saves first, engineer's save is refused"
curl -sS -X PUT "$API/orgs/$ORG/scenarios/$S/inputs" -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' -d "$(echo "$INPUTS" | python3 -c 'import sys,json; d=json.load(sys.stdin)["inputs"]; d["settings"]["solarAcMw"]=350; print(json.dumps({"expected_revision":1,"inputs":d}))')" | json '"admin saved revision", d["revision"]'
curl -sS -X PUT "$API/orgs/$ORG/scenarios/$S/inputs" -H "Authorization: Bearer $ENG" -H 'Content-Type: application/json' -d "$(echo "$INPUTS" | python3 -c 'import sys,json; d=json.load(sys.stdin)["inputs"]; d["settings"]["solarAcMw"]=320; print(json.dumps({"expected_revision":1,"inputs":d}))')" | json '"engineer:", d["error"], "- current revision", d["current_revision"], "- conflicts", d["conflicts"]'

echo "== engineer queues an evaluate run; the worker executes it"
R=$(curl -sS "$API/orgs/$ORG/scenarios/$S/runs" -H "Authorization: Bearer $ENG" -H 'Content-Type: application/json' -H "Idempotency-Key: demo-$S" -d '{"kind":"evaluate"}' | json 'd["id"]')
for i in $(seq 1 120); do
  STATUS=$(curl -sS "$API/orgs/$ORG/runs/$R?include_result=false" -H "Authorization: Bearer $ENG" | json 'd["status"]')
  [ "$STATUS" != "queued" ] && [ "$STATUS" != "running" ] && break; sleep 2
done
curl -sS "$API/orgs/$ORG/runs/$R?include_result=false" -H "Authorization: Bearer $ENG" | json '"run", d["id"][:8], d["status"], "tariff", d["metrics"].get("tariff_rs_per_kwh"), "runtime s", d["metrics"].get("runtime_seconds"), "snapshot inputs hash", d["snapshot"]["inputs"]["hash"][:12]'

echo "== audit trail for the scenario"
curl -sS "$API/orgs/$ORG/audit?object_type=scenario&object_id=$S" -H "Authorization: Bearer $ADMIN" | json '"\n".join(e["at"][:19] + "  " + e["actor_label"].ljust(24) + e["action"].ljust(22) + " v" + str(e["object_version"]) + "  req=" + str(e["request_id"])[:8] for e in d)'
echo "== legacy workspace API still answers through the platform app"
curl -sS -o /dev/null -w "GET /api/defaults: HTTP %{http_code}\n" http://127.0.0.1:8000/api/defaults
