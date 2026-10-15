#!/usr/bin/env bash
# Day 5 demonstration against a running API (:8000) and worker: historical comparables with
# their reasons and sources, tender chat with a mention and a decision, and a formula Excel
# model exported from a completed run and verified by LibreOffice recalculation.
set -euo pipefail
API=${API:-http://127.0.0.1:8000/api/v1}
PASSWORD=${PASSWORD:-demo-pass-123}
json() { python3 tools/_jq.py "$1"; }
login() { curl -sS "$API/auth/login" -H 'Content-Type: application/json' -d "{\"email\":\"$1\",\"password\":\"$PASSWORD\"}" | json 'd["token"]'; }
BIDS=$(login bids@ergplan.test)
ORG=$(curl -sS "$API/auth/me" -H "Authorization: Bearer $BIDS" | json 'd["organizations"][0]["id"]')
echo "== historical comparables (FDRE, 200 MW, with storage)"
curl -sS "$API/orgs/$ORG/history/freshness" -H "Authorization: Bearer $BIDS" | json "f\"dataset {d['records']} records as of {d['dataset_as_of']}, sources checked {d['sources_last_checked']}, latest award {d['latest_award_date']}, {d['records_without_price']} without price\""
curl -sS "$API/orgs/$ORG/history/awards?tender_family=fdre&capacity_mw=200&storage=true&limit=6" -H "Authorization: Bearer $BIDS" | json "'\n'.join(f\"  {r['procurer'][:28]:28} {r['bidder'][:30]:30} {r['capacity']} {r['capacity_unit']} @ {r['price']} {r['price_unit']} [{r['result_kind']}] {r['award_date']} | {'; '.join(r['why_similar'])} | src p.{r['source_page']} {r['source_sha256'][:8]}\" for r in d['results'])"
echo "== non-tariff results are kept apart"
curl -sS "$API/orgs/$ORG/history/awards?tariff_only=false&limit=200" -H "Authorization: Bearer $BIDS" | json "'\n'.join(f\"  {r['price']} {r['price_unit']} -> {r['why_not_comparable']}\" for r in d['results'] if not r['comparable_tariff'])[:600]"
echo "== tender chat, mention, decision"
T=$(curl -sS "$API/orgs/$ORG/tenders" -H "Authorization: Bearer $BIDS" | json "[t['id'] for t in d if t['name'].startswith('Day 4')][0]")
curl -sS "$API/orgs/$ORG/tenders/$T/members" -H "Authorization: Bearer $BIDS" -H 'Content-Type: application/json' -d '{"email":"engineer@ergplan.test"}' >/dev/null || true
C=$(curl -sS "$API/orgs/$ORG/tenders/$T/comments" -H "Authorization: Bearer $BIDS" -H 'Content-Type: application/json' -d '{"body":"@engineer@ergplan.test please confirm the BESS round-trip efficiency before we lock the baseline","kind":"chat"}' | json 'd["id"]')
ENG=$(login engineer@ergplan.test)
curl -sS "$API/orgs/$ORG/notifications?unread_only=true" -H "Authorization: Bearer $ENG" | json "[ (n['kind'], n['title']) for n in d if n['kind']=='mention'][:1]"
curl -sS "$API/orgs/$ORG/tenders/$T/comments" -H "Authorization: Bearer $ENG" -H 'Content-Type: application/json' -d "{\"body\":\"Confirmed at 86% RTE from the supplier datasheet\",\"kind\":\"comment\",\"parent_id\":\"$C\"}" | json "f\"reply {d['id'][:8]} by {d['author']} -> parent {d['parent_id'][:8]}\""
curl -sS "$API/orgs/$ORG/tenders/$T/comments" -H "Authorization: Bearer $BIDS" | json "f\"thread has {len(d)} messages\""
echo "== formula workbook from the last completed fixed-tariff run"
R=$(curl -sS "$API/orgs/$ORG/tenders/$T/runs" -H "Authorization: Bearer $BIDS" | json "[r['id'] for r in d if r['status']=='succeeded' and r['kind'] in ('fixed_tariff','bid_tariff')][0]")
curl -sS -X POST "$API/orgs/$ORG/runs/$R/workbook?verify=true" -H "Authorization: Bearer $BIDS" | json "f\"artifact {d['artifact']['filename']} sha256 {d['artifact']['sha256'][:12]} size {d['artifact']['size_bytes']} B | verification {d['verification']['status']} | \" + ' | '.join(f\"{c['metric']}: workbook {c['workbook']:.5f} backend {c['backend']:.5f} {'ok' if c['ok'] else 'DIFFERS'}\" for c in d['verification']['comparisons'])"
curl -sS "$API/orgs/$ORG/runs/$R/artifacts" -H "Authorization: Bearer $BIDS" | json "[(a['kind'], a['filename']) for a in d]"
