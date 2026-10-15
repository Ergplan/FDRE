#!/usr/bin/env bash
# Day 4 demonstration against a running API (:8000) and worker: a scenario with solar + BESS
# supply modules, a fixed-tariff investment evaluation (workflow B, MILP dispatch) and a bid
# tariff optimisation (workflow A, tariff search over fixed-tariff MILP subproblems).
set -euo pipefail
API=${API:-http://127.0.0.1:8000/api/v1}
PASSWORD=${PASSWORD:-demo-pass-123}
json() { python3 tools/_jq.py "$1"; }
login() { curl -sS "$API/auth/login" -H 'Content-Type: application/json' -d "{\"email\":\"$1\",\"password\":\"$PASSWORD\"}" | json 'd["token"]'; }
BIDS=$(login bids@ergplan.test)
ORG=$(curl -sS "$API/auth/me" -H "Authorization: Bearer $BIDS" | json 'd["organizations"][0]["id"]')
T=$(curl -sS "$API/orgs/$ORG/tenders" -H "Authorization: Bearer $BIDS" -H 'Content-Type: application/json' -d '{"name":"Day 4 demo tender","procurer":"NHPC Limited","tender_family":"fdre"}' | json 'd["id"]')
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
print(json.dumps({"name": "Solar + wind + BESS, 150 MW contracted", "workflow": "bid_tariff", "inputs": {"project": c["project"], "supply": cfg, "supply_compiled": {"custom_cf": c["custom_cf"], "reconciliations": c["reconciliations"], "unsupported": []}, "profiles": {}, "settings": {}, "run_options": {"years_mode": "fast", "solve_years": [1, 10, 25], "time_limit_seconds": 120}}}))
PY
)
S=$(echo "$INPUTS" | curl -sS "$API/orgs/$ORG/tenders/$T/scenarios" -H "Authorization: Bearer $BIDS" -H 'Content-Type: application/json' -d @- | json 'd["id"]')
echo "scenario $S"
wait_run() { for i in $(seq 1 300); do ST=$(curl -sS "$API/orgs/$ORG/runs/$1?include_result=false" -H "Authorization: Bearer $BIDS" | json 'd["status"]'); [ "$ST" != queued ] && [ "$ST" != running ] && break; sleep 2; done; }
echo "== workflow B: fixed tariff 4.20 INR/kWh, capacities fixed, MILP dispatch"
R=$(curl -sS "$API/orgs/$ORG/scenarios/$S/runs" -H "Authorization: Bearer $BIDS" -H 'Content-Type: application/json' -d '{"kind":"fixed_tariff","solver_settings":{"tariff":4.2,"dispatch":"milp"}}' | json 'd["id"]')
wait_run "$R"
curl -sS "$API/orgs/$ORG/runs/$R" -H "Authorization: Bearer $BIDS" | json "f\"run {d['id'][:8]} {d['status']} | equity IRR {d['metrics'].get('equity_irr')} | project IRR {d['metrics'].get('project_irr')} | min DSCR {d['metrics'].get('min_dscr')} | NPV equity cr {d['metrics'].get('npv_equity_cr')} | certified {d['metrics'].get('certified')} | years solved {d['result']['term']['years_solved']} | year-1 PPA GWh {d['result']['term']['per_year'][0]['ppa_mwh']/1000:.1f} CUF {d['result']['term']['per_year'][0]['annual_cuf']:.3f} peak_ok {d['result']['term']['per_year'][0]['peak_ok']}\""
echo "== workflow A: bid tariff search (target equity IRR 14%, min DSCR 1.10)"
R2=$(curl -sS "$API/orgs/$ORG/scenarios/$S/runs" -H "Authorization: Bearer $BIDS" -H 'Content-Type: application/json' -d '{"kind":"bid_tariff","solver_settings":{"tariff_lo":2.0,"tariff_hi":12.0}}' | json 'd["id"]')
wait_run "$R2"
curl -sS "$API/orgs/$ORG/runs/$R2" -H "Authorization: Bearer $BIDS" | json "f\"run {d['id'][:8]} {d['status']} search {d['result']['search_status']} | tariff {d['result']['tariff']} | equity IRR {d['result']['finance']['equity_irr']:.4f} | min DSCR {d['result']['finance']['min_dscr']:.3f} | monotone {d['result']['monotone']} invariant {d['result']['dispatch_invariant']} | MILP solves {d['result']['milp_solves']} | samples {len(d['result']['samples'])}\""
curl -sS "$API/orgs/$ORG/runs/$R2" -H "Authorization: Bearer $BIDS" | json "'\n'.join(f\"  tariff {s['tariff']:.4f} IRR {s['equity_irr']:.4f} DSCR {s['min_dscr']:.3f} meets {s['meets']}\" for s in d['result']['samples'][:12])"
curl -sS "$API/orgs/$ORG/runs/$R2" -H "Authorization: Bearer $BIDS" | json "d['result']['certification_boundary']"
