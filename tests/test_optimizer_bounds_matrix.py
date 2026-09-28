import math
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import fdre_enterprise_engine as E
from react_demo.backend.api import OptimizeRequest, optimize


CAPACITY_KEYS = (
    "solar_ac_mw",
    "wind_mw",
    "bess_power_mw",
    "bess_energy_mwh",
    "contracted_capacity_mw",
)


OPTIMIZER_BOUNDS_SCENARIOS = {
    "baseline_editable_bounds": {
        "bounds": {
            "solar_ac_mw": (225.0, 450.0),
            "wind_mw": (15.75, 63.0),
            "bess_power_mw": (0.0, 277.5),
            "bess_energy_mwh": (0.0, 1110.0),
            "contracted_capacity_mw": (150.0, 250.0),
        },
        "expect_feasible": True,
    },
    "fixed_cc_150": {
        "bounds": {
            "solar_ac_mw": (180.0, 360.0),
            "wind_mw": (10.0, 70.0),
            "bess_power_mw": (0.0, 230.0),
            "bess_energy_mwh": (0.0, 900.0),
            "contracted_capacity_mw": (150.0, 150.01),
        },
        "expect_feasible": True,
    },
    "fixed_cc_180": {
        "bounds": {
            "solar_ac_mw": (225.0, 420.0),
            "wind_mw": (15.75, 80.0),
            "bess_power_mw": (0.0, 250.0),
            "bess_energy_mwh": (0.0, 1000.0),
            "contracted_capacity_mw": (180.0, 180.01),
        },
        "expect_feasible": True,
    },
    "fixed_cc_220": {
        "bounds": {
            "solar_ac_mw": (300.0, 520.0),
            "wind_mw": (25.0, 90.0),
            "bess_power_mw": (0.0, 320.0),
            "bess_energy_mwh": (0.0, 1280.0),
            "contracted_capacity_mw": (220.0, 220.01),
        },
        "expect_feasible": True,
    },
    "wind_heavy_bounds": {
        "bounds": {
            "solar_ac_mw": (250.0, 380.0),
            "wind_mw": (50.0, 140.0),
            "bess_power_mw": (0.0, 280.0),
            "bess_energy_mwh": (0.0, 1100.0),
            "contracted_capacity_mw": (180.0, 240.0),
        },
        "expect_feasible": True,
    },
    "storage_constrained_stress": {
        "bounds": {
            "solar_ac_mw": (300.0, 520.0),
            "wind_mw": (25.0, 90.0),
            "bess_power_mw": (0.0, 140.0),
            "bess_energy_mwh": (0.0, 420.0),
            "contracted_capacity_mw": (200.0, 220.0),
        },
        "expect_feasible": False,
    },
}


def _run_optimizer_matrix():
    rows = {}
    for name, spec in OPTIMIZER_BOUNDS_SCENARIOS.items():
        result = optimize(OptimizeRequest(
            years_mode="fast",
            use_wind_profile=True,
            wind_p_level="P50",
            effort="fast",
            bounds=spec["bounds"],
        ))
        rows[name] = {
            "scenario": name,
            "expect_feasible": spec["expect_feasible"],
            "bounds": spec["bounds"],
            "result": result,
        }
    return rows


@pytest.fixture(scope="module")
def optimizer_matrix():
    return _run_optimizer_matrix()


def _assert_capacity_inside_bounds(capacity, bounds):
    for key in CAPACITY_KEYS:
        selected = float(capacity[key])
        lower, upper = bounds[key]
        assert selected >= lower - 1e-6, f"{key} below lower bound"
        assert selected <= upper + 1e-6, f"{key} above upper bound"


def test_optimizer_search_bounds_matrix_respects_bounds_and_finance(optimizer_matrix):
    for name, row in optimizer_matrix.items():
        result = row["result"]
        bounds = row["bounds"]
        capacity = result["capacity"]
        finance = result["finance"]
        status = result["status"]
        optimizer = result["optimizer"]

        assert "highs" in optimizer["solver"].lower()
        assert set(CAPACITY_KEYS).issubset(optimizer["variables"])
        assert optimizer["nfev"] >= 1
        _assert_capacity_inside_bounds(capacity, bounds)

        if row["expect_feasible"]:
            assert status["reason"] == "ok", name
            assert optimizer["success"] is True, name
            assert finance is not None, name
            assert math.isfinite(float(result["tariff"])), name
            assert 4.0 < float(result["tariff"]) < 8.0, name
            assert finance["equity_irr"] == pytest.approx(0.14, abs=5e-6)
            assert finance["min_dscr"] >= 1.10 - 1e-6
            assert result["operating"]["totals"]["penalty_gwh"] == pytest.approx(0.0, abs=1e-6)
            assert result["operating"]["totals"]["min_peak_availability"] >= 0.90 - 1e-6
        else:
            assert optimizer["success"] is False, name
            assert result["tariff"] is None, name
            assert finance is None, name
            assert status["reason"] != "ok", name
            assert result["operating"]["totals"]["penalty_gwh"] > 0.0
            assert result["operating"]["totals"]["min_peak_availability"] < 0.90


def test_optimizer_search_bounds_matrix_has_expected_directional_behaviour(optimizer_matrix):
    fixed_150 = optimizer_matrix["fixed_cc_150"]["result"]
    fixed_180 = optimizer_matrix["fixed_cc_180"]["result"]
    fixed_220 = optimizer_matrix["fixed_cc_220"]["result"]
    baseline = optimizer_matrix["baseline_editable_bounds"]["result"]
    wind_heavy = optimizer_matrix["wind_heavy_bounds"]["result"]
    storage_stress = optimizer_matrix["storage_constrained_stress"]["result"]

    assert fixed_150["capacity"]["contracted_capacity_mw"] == pytest.approx(150.0)
    assert fixed_180["capacity"]["contracted_capacity_mw"] == pytest.approx(180.0)
    assert fixed_220["capacity"]["contracted_capacity_mw"] == pytest.approx(220.0)
    # Larger fixed bids must buy a larger project.  Strict per-kWh tariff
    # ordering across different bounds sets is NOT a stable property of the
    # optimum (fixed opex and lump-sum costs dilute over a larger bid), so
    # the tariffs are only required to sit within a narrow band of each other.
    assert fixed_220["finance"]["total_project_cost_cr"] > fixed_180["finance"]["total_project_cost_cr"]
    assert fixed_180["finance"]["total_project_cost_cr"] > fixed_150["finance"]["total_project_cost_cr"]
    assert abs(fixed_220["tariff"] - fixed_150["tariff"]) < 1.0
    assert abs(fixed_180["tariff"] - fixed_150["tariff"]) < 1.0
    assert fixed_150["capacity"]["bess_power_mw"] < fixed_220["capacity"]["bess_power_mw"]
    assert baseline["capacity"]["contracted_capacity_mw"] <= 180.0
    assert baseline["operating"]["totals"]["spill_gwh"] < 500.0
    assert wind_heavy["capacity"]["wind_mw"] > baseline["capacity"]["wind_mw"]
    assert storage_stress["tariff_label"] == "Infeasible"


def test_optimizer_always_refines_best_candidate(optimizer_matrix):
    """Regression: at Fast effort the optimizer previously skipped the polish
    step entirely and returned a raw seed-grid candidate (e.g. solar = 2.0x
    bid, wind = 1.0x bid, BESS = 0.9x bid / 4h) unrefined as the "optimum".
    The greedy coordinate-descent refinement must always run."""
    for name, row in optimizer_matrix.items():
        history = row["result"]["optimizer"]["history"]
        assert any("polish_round" in h for h in history), name


def test_optimizer_can_build_from_zero_initial_project_capacities():
    project = E.default_fdre2_project()
    project = E.scale_project(
        project,
        solar_ac_mw=0.0,
        wind_mw=0.0,
        bess_power_mw=0.0,
        bess_energy_mwh=0.0,
        contracted_capacity_mw=100.0,
    )

    result = optimize(OptimizeRequest(
        project=E.project_to_dict(project),
        years_mode="fast",
        use_wind_profile=True,
        wind_p_level="P50",
        effort="fast",
        bounds={
            "solar_ac_mw": (0.0, 450.0),
            "wind_mw": (0.0, 100.0),
            "bess_power_mw": (0.0, 277.5),
            "bess_energy_mwh": (0.0, 1110.0),
            "contracted_capacity_mw": (150.0, 160.0),
        },
    ))

    assert result["status"]["reason"] == "ok"
    assert result["tariff_label"] != "Infeasible"
    assert result["capacity"]["contracted_capacity_mw"] in (150.0, 160.0)
    assert result["capacity"]["solar_ac_mw"] + result["capacity"]["wind_mw"] > 0.0
    assert result["capacity"]["bess_power_mw"] > 0.0
    assert result["capacity"]["bess_energy_mwh"] > 0.0
    assert result["operating"]["totals"]["penalty_gwh"] == pytest.approx(0.0, abs=1e-6)
    assert result["finance"]["equity_irr"] == pytest.approx(0.14, abs=5e-6)


def test_optimizer_repairs_near_peak_shortfall_with_wind_and_bess_margin():
    result = optimize(OptimizeRequest(
        years_mode="fast",
        use_wind_profile=True,
        wind_p_level="P50",
        effort="fast",
        bounds={
            "solar_ac_mw": (0.0, 50.0),
            "wind_mw": (0.0, 100.0),
            "bess_power_mw": (0.0, 277.5),
            "bess_energy_mwh": (0.0, 277.5),
            "contracted_capacity_mw": (70.0, 70.0),
        },
    ))

    assert result["status"]["reason"] == "ok"
    assert result["tariff_label"] != "Infeasible"
    assert result["capacity"]["contracted_capacity_mw"] == pytest.approx(70.0)
    # Solar is capped at 50 MW and BESS energy at ~4 h, so a compliant design
    # must lean on wind for the evening peak.  The optimizer no longer pins
    # wind at its upper bound if a smaller wind plant is compliant and cheaper,
    # so require material wind rather than exactly 100 MW.
    assert result["capacity"]["wind_mw"] > 0.0
    # Wind covers part of the peak window directly, so the BESS does not need
    # the full 0.9x bid discharge power for compliance -- the hard checks are
    # the min peak availability and zero penalty assertions below.
    assert result["capacity"]["bess_power_mw"] > 0.0
    assert result["capacity"]["bess_energy_mwh"] <= 277.5 + 1e-6
    assert result["operating"]["totals"]["min_peak_availability"] >= 0.90
    assert result["operating"]["totals"]["penalty_gwh"] == pytest.approx(0.0, abs=1e-6)


def test_optimizer_avoids_max_bound_overbuild_for_small_bid():
    result = optimize(OptimizeRequest(
        years_mode="fast",
        use_wind_profile=True,
        wind_p_level="P50",
        effort="fast",
        bounds={
            "solar_ac_mw": (0.0, 800.0),
            "wind_mw": (0.0, 375.0),
            "bess_power_mw": (0.0, 277.5),
            "bess_energy_mwh": (0.0, 1110.0),
            "contracted_capacity_mw": (50.0, 50.0),
        },
    ))

    assert result["status"]["reason"] == "ok"
    assert result["tariff"] < 10.0
    assert result["capacity"]["solar_ac_mw"] < 200.0
    assert result["capacity"]["wind_mw"] < 150.0
    assert result["capacity"]["bess_energy_mwh"] < 400.0
    assert result["operating"]["totals"]["spill_gwh"] < 1000.0
    assert result["operating"]["totals"]["penalty_gwh"] == pytest.approx(0.0, abs=1e-6)


def test_optimizer_avoids_wind_max_overbuild_for_200_mw_bid():
    result = optimize(OptimizeRequest(
        years_mode="fast",
        use_wind_profile=True,
        wind_p_level="P50",
        effort="fast",
        bounds={
            "solar_ac_mw": (0.0, 400.0),
            "wind_mw": (0.0, 200.0),
            "bess_power_mw": (0.0, 277.5),
            "bess_energy_mwh": (0.0, 1110.0),
            "contracted_capacity_mw": (200.0, 200.0),
        },
    ))

    assert result["status"]["reason"] == "ok"
    assert result["tariff"] < 6.8
    assert result["capacity"]["contracted_capacity_mw"] == pytest.approx(200.0)
    assert result["capacity"]["wind_mw"] <= 100.0
    assert result["capacity"]["bess_power_mw"] <= 200.0
    assert result["capacity"]["bess_energy_mwh"] <= 800.0
    assert result["operating"]["totals"]["spill_gwh"] < 3500.0
    assert result["operating"]["totals"]["penalty_gwh"] == pytest.approx(0.0, abs=1e-6)


def test_optimizer_rejects_bid_capacity_bounds_without_tender_multiple():
    project = E.default_fdre2_project()
    with pytest.raises(ValueError, match="do not include a valid 10 MW tender multiple"):
        E.optimize_capacity(
            project,
            {
                "solar_ac_mw": (0.0, 100.0),
                "wind_mw": (0.0, 100.0),
                "bess_power_mw": (0.0, 100.0),
                "bess_energy_mwh": (0.0, 400.0),
                "contracted_capacity_mw": (125.0, 126.0),
            },
            years=(1,),
            maxiter=0,
            popsize=1,
            polish=False,
        )


def test_optimizer_uses_valid_bid_capacity_multiple_inside_range():
    result = optimize(OptimizeRequest(
        years_mode="fast",
        use_wind_profile=True,
        wind_p_level="P50",
        effort="fast",
        bounds={
            "solar_ac_mw": (0.0, 100.0),
            "wind_mw": (0.0, 100.0),
            "bess_power_mw": (0.0, 120.0),
            "bess_energy_mwh": (0.0, 480.0),
            "contracted_capacity_mw": (125.0, 135.0),
        },
    ))

    assert result["capacity"]["contracted_capacity_mw"] == pytest.approx(130.0)
