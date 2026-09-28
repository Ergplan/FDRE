import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import base64
import pytest

from react_demo.backend.api import (
    EvaluationRequest,
    OptimizeRequest,
    PvsystUploadFile,
    PvsystUploadRequest,
    TenderUploadFile,
    TenderUploadRequest,
    defaults,
    evaluate,
    optimize,
    parse_pvsyst,
    parse_tender,
)

PVSYST_SAMPLE = Path("/Users/rachitagarwal/Downloads/NHPC Bikaner.pdf")


def test_react_demo_defaults_and_evaluate_api():
    base = defaults()
    assert base["capacity"]["contracted_capacity_mw"] == 200.0
    assert base["project"]["tender"]["tender_name"]

    result = evaluate(EvaluationRequest(years_mode="fast", use_wind_profile=True, wind_p_level="P50"))
    assert "tariff_label" in result
    assert result["wind"]["p_level"] == "P50"
    assert result["operating"]["totals"]["ppa_gwh"] > 0


def test_react_demo_optimizer_api_uses_capacity_variables():
    bounds = {
        "wind_mw": (0.0, 100.0),
        "solar_ac_mw": (0.0, 450.0),
        "bess_power_mw": (0.0, 277.5),
        "bess_energy_mwh": (0.0, 1110.0),
        "contracted_capacity_mw": (50.0, 70.0),
    }
    result = optimize(OptimizeRequest(
        years_mode="fast",
        use_wind_profile=True,
        wind_p_level="P90",
        effort="fast",
        bounds=bounds,
    ))
    variables = result["optimizer"]["variables"]
    used_bounds = result["optimizer"]["bounds"]

    assert "highs" in result["optimizer"]["solver"].lower()
    assert {"wind_mw", "solar_ac_mw", "bess_power_mw", "bess_energy_mwh", "contracted_capacity_mw"}.issubset(variables)
    assert used_bounds["bess_power_mw"] == [0.0, 277.5]
    assert used_bounds["bess_energy_mwh"] == [0.0, 1110.0]
    for key, value in variables.items():
        assert used_bounds[key][0] - 1e-6 <= value <= used_bounds[key][1] + 1e-6


@pytest.mark.skipif(not PVSYST_SAMPLE.exists(), reason="PVsyst sample PDF not available")
def test_react_demo_pvsyst_upload_parser():
    encoded = base64.b64encode(PVSYST_SAMPLE.read_bytes()).decode("ascii")
    result = parse_pvsyst(PvsystUploadRequest(files=[
        PvsystUploadFile(name=PVSYST_SAMPLE.name, content_base64=encoded)
    ]))

    assert len(result["reports"]) == 1
    assert result["reports"][0]["probability"]
    assert result["reports"][0]["p50_mwh_y1"] > 0


def test_react_demo_tender_parser_extracts_editable_constraints():
    tender_text = (
        "Bid capacity shall be in 10 MW multiple. "
        "The declared annual CUF shall be 40%. "
        "Monthly peak availability shall be 90% during peak hours. "
        "Maximum bidder capacity is 600 MW."
    )
    encoded = base64.b64encode(tender_text.encode("utf-8")).decode("ascii")
    result = parse_tender(TenderUploadRequest(file=TenderUploadFile(
        name="sample_tender.txt",
        content_base64=encoded,
    )))

    assert result["settings"]["declaredCuf"] == 40.0
    parsed = {row["Constraint"]: row["Parsed value"] for row in result["constraints"]}
    assert parsed["Monthly peak availability"] == "90.0%"
    assert parsed["Bid capacity multiple"] == "10 MW"
