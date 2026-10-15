"""Latency sample of the live API (:8000): 25 requests per endpoint, median and p95 in ms,
printed as JSON for the Day 7 report. Signs in as bids@ergplan.test."""

import json
import os
import statistics
import sys
import time
import urllib.request

API = os.environ.get("API", "http://127.0.0.1:8000/api/v1")
PASSWORD = os.environ.get("PASSWORD", "demo-pass-123")


def call(path, method="GET", body=None, token=None):
    req = urllib.request.Request(
        f"{API}{path}",
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json", **({"Authorization": f"Bearer {token}"} if token else {})},
    )
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())


token = call("/auth/login", "POST", {"email": "bids@ergplan.test", "password": PASSWORD})["token"]
org = call("/auth/me", token=token)["organizations"][0]["id"]
tenders = call(f"/orgs/{org}/tenders", token=token)
tender = next((t for t in tenders if t["name"].startswith("Day 4")), tenders[0])
runs = call(f"/orgs/{org}/tenders/{tender['id']}/runs", token=token)
run = next((r for r in runs if r["status"] == "succeeded"), None)
paths = [
    "/health",
    f"/orgs/{org}/tenders",
    f"/orgs/{org}/tenders/{tender['id']}/scenarios",
    f"/orgs/{org}/tenders/{tender['id']}/runs",
    f"/orgs/{org}/history/awards?tender_family=fdre&capacity_mw=200&storage=true&limit=20",
    f"/orgs/{org}/assistant/knowledge?tender_id={tender['id']}",
    f"/orgs/{org}/tenders/{tender['id']}/timeline",
]
if run:
    paths.append(f"/orgs/{org}/runs/{run['id']}")
out = {}
for p in paths:
    ms = []
    for _ in range(25):
        t0 = time.perf_counter()
        call(p, token=token)
        ms.append((time.perf_counter() - t0) * 1000)
    out[p.split("?")[0].replace(org, "{org}").replace(tender["id"], "{tender}").replace(run["id"] if run else "~", "{run}")] = {
        "median_ms": round(statistics.median(ms), 1),
        "p95_ms": round(sorted(ms)[int(len(ms) * 0.95) - 1], 1),
        "n": len(ms),
    }
json.dump(out, sys.stdout, indent=1)
print()
