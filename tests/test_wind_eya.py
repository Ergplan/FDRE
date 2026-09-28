import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest

import fdre_enterprise_engine as E
import fdre_wind_eya as WYA

BIKANER_WIND_CSV = Path("/Users/rachitagarwal/Downloads/Wind Generation Bikaner.csv")


def test_wind_eya_generates_8760_and_bankable_tables():
    inputs = WYA.WindAssessmentInputs()
    result = WYA.run_wind_eya(inputs)

    assert len(result["hourly"]) == 8760
    assert {"Timestamp", "Wind Speed (m/s)", "Gross Energy (MWh)", "Net Energy (MWh)", "Grid Export (MWh)"}.issubset(result["hourly"].columns)
    assert len(result["monthly"]) == 12
    assert result["overview"]["gross_aep_mwh"] > result["overview"]["net_aep_mwh"] > 0
    assert result["overview"]["net_cf_pct"] > 20
    assert result["waterfall"].iloc[0]["Stage"] == "Gross AEP"
    assert result["waterfall"].iloc[-1]["Stage"] == "Net AEP"


def test_wind_eya_uncertainty_p_levels_are_ordered():
    result = WYA.run_wind_eya(WYA.WindAssessmentInputs())
    p = result["p_levels"].set_index("P-level")

    assert p.loc["P50", "Net AEP (MWh)"] > p.loc["P75", "Net AEP (MWh)"]
    assert p.loc["P75", "Net AEP (MWh)"] > p.loc["P90", "Net AEP (MWh)"]
    assert p.loc["P90", "Net AEP (MWh)"] > p.loc["P95", "Net AEP (MWh)"]


def test_wind_eya_scenario_comparison():
    base = WYA.run_wind_eya(WYA.WindAssessmentInputs(scenario_name="Base"))
    optimistic = WYA.run_wind_eya(WYA.WindAssessmentInputs(scenario_name="Optimistic", mean_wind_speed=7.8))
    comp = WYA.scenario_comparison({"Base": base, "Optimistic": optimistic})

    assert list(comp["Scenario"]) == ["Base", "Optimistic"]
    assert comp.loc[comp["Scenario"] == "Optimistic", "Net AEP (GWh)"].iloc[0] > comp.loc[comp["Scenario"] == "Base", "Net AEP (GWh)"].iloc[0]


@pytest.mark.skipif(not BIKANER_WIND_CSV.exists(), reason="Bikaner wind generation CSV not available")
def test_bikaner_wind_generation_csv_parses_p_levels():
    report = WYA.parse_wind_generation_csv(str(BIKANER_WIND_CSV))
    summary = report["summary"].set_index("P-level")

    assert len(report["hourly"]) == 8760
    assert summary.loc["P50", "Per-turbine AEP (MWh)"] == pytest.approx(7317.03, abs=0.1)
    assert summary.loc["P75", "Per-turbine AEP (MWh)"] < summary.loc["P50", "Per-turbine AEP (MWh)"]
    assert summary.loc["P90", "Per-turbine AEP (MWh)"] < summary.loc["P75", "Per-turbine AEP (MWh)"]
    assert summary.loc["P50", "Capacity factor %"] == pytest.approx(26.51, abs=0.05)


@pytest.mark.skipif(not BIKANER_WIND_CSV.exists(), reason="Bikaner wind generation CSV not available")
def test_bikaner_wind_profile_drives_engine_wind_generation():
    report = WYA.parse_wind_generation_csv(str(BIKANER_WIND_CSV))
    custom_cf = WYA.wind_generation_custom_cf(report, "P50")
    project = E.default_fdre2_project()
    profile = E.generation_profile(project, year=1, custom_cf=custom_cf)

    wind_cols = [f"gen_{E._safe_name(g.name)}" for g in project.generators if g.technology.lower() == "wind"]
    expected_mwh = sum(g.ac_mw * g.availability for g in project.generators if g.technology.lower() == "wind") * float(custom_cf["wind_cf"].sum())

    assert wind_cols
    assert float(profile[wind_cols].sum().sum()) == pytest.approx(expected_mwh, rel=1e-8)
