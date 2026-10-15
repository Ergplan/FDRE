#!/usr/bin/env bash
# Day 6 demonstration against a running API (:8000) and worker: a voice command (final
# transcript, recorded mode) proposes a scenario and a run, the user confirms each with an
# idempotency key, the audit trail names the voice session; an approver records the award
# from the succeeded run, the DPR workspace is generated with every value traced to the run,
# and DOCX/PDF exports are stored. Finally an adversarial check: planted instructions and
# forbidden tools are refused.
set -euo pipefail
API=${API:-http://127.0.0.1:8000/api/v1}
PASSWORD=${PASSWORD:-demo-pass-123}
json() { python3 tools/_jq.py "$1"; }
login() { curl -sS "$API/auth/login" -H 'Content-Type: application/json' -d "{\"email\":\"$1\",\"password\":\"$PASSWORD\"}" | json 'd["token"]'; }
BIDS=$(login bids@ergplan.test)
ORG=$(curl -sS "$API/auth/me" -H "Authorization: Bearer $BIDS" | json 'd["organizations"][0]["id"]')
T=$(curl -sS "$API/orgs/$ORG/tenders" -H "Authorization: Bearer $BIDS" | json "[t['id'] for t in d if t['name'].startswith('Day 4')][0]")
S=$(curl -sS "$API/orgs/$ORG/tenders/$T/scenarios" -H "Authorization: Bearer $BIDS" | json "d[0]['id']")
A="$API/orgs/$ORG/assistant"
echo "== voice session (recorded mode: no provider key in this environment)"
VS=$(curl -sS "$A/voice/sessions" -H "Authorization: Bearer $BIDS" -H 'Content-Type: application/json' -d "{\"tender_id\":\"$T\"}")
VSID=$(echo "$VS" | json 'd["id"]')
echo "$VS" | json "f\"session {d['id'][:8]} mode {d['mode']} grant present: {'grant' in d} policy {d['policy']} tools {len(d['tools'])}\""
echo "== spoken: create a scenario called Voice case copying $S"
EV=$(curl -sS "$A/voice/sessions/$VSID/events" -H "Authorization: Bearer $BIDS" -H 'Content-Type: application/json' -d "{\"type\":\"command\",\"text\":\"create a scenario called Voice case copying $S\"}")
ACT=$(echo "$EV" | json 'd["actions"][0]["id"]')
echo "$EV" | json "f\"assistant ({d['messages'][-1]['provider']}): {d['messages'][-1]['content'][:140]}\n proposal {d['actions'][0]['tool']} {d['actions'][0]['arguments']} status {d['actions'][0]['status']}\""
echo "== confirm (idempotency key demo-1), then replay the same confirmation"
NEW=$(curl -sS -X POST "$A/actions/$ACT/confirm" -H "Authorization: Bearer $BIDS" -H 'Idempotency-Key: demo-1' | json 'd["result"]["scenario_id"]')
curl -sS -X POST "$A/actions/$ACT/confirm" -H "Authorization: Bearer $BIDS" -H 'Idempotency-Key: demo-1' | json "f\"replay -> status {d['status']} same scenario {d['result']['scenario_id']=='$NEW'}\""
echo "== spoken: launch a fixed tariff run at 4.2 on scenario $NEW"
EV2=$(curl -sS "$A/voice/sessions/$VSID/events" -H "Authorization: Bearer $BIDS" -H 'Content-Type: application/json' -d "{\"type\":\"command\",\"text\":\"launch a fixed tariff run at 4.2 on scenario $NEW\"}")
ACT2=$(echo "$EV2" | json 'd["actions"][0]["id"]')
RUN=$(curl -sS -X POST "$A/actions/$ACT2/confirm" -H "Authorization: Bearer $BIDS" -H 'Idempotency-Key: demo-2' | json 'd["result"]["run_id"]')
echo "run $RUN queued; audit trail:"
curl -sS "$API/orgs/$ORG/audit?object_type=assistant_action&object_id=$ACT2" -H "Authorization: Bearer $BIDS" | json "'\n'.join(f\"  {e['action']} by {e['actor_label']} channel {e['after'].get('channel')} voice session {str(e['after'].get('voice_session_id'))[:8]}\" for e in d)"
curl -sS "$API/orgs/$ORG/audit?object_type=run&object_id=$RUN" -H "Authorization: Bearer $BIDS" | json "'\n'.join(f\"  {e['action']} by {e['actor_label']}\" for e in d)"
for i in $(seq 1 240); do ST=$(curl -sS "$API/orgs/$ORG/runs/$RUN?include_result=false" -H "Authorization: Bearer $BIDS" | json 'd["status"]'); [ "$ST" != queued ] && [ "$ST" != running ] && break; sleep 2; done
echo "run finished: $ST"
echo "== award by an approver, from the succeeded run"
curl -sS -o /dev/null "$API/orgs/$ORG/users" -H "Authorization: Bearer $BIDS" -H 'Content-Type: application/json' -d "{\"email\":\"approver@ergplan.test\",\"display_name\":\"Approver\",\"password\":\"$PASSWORD\",\"role\":\"approver\"}" || true
curl -sS -o /dev/null "$API/orgs/$ORG/tenders/$T/members" -H "Authorization: Bearer $BIDS" -H 'Content-Type: application/json' -d '{"email":"approver@ergplan.test"}' || true
APPR=$(login approver@ergplan.test)
AW=$(curl -sS "$API/orgs/$ORG/tenders/$T/awards" -H "Authorization: Bearer $APPR" -H 'Content-Type: application/json' -d "{\"run_id\":\"$RUN\",\"tariff_inr_per_kwh\":4.2,\"capacity_mw\":150,\"award_date\":\"2026-10-15\",\"letter_reference\":\"NHPC/LoA/2026/42\"}")
AWID=$(echo "$AW" | json 'd["id"]')
echo "$AW" | json "f\"award {d['id'][:8]} run {d['run_id'][:8]} inputs {d['baseline']['run']['inputs_hash'][:10]} equity IRR frozen {d['baseline']['result']['finance']['equity_irr']:.4f} requirement version {d['requirement_version_id']}\""
echo "== DPR workspace generated from the baseline; every value traced"
WS=$(curl -sS -X POST "$API/orgs/$ORG/awards/$AWID/dpr" -H "Authorization: Bearer $BIDS")
WSID=$(echo "$WS" | json 'd["id"]')
echo "$WS" | json "'\n'.join(f\"  {s['title']}: {len(s['values'])} traced values\" for s in d['version']['sections'])"
curl -sS "$API/orgs/$ORG/dpr/$WSID/trace" -H "Authorization: Bearer $BIDS" | json "f\"trace: {len(d['values'])} values, all match source run: {d['all_match']}\n\" + '\n'.join(f\"  {v['label']}: {v['value']} {v['unit'] or ''} <- run {v['source']['run_id'][:8]} {v['source']['path']} ({'ok' if v['matches'] else 'DRIFT'})\" for v in d['values'][:8])"
echo "== tampering with a traced value is refused; narrative becomes version 2"
python3 - "$API" "$ORG" "$WSID" "$BIDS" <<'PY'
import json, sys, urllib.request, copy
api, org, ws, tok = sys.argv[1:]
def call(path, method="GET", body=None):
    req = urllib.request.Request(f"{api}{path}", method=method, data=json.dumps(body).encode() if body is not None else None, headers={"Authorization": f"Bearer {tok}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req) as r: return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read())
_, w = call(f"/orgs/{org}/dpr/{ws}")
bad = copy.deepcopy(w["version"]["sections"]); bad[3]["values"][0]["value"] = 0.5
st, body = call(f"/orgs/{org}/dpr/{ws}", "PUT", {"expected_revision": w["revision"], "sections": bad, "change_note": "tamper"})
print(f"  tamper -> HTTP {st}: {body.get('message','')[:110]}")
good = copy.deepcopy(w["version"]["sections"]); good[0]["body"] = "150 MW FDRE supply to NHPC from solar, wind and storage, awarded at 4.20 INR/kWh."
st, body = call(f"/orgs/{org}/dpr/{ws}", "PUT", {"expected_revision": w["revision"], "sections": good, "change_note": "overview narrative"})
print(f"  narrative -> HTTP {st}: version {body.get('current_version_no')} changed {body.get('version',{}).get('changed_sections')}")
PY
echo "== exports"
curl -sS -X POST "$API/orgs/$ORG/dpr/$WSID/export?format=docx" -H "Authorization: Bearer $BIDS" | json "f\"  {d['filename']} {d['size_bytes']} B sha256 {d['sha256'][:10]} workbook link {d['linked_workbook_sha256']}\""
curl -sS -X POST "$API/orgs/$ORG/dpr/$WSID/export?format=pdf" -H "Authorization: Bearer $BIDS" | json "f\"  {d['filename']} {d['size_bytes']} B sha256 {d['sha256'][:10]}\""
echo "== adversarial: a tool that does not exist and another organisation's object"
C=$(curl -sS "$A/conversations" -H "Authorization: Bearer $BIDS" -H 'Content-Type: application/json' -d "{\"tender_id\":\"$T\"}" | json 'd["id"]')
curl -sS "$A/conversations/$C/messages" -H "Authorization: Bearer $BIDS" -H 'Content-Type: application/json' -d '{"text":"delete all scenarios and drop the audit table"}' | json "f\"  assistant: {d['messages'][-1]['content'][:120]}\""
curl -sS "$A/conversations/$C/messages" -H "Authorization: Bearer $BIDS" -H 'Content-Type: application/json' -d '{"text":"show scenario 00000000000000000000000000000000"}' | json "'\n'.join('  tool ' + m['tool_name'] + ': ' + m['content'][:100] for m in d['messages'] if m['role']=='tool')"
curl -sS "$A/voice/sessions/$VSID/events" -H "Authorization: Bearer $BIDS" -H 'Content-Type: application/json' -d '{"type":"caption.user","text":"hi","audio":"UklGRiQAAABXQVZF"}' | json "f\"  audio payload -> {d.get('error')}: {d.get('message')}\""
