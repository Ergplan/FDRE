"""BESS tender intelligence: requirement extraction with page citations."""
from __future__ import annotations

import fdre_bess_tender as B
from tests.bess_rfs_sample import make_pdf


def _by_key(result):
    return {f["key"]: f for f in result["requirements"]}


def test_extracts_bess_requirements_from_pdf(tmp_path):
    pdf = make_pdf(str(tmp_path / "rfs.pdf"))
    res = B.parse_bess_tender("GUVNL_BESS_RfS.pdf", open(pdf, "rb").read(), parser="standard")
    f = _by_key(res)
    assert res["is_bess"] and res["metadata"]["issuer"].startswith("Gujarat Urja")
    assert f["powerMw"]["value"] == 500 and f["energyMwh"]["value"] == 1000 and f["powerMw"]["page"] == 1
    assert f["durationH"]["value"] == 2
    assert f["cyclesPerDay"]["value"] == 2 and f["annualCycles"]["value"] == 730
    assert f["minRte"]["value"] == 0.85 and f["minRte"]["page"] == 3 and f["minRte"]["clause"] == "2.1"
    assert f["availability"]["value"] == 0.95 and f["availabilityBasis"]["value"] == "monthly"
    assert f["contractYears"]["value"] == 12 and f["scodMonths"]["value"] == 18
    # every value below is stated in the sample: none may come from a default
    for key in ("powerMw", "energyMwh", "durationH", "cyclesPerDay", "annualCycles", "minRte", "availability", "contractYears", "scodMonths",
                "ceilingTariff", "vgfLakhPerMwh", "chargingBy", "connectionKv", "minBidMw", "maxBidMw", "emdLakhPerMw", "pbgLakhPerMw"):
        assert f[key]["confidence"] == "high", (key, f[key])
    assert f["contractYears"]["clause"] == "1.2" and f["scodMonths"]["clause"] == "1.3"
    assert f["tariffBasis"]["value"] == "capacity"
    assert f["ceilingTariff"]["value"] == 380000
    assert f["vgfLakhPerMwh"]["value"] == 18
    assert f["chargingBy"]["value"] == "procurer"
    assert f["maintainCapacity"]["confidence"] == "high"
    assert f["connectionKv"]["value"] == 220
    assert f["minBidMw"]["value"] == 50 and f["maxBidMw"]["value"] == 250
    assert f["emdLakhPerMw"]["value"] == 4 and f["pbgLakhPerMw"]["value"] == 10
    assert "1.5 times" in f["availabilityPenalty"]["value"]
    assert all(r.get("snippet") for r in res["requirements"] if r["confidence"] == "high")


def test_missing_values_fall_back_to_flagged_defaults():
    res = B.parse_bess_tender("notes.txt", b"Battery Energy Storage System tender. Capacity 100 MW.", parser="standard")
    f = _by_key(res)
    assert f["powerMw"]["value"] == 100
    assert f["minRte"]["confidence"] == "low" and f["minRte"]["value"] == 0.85
    assert f["contractYears"]["found"] is False
