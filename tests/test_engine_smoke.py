import math
import sys
from pathlib import Path
import pytest
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import fdre_enterprise_engine as E


@pytest.fixture(scope="module")
def fixed_optimized_case():
    project = E.default_fdre2_project()
    project.simulation.circular_soc_iterations = 1
    project = E.scale_project(
        project,
        wind_mw=27.5625,
        solar_ac_mw=281.25,
        bess_power_mw=180.375,
        bess_energy_mwh=721.5,
        contracted_capacity_mw=180.0,
    )
    result = E.evaluate_project(project, years=tuple(range(1, project.tender.ppa_years + 1)))
    assert result["status"]["reason"] == "ok"
    assert result["finance"] is not None
    return project, result["operating"], result["tariff"], result["finance"]


def test_default_capacity_summary():
    project = E.default_fdre2_project()
    summary = E.project_capacity_summary(project)
    assert summary['solar_ac_mw'] == 300.0
    assert summary['wind_mw'] == 31.5
    assert summary['bess_power_mw'] == 185.0
    assert summary['bess_usable_poi_mwh_y1'] == 700.0
    expected_final_usable = sum(b.usable_for_year(project.tender.ppa_years) for b in project.bess)
    assert summary['bess_usable_poi_mwh_final'] == pytest.approx(expected_final_usable)
    assert summary['bess_usable_poi_mwh_final'] < summary['bess_usable_poi_mwh_y1']
    assert summary['bess_nameplate_duration_hours'] == pytest.approx(4.0)
    assert summary['bess_usable_duration_hours_final'] < summary['bess_usable_duration_hours_y1']


def test_annual_cuf_upper_band_is_exposed_as_ppa_cap():
    project = E.default_fdre2_project()
    result = E.evaluate_project(project, years=(1,))
    operating = result["operating"]
    status = result["status"]

    assert project.tender.annual_cuf_floor == pytest.approx(0.34)
    assert project.tender.annual_cuf_ceiling == pytest.approx(0.44)
    assert operating["annual_cuf_ceiling"].iloc[0] == pytest.approx(0.44)
    assert operating["annual_ppa_cap_mwh"].iloc[0] == pytest.approx(
        0.44 * project.tender.contracted_capacity_mw * project.tender.cuf_hours_per_year
    )
    assert operating["annual_cuf"].max() <= project.tender.annual_cuf_ceiling + 1e-9
    assert status["annual_cuf_upper_ok"] is True


def test_nonpeak_bess_discharge_keeps_peak_soc_reserve():
    project = E.scale_project(
        E.default_fdre2_project(),
        solar_ac_mw=260.0,
        wind_mw=50.0,
        bess_power_mw=169.5,
        bess_energy_mwh=800.0,
        contracted_capacity_mw=200.0,
    )
    project.simulation.circular_soc_iterations = 1

    result = E.evaluate_project(project, years=(1, 5, 10, 15, 20, 25))
    assert result["status"]["reason"] == "ok"
    assert result["operating"]["min_monthly_peak_availability"].min() >= 0.90 - 1e-9

    aggressive = E.scale_project(
        E.default_fdre2_project(),
        solar_ac_mw=260.0,
        wind_mw=50.0,
        bess_power_mw=169.5,
        bess_energy_mwh=800.0,
        contracted_capacity_mw=200.0,
    )
    aggressive.simulation.circular_soc_iterations = 1
    aggressive.simulation.nonpeak_discharge_soc_reserve_fraction = 0.90
    aggressive_result = E.evaluate_project(aggressive, years=(1, 5, 10, 15, 20, 25))

    assert aggressive_result["status"]["reason"] == "monthly peak availability shortfall"
    assert aggressive_result["operating"]["min_monthly_peak_availability"].min() < 0.90


def test_size_linked_land_transmission_and_owner_costs_scale_with_capacity():
    base = E.default_fdre2_project()
    larger = E.scale_project(
        base,
        solar_ac_mw=450.0,
        wind_mw=60.0,
        bess_power_mw=220.0,
        bess_energy_mwh=900.0,
        contracted_capacity_mw=250.0,
    )

    base_capex = E.capex_model(base).components
    larger_capex = E.capex_model(larger).components

    assert base_capex["land_and_development_cr"] == pytest.approx(
        300.0 * base.finance.land_solar_cr_per_mw_ac
        + 31.5 * base.finance.land_wind_cr_per_mw
        + 740.0 * base.finance.land_bess_cr_per_mwh
    )
    assert larger_capex["land_and_development_cr"] > base_capex["land_and_development_cr"]
    assert larger_capex["transmission_connectivity_cr"] >= base_capex["transmission_connectivity_cr"]
    assert larger_capex["owner_costs_cr"] > base_capex["owner_costs_cr"]


def test_technology_capex_assumptions_flow_to_tariff(fixed_optimized_case):
    project, operating, base_tariff, _ = fixed_optimized_case
    high_capex_project = E.project_from_dict(E.project_to_dict(project))
    high_capex_project.finance.default_solar_capex_cr_per_mw_ac = 4.0
    high_capex_project.finance.default_wind_capex_cr_per_mw = 7.5
    high_capex_project.finance.default_bess_capex_cr_per_mwh = 1.35
    high_capex_project.finance.default_bess_pcs_capex_cr_per_mw = 0.45
    for gen in high_capex_project.generators:
        if gen.technology.lower() == "solar":
            gen.capex_cr_per_mw = 4.0
        elif gen.technology.lower() == "wind":
            gen.capex_cr_per_mw = 7.5
    for bess in high_capex_project.bess:
        bess.capex_cr_per_mwh = 1.35
        bess.pcs_capex_cr_per_mw = 0.45

    base_cost = E.capex_model(project).total_project_cost_cr
    high_cost = E.capex_model(high_capex_project).total_project_cost_cr
    high_tariff, high_finance, high_status = E.required_tariff(high_capex_project, operating)

    assert high_status["reason"] == "ok"
    assert high_cost > base_cost
    assert high_tariff > base_tariff
    assert high_finance.capex.total_project_cost_cr > base_cost


def test_peak_target_four_hours_per_day():
    project = E.default_fdre2_project()
    profile = E.generation_profile(project, year=1)
    target = E.build_peak_target(project, profile)
    assert (target > 0).sum() == 365 * 4
    first_day_hours = [int(i) for i in range(24) if target[i] > 0]
    assert first_day_hours == [7, 8, 19, 20]
    assert sum(project.tender.morning_window[0] <= h < project.tender.morning_window[1] for h in first_day_hours) == 2
    assert sum(project.tender.evening_window[0] <= h < project.tender.evening_window[1] for h in first_day_hours) == 2
    assert max(b - a for a, b in zip(first_day_hours, first_day_hours[1:])) > 2


def test_rfs_cuf_hours_default():
    project = E.default_fdre2_project()
    assert project.tender.cuf_hours_per_year == 8766
    assert math.isclose(
        project.tender.annual_min_mwh,
        project.tender.contracted_capacity_mw * 8766 * 0.40 * 0.85,
        rel_tol=0,
        abs_tol=1e-9,
    )


def test_project_json_requires_engine_schema():
    with pytest.raises(ValueError, match="nodes.*generators.*bess"):
        E.project_from_dict({"contracted_capacity_mw_default": 250.0, "components": []})


def test_dispatch_year_one_smoke():
    project = E.default_fdre2_project()
    project.simulation.circular_soc_iterations = 1
    result = E.dispatch_project_year(project, year=1)
    assert result.summary['ppa_mwh'] > 0
    assert result.summary['min_monthly_peak_availability'] > 0.90


def test_tariff_solver_with_penalties_allowed():
    project = E.default_fdre2_project()
    project.simulation.circular_soc_iterations = 1
    project.finance.hard_compliance_required = False
    operating, _ = E.operating_case(project, years=(1, 10, 20, 25), return_first_year_hourly=False)
    tariff, finance, status = E.required_tariff(project, operating)
    assert math.isfinite(tariff)
    assert finance is not None
    assert finance.min_dscr >= project.finance.min_dscr - 1e-6


def test_tariff_solver_zero_debt_uses_equity_target_not_dscr():
    project = E.default_fdre2_project()
    project.simulation.circular_soc_iterations = 1
    project.finance.hard_compliance_required = False
    project.finance.debt_fraction = 0.0
    operating, _ = E.operating_case(project, years=(1, 10, 20, 25), return_first_year_hourly=False)

    tariff, finance, status = E.required_tariff(project, operating)

    assert status["reason"] == "ok"
    assert math.isfinite(tariff)
    assert finance is not None
    assert math.isinf(finance.min_dscr)
    assert finance.equity_irr >= project.finance.target_equity_irr - 1e-6
    assert finance.equity_irr < 0.25


def test_fixed_optimized_finance_rerun_preserves_sizing(fixed_optimized_case):
    project, operating, _, _ = fixed_optimized_case
    original_capacity = E.project_capacity_summary(project)
    rerun_project = E.project_from_dict(E.project_to_dict(project))
    rerun_project.finance.debt_fraction = 0.0
    rerun_project.finance.interest_rate = 0.0
    rerun_project.finance.target_equity_irr = 0.14

    tariff, finance, status = E.required_tariff(rerun_project, operating)
    rerun_capacity = E.project_capacity_summary(rerun_project)

    assert status["reason"] == "ok"
    assert math.isfinite(tariff)
    assert finance is not None
    for key in ("contracted_capacity_mw", "solar_ac_mw", "wind_mw", "bess_power_mw", "bess_energy_mwh"):
        assert math.isclose(rerun_capacity[key], original_capacity[key], rel_tol=0, abs_tol=1e-9)


def test_fixed_optimized_zero_debt_rerun_prices_to_cost_of_equity(fixed_optimized_case):
    project, operating, _, _ = fixed_optimized_case
    rerun_project = E.project_from_dict(E.project_to_dict(project))
    rerun_project.finance.debt_fraction = 0.0
    rerun_project.finance.interest_rate = 0.0
    rerun_project.finance.target_equity_irr = 0.14

    tariff, finance, status = E.required_tariff(rerun_project, operating)

    assert status["reason"] == "ok"
    assert math.isfinite(tariff)
    assert finance is not None
    assert finance.capex.debt_cr == pytest.approx(0.0, abs=1e-9)
    assert math.isinf(finance.min_dscr)
    assert finance.equity_irr == pytest.approx(0.14, abs=1e-6)
    assert finance.project_irr == pytest.approx(0.14, abs=1e-6)
    assert finance.equity_irr < 0.25


def test_fixed_optimized_debt_rate_sensitivity_uses_same_dispatch(fixed_optimized_case):
    project, operating, base_tariff, _ = fixed_optimized_case
    base_project = E.project_from_dict(E.project_to_dict(project))
    high_rate_project = E.project_from_dict(E.project_to_dict(project))
    high_rate_project.finance.interest_rate = 0.12

    low_rate_tariff, low_rate_finance, low_status = E.required_tariff(base_project, operating)
    high_rate_tariff, high_rate_finance, high_status = E.required_tariff(high_rate_project, operating)
    high_rate_at_original_tariff = E.financial_model(high_rate_project, operating, base_tariff)

    assert low_status["reason"] == "ok"
    assert high_status["reason"] == "ok"
    assert low_rate_finance is not None
    assert high_rate_finance is not None
    assert high_rate_tariff > low_rate_tariff
    assert high_rate_finance.min_dscr >= high_rate_project.finance.min_dscr - 1e-6
    assert high_rate_finance.equity_irr == pytest.approx(high_rate_project.finance.target_equity_irr, abs=1e-6)
    assert high_rate_finance.equity_irr < 0.25
    assert high_rate_at_original_tariff.equity_irr < high_rate_finance.equity_irr
    assert high_rate_at_original_tariff.min_dscr >= high_rate_project.finance.min_dscr - 1e-6


def test_sculpted_finance_prices_to_equity_irr_without_dscr_overpricing():
    project = E.default_fdre2_project()
    project.simulation.circular_soc_iterations = 1
    project.finance.hard_compliance_required = False
    project.tender.hard_monthly_peak_compliance = False
    project.tender.hard_annual_cuf_compliance = False
    operating, _ = E.operating_case(project, years=tuple(range(1, project.tender.ppa_years + 1)), return_first_year_hourly=False)

    tariff, finance, status = E.required_tariff(project, operating)

    assert status["reason"] == "ok"
    assert finance is not None
    assert tariff == pytest.approx(6.12, abs=0.15)
    assert finance.equity_irr == pytest.approx(project.finance.target_equity_irr, abs=1e-6)
    assert finance.min_dscr == pytest.approx(finance.avg_dscr, abs=1e-5)
    assert finance.min_dscr >= 1.45
    assert finance.capex.debt_cr / finance.capex.total_project_cost_cr == pytest.approx(project.finance.debt_fraction, abs=1e-6)


def test_fixed_optimized_cost_of_equity_sensitivity(fixed_optimized_case):
    project, operating, _, _ = fixed_optimized_case
    low_coe_project = E.project_from_dict(E.project_to_dict(project))
    high_coe_project = E.project_from_dict(E.project_to_dict(project))
    for p in (low_coe_project, high_coe_project):
        p.finance.debt_fraction = 0.0
    low_coe_project.finance.target_equity_irr = 0.12
    high_coe_project.finance.target_equity_irr = 0.16

    low_tariff, low_finance, low_status = E.required_tariff(low_coe_project, operating)
    high_tariff, high_finance, high_status = E.required_tariff(high_coe_project, operating)

    assert low_status["reason"] == "ok"
    assert high_status["reason"] == "ok"
    assert low_finance is not None
    assert high_finance is not None
    assert high_tariff > low_tariff
    assert low_finance.equity_irr == pytest.approx(0.12, abs=1e-6)
    assert high_finance.equity_irr == pytest.approx(0.16, abs=1e-6)
    assert math.isinf(low_finance.min_dscr)
    assert math.isinf(high_finance.min_dscr)


def test_optimizer_reports_highs_seeded_solver():
    project = E.default_fdre2_project()
    project.simulation.circular_soc_iterations = 1
    base = E.project_capacity_summary(project)
    result = E.optimize_capacity(
        project,
        {
            "wind_mw": (base["wind_mw"] * 0.8, base["wind_mw"] * 1.2),
            "solar_ac_mw": (base["solar_ac_mw"] * 0.9, base["solar_ac_mw"] * 1.1),
            "bess_power_mw": (base["bess_power_mw"] * 0.9, base["bess_power_mw"] * 1.1),
            "bess_energy_mwh": (base["bess_energy_mwh"] * 0.9, base["bess_energy_mwh"] * 1.1),
            "contracted_capacity_mw": (180.0, 220.0),
        },
        years=(1,),
        maxiter=0,
        popsize=1,
        seed=project.simulation.seed,
        polish=False,
    )
    assert "highs" in result["optimizer"]["solver"].lower()
    assert result["optimizer"]["nfev"] >= 1


def test_optimizer_accepts_custom_wind_cf_profile():
    project = E.default_fdre2_project()
    project.simulation.circular_soc_iterations = 1
    base = E.project_capacity_summary(project)
    custom_cf = pd.DataFrame({"wind_cf": [0.25] * E.HOURS_PER_YEAR})

    result = E.optimize_capacity(
        project,
        {
            "wind_mw": (base["wind_mw"] * 0.9, base["wind_mw"] * 1.1),
            "solar_ac_mw": (base["solar_ac_mw"] * 0.95, base["solar_ac_mw"] * 1.05),
            "bess_power_mw": (base["bess_power_mw"] * 0.95, base["bess_power_mw"] * 1.05),
            "bess_energy_mwh": (base["bess_energy_mwh"] * 0.95, base["bess_energy_mwh"] * 1.05),
            "contracted_capacity_mw": (180.0, 220.0),
        },
        years=(1,),
        maxiter=0,
        popsize=1,
        seed=project.simulation.seed,
        polish=False,
        custom_cf=custom_cf,
    )

    assert "highs" in result["optimizer"]["solver"].lower()
    assert result["optimizer"]["nfev"] >= 1


def test_optimizer_can_force_two_hour_bess_duration():
    project = E.default_fdre2_project()
    project.simulation.circular_soc_iterations = 1
    base = E.project_capacity_summary(project)

    result = E.optimize_capacity(
        project,
        {
            "wind_mw": (base["wind_mw"] * 0.8, base["wind_mw"] * 1.2),
            "solar_ac_mw": (base["solar_ac_mw"] * 0.9, base["solar_ac_mw"] * 1.1),
            "bess_power_mw": (base["bess_power_mw"] * 0.5, base["bess_power_mw"] * 1.1),
            "bess_energy_mwh": (0.0, base["bess_power_mw"] * 2.5),
            "contracted_capacity_mw": (180.0, 220.0),
        },
        years=(1,),
        maxiter=0,
        popsize=1,
        seed=project.simulation.seed,
        polish=False,
        fixed_bess_duration_hours=2.0,
    )

    variables = result["optimizer"]["variables"]
    cap = E.project_capacity_summary(result["project"])
    assert result["optimizer"]["fixed_bess_duration_hours"] == pytest.approx(2.0)
    assert variables["bess_energy_mwh"] == pytest.approx(variables["bess_power_mw"] * 2.0)
    assert cap["bess_energy_mwh"] == pytest.approx(cap["bess_power_mw"] * 2.0)


def test_staged_bess_augmentation_affects_dispatch_and_finance():
    project = E.default_fdre2_project()
    project.simulation.circular_soc_iterations = 1
    for b in project.bess:
        b.energy_augmentation_schedule = [
            {
                "year": 2,
                "energy_mwh": b.energy_mwh * 0.10,
                "usable_mwh_at_poi": b.usable_mwh_at_poi * 0.10,
            }
        ]
        b.augmentation_years = [2]
    project.finance.bess_augmentation_schedule = [
        {"year": 2, "energy_replacement_fraction": 0.10, "cost_cr_per_mwh": 0.80}
    ]

    cap = E.project_capacity_summary(project)
    operating, _ = E.operating_case(project, years=(1, 2), return_first_year_hourly=False)
    tariff, finance, status = E.required_tariff(project, operating)

    assert cap["bess_usable_poi_mwh_y1"] < sum(b.usable_for_year(2) for b in project.bess)
    assert status["reason"] == "ok"
    assert finance is not None
    assert tariff > 0
    assert finance.table.loc[finance.table["year"] == 1, "augmentation_cr"].iloc[0] == pytest.approx(0.0)
    assert finance.table.loc[finance.table["year"] == 2, "augmentation_cr"].iloc[0] > 0


def test_optimizer_tests_lean_bess_for_fixed_100_mw_case():
    project = E.default_fdre2_project()
    project.simulation.circular_soc_iterations = 1
    project = E.scale_project(
        project,
        solar_ac_mw=300.0,
        wind_mw=100.0,
        bess_power_mw=185.0,
        bess_energy_mwh=740.0,
        contracted_capacity_mw=100.0,
    )

    result = E.optimize_capacity(
        project,
        {
            "wind_mw": (50.0, 200.0),
            "solar_ac_mw": (225.0, 450.0),
            "bess_power_mw": (0.0, 250.0),
            "bess_energy_mwh": (0.0, 1000.0),
            "contracted_capacity_mw": (100.0, 100.01),
        },
        years=(1, 5, 10, 15, 20, 25),
        maxiter=0,
        popsize=1,
        seed=project.simulation.seed,
        polish=False,
    )

    cap = E.project_capacity_summary(result["project"])
    assert result["status"]["reason"] == "ok"
    assert cap["bess_power_mw"] < 100.0
    assert cap["bess_energy_mwh"] <= 400.0
    assert result["tariff"] < 7.5
