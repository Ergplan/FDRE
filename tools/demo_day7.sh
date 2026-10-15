#!/usr/bin/env bash
# Day 7 demonstration against a running API (:8000) and worker: the three workflows end to
# end on one tender, with an amendment arriving after completed runs. Tender intelligence
# (base RfS -> review -> approval), workflow B (fixed tariff, MILP), workflow A (bid tariff
# search), Amendment-01 (diff, stale runs, tasks, notifications), review and approval of
# version 2 (auto-applied), rerun, workflow C (award from the fresh run, DPR traced, exports).
set -euo pipefail
API=${API:-http://127.0.0.1:8000/api/v1}
PASSWORD=${PASSWORD:-demo-pass-123}
json() { python3 tools/_jq.py "$1"; }
login() { curl -sS "$API/auth/login" -H 'Content-Type: application/json' -d "{\"email\":\"$1\",\"password\":\"$PASSWORD\"}" | json 'd["token"]'; }
BIDS=$(login bids@ergplan.test); ENG=$(login engineer@ergplan.test)
ORG=$(curl -sS "$API/auth/me" -H "Authorization: Bearer $BIDS" | json 'd["organizations"][0]["id"]')
wait_run() { for i in $(seq 1 300); do ST=$(curl -sS "$API/orgs/$ORG/runs/$1?include_result=false" -H "Authorization: Bearer $BIDS" | json 'd["status"]'); [ "$ST" != queued ] && [ "$ST" != running ] && break; sleep 2; done; echo "$ST"; }
echo "== tender and base RfS (bundled NHPC RfS, tender_engine $(curl -sS "$API/orgs/$ORG/tender-engine/health" -H "Authorization: Bearer $BIDS" | json 'd.get("mode") or d.get("status")'))"
T=$(curl -sS "$API/orgs/$ORG/tenders" -H "Authorization: Bearer $BIDS" -H 'Content-Type: application/json' -d '{"name":"Day 7 end-to-end: NHPC FDRE Tranche-II","procurer":"NHPC Limited","tender_family":"fdre","reference":"NHPC/FDRE-II"}' | json 'd["id"]')
for E in engineer@ergplan.test approver@ergplan.test; do curl -sS -o /dev/null "$API/orgs/$ORG/tenders/$T/members" -H "Authorization: Bearer $BIDS" -H 'Content-Type: application/json' -d "{\"email\":\"$E\"}" || true; done
BASE=$(curl -sS "$API/orgs/$ORG/tenders/$T/documents" -H "Authorization: Bearer $BIDS" -F "file=@RFS.pdf" -F kind=original -F issued_on=2024-08-01)
V1=$(echo "$BASE" | json 'd["requirement_version"]["id"]')
echo "$BASE" | json '"requirement version", d["requirement_version"]["version_no"], "extractor", d["extractor"], "candidates", len(d["changes"])'
ROWS=$(curl -sS "$API/orgs/$ORG/tenders/$T/requirements" -H "Authorization: Bearer $ENG" | json '" ".join(r["id"] for r in d["version"]["requirements"] if r["value"] is not None)')
for ID in $ROWS; do curl -sS -o /dev/null "$API/orgs/$ORG/requirements/$ID/review" -H "Authorization: Bearer $ENG" -H 'Content-Type: application/json' -d '{"decision":"accept"}'; done
curl -sS -X POST "$API/orgs/$ORG/requirement-versions/$V1/approve" -H "Authorization: Bearer $BIDS" | json '"approved v1; rules", len(d["rule_set"]["rules"]), "certifiable", d["rule_set"]["certifiable"]'
echo "== scenario: solar + wind + BESS, 150 MW contracted"
INPUTS=$(.venv/bin/python - <<'PY' 2>/dev/null
import json, fdre_enterprise_engine as E
from fdre_platform.services.supply import module_template
from fdre_platform.supply.compile import compile_supply
from fdre_platform.supply.schema import parse_config
p = E.default_fdre2_project(); p.tender.contracted_capacity_mw = 150.0; p.finance.hard_compliance_required = False
base = E.project_to_dict(p)
solar = module_template("solar", "Solar A", "solar_a"); solar["mwac"], solar["mwp_dc"] = 240.0, 312.0; solar["profile"]["capacity_mw"] = 240.0
wind = module_template("wind", "Wind A", "wind_a"); wind["installed_mw"] = 60.0; wind["profile"]["capacity_mw"] = 60.0
bess = module_template("bess", "BESS A", "bess_a"); bess["power_mw"], bess["energy_mwh"] = 150.0, 600.0
cfg = {"nodes": [{"name": "POI", "interconnection_limit_mw": 300}], "modules": [solar, wind, bess]}
c = compile_supply(parse_config(cfg), base, None)
print(json.dumps({"name": "Base case", "workflow": "bid_tariff", "inputs": {"project": c["project"], "supply": cfg, "supply_compiled": {"custom_cf": c["custom_cf"], "reconciliations": c["reconciliations"], "unsupported": []}, "profiles": {}, "settings": {}, "run_options": {"years_mode": "fast", "solve_years": [1, 10, 25], "time_limit_seconds": 120}}}))
PY
)
S=$(echo "$INPUTS" | curl -sS "$API/orgs/$ORG/tenders/$T/scenarios" -H "Authorization: Bearer $BIDS" -H 'Content-Type: application/json' -d @- | json 'd["id"]')
echo "== workflow B: fixed tariff 4.20, MILP dispatch"
RB=$(curl -sS "$API/orgs/$ORG/scenarios/$S/runs" -H "Authorization: Bearer $BIDS" -H 'Content-Type: application/json' -d '{"kind":"fixed_tariff","solver_settings":{"tariff":4.2,"dispatch":"milp"}}' | json 'd["id"]')
echo "run B $RB: $(wait_run $RB)"; curl -sS "$API/orgs/$ORG/runs/$RB?include_result=false" -H "Authorization: Bearer $BIDS" | json '"  equity IRR", d["metrics"].get("equity_irr"), "min DSCR", d["metrics"].get("min_dscr"), "certified", d["metrics"].get("certified")'
echo "== workflow A: bid tariff search"
RA=$(curl -sS "$API/orgs/$ORG/scenarios/$S/runs" -H "Authorization: Bearer $BIDS" -H 'Content-Type: application/json' -d '{"kind":"bid_tariff","solver_settings":{"tariff_lo":2.0,"tariff_hi":12.0}}' | json 'd["id"]')
echo "run A $RA: $(wait_run $RA)"; curl -sS "$API/orgs/$ORG/runs/$RA" -H "Authorization: Bearer $BIDS" | json '"  tariff", d["result"]["tariff"], d["result"]["search_status"], "equity IRR", round(d["result"]["finance"]["equity_irr"],4), "MILP solves", d["result"]["milp_solves"]'
echo "== Amendment-01 arrives after both runs completed"
.venv/bin/python - <<'PY'
import fitz
doc = fitz.open(); page = doc.new_page()
page.insert_text((72, 80), "NHPC Limited - Amendment-01 to RfS for supply of 1200 MW Firm and Dispatchable power", fontsize=11)
page.insert_text((72, 120), "Clause 7.1: The PPA shall be valid for a period of 20 (twenty) years from the SCOD.", fontsize=10)
page.insert_text((72, 140), "Clause 4.4.1: the RE Power Developer shall ensure minimum availability of 95% of the Contracted Capacity during peak hours.", fontsize=10)
doc.save("/tmp/Amendment-01.pdf")
PY
AM=$(curl -sS "$API/orgs/$ORG/tenders/$T/documents" -H "Authorization: Bearer $BIDS" -F "file=@/tmp/Amendment-01.pdf" -F kind=amendment -F issued_on=2024-09-15 -F effective_on=2024-09-15 -F "summary_of_change=Amendment-01: PPA tenure and peak availability revised")
V2=$(echo "$AM" | json 'd["requirement_version"]["id"]')
echo "$AM" | json "'\n'.join(f'  {c[\"kind\"]:9} {c[\"field_path\"]}: {c[\"old_value\"]} -> {c[\"new_value\"]}' for c in d['changes'] if c['kind'] != 'restated')"
echo "$AM" | json '"  impact:", d["impact"]["summary"][:120], "| affected runs", len(d["impact"]["affected_run_ids"])'
for R in $RA $RB; do curl -sS "$API/orgs/$ORG/runs/$R?include_result=false" -H "Authorization: Bearer $BIDS" | json '"  run", d["id"][:8], d["status"], "stale:", d["stale"], "-", (d["stale_reason"] or "")[:70]'; done
curl -sS "$API/orgs/$ORG/tasks?tender_id=$T" -H "Authorization: Bearer $BIDS" | json "'  open tasks: ' + '; '.join(t['title'][:60] for t in d)"
echo "== review version 2, approve (auto-apply), rerun workflow B on the revised inputs"
ROWS=$(curl -sS "$API/orgs/$ORG/tenders/$T/requirements" -H "Authorization: Bearer $ENG" | json '" ".join(r["id"] for r in d["version"]["requirements"] if r["review_state"] == "unreviewed" and r["value"] is not None)')
for ID in $ROWS; do curl -sS -o /dev/null "$API/orgs/$ORG/requirements/$ID/review" -H "Authorization: Bearer $ENG" -H 'Content-Type: application/json' -d '{"decision":"accept"}'; done
curl -sS -X POST "$API/orgs/$ORG/requirement-versions/$V2/approve" -H "Authorization: Bearer $BIDS" | json '"  approved v2; applied to scenarios:", d["applied"]'
curl -sS "$API/orgs/$ORG/scenarios/$S" -H "Authorization: Bearer $BIDS" | json '"  scenario revision", d["revision"], "ppa_years", d["current_input_version"]["inputs"]["project"]["tender"]["ppa_years"], "peak floor", d["current_input_version"]["inputs"]["project"]["tender"]["peak_availability_floor"]'
RB2=$(curl -sS "$API/orgs/$ORG/scenarios/$S/runs" -H "Authorization: Bearer $BIDS" -H 'Content-Type: application/json' -d "{\"kind\":\"fixed_tariff\",\"solver_settings\":{\"tariff\":4.2,\"dispatch\":\"milp\"},\"supersedes_run_id\":\"$RB\"}" | json 'd["id"]')
echo "rerun $RB2: $(wait_run $RB2)"; curl -sS "$API/orgs/$ORG/runs/$RB2?include_result=false" -H "Authorization: Bearer $BIDS" | json '"  supersedes", d["supersedes_run_id"][:8], "stale", d["stale"], "equity IRR", d["metrics"].get("equity_irr"), "inputs", d["snapshot"]["inputs"]["hash"][:10]'
echo "== workflow C: award from the fresh run; DPR traced; exports"
APPR=$(login approver@ergplan.test)
AW=$(curl -sS "$API/orgs/$ORG/tenders/$T/awards" -H "Authorization: Bearer $APPR" -H 'Content-Type: application/json' -d "{\"run_id\":\"$RB2\",\"tariff_inr_per_kwh\":4.2,\"capacity_mw\":150,\"award_date\":\"2026-10-15\",\"letter_reference\":\"NHPC/LoA/2026/43\"}")
AWID=$(echo "$AW" | json 'd["id"]')
echo "$AW" | json '"  award", d["id"][:8], "requirement version", d["baseline"]["requirements"]["version_no"], "obligations frozen", len(d["baseline"]["requirements"]["items"])'
WS=$(curl -sS -X POST "$API/orgs/$ORG/awards/$AWID/dpr" -H "Authorization: Bearer $BIDS" | json 'd["id"]')
curl -sS "$API/orgs/$ORG/dpr/$WS/trace" -H "Authorization: Bearer $BIDS" | json '"  DPR trace:", len(d["values"]), "values, all match", d["all_match"], "| source run", d["run_id"][:8], "stale", d["run_stale"]'
curl -sS -X POST "$API/orgs/$ORG/dpr/$WS/export?format=pdf" -H "Authorization: Bearer $BIDS" | json '"  export", d["filename"], d["size_bytes"], "B"'
echo "== timeline (last 12)"
curl -sS "$API/orgs/$ORG/tenders/$T/timeline" -H "Authorization: Bearer $ENG" | json "'\n'.join(f'  {e[\"at\"][11:19]} {e[\"actor\"]:24} {e[\"action\"]}' for e in d[:12])"
