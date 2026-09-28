import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import fdre_enterprise_engine as E
import fdre_eya as YA


def test_wind_eya_matches_report_calibration():
    wind = YA.wind_eya()

    assert wind["capacity_mw"] == 50.4
    assert wind["gross_gwh"] == 235.70
    assert wind["after_wake_gwh"] == pytest_approx(198.65, abs=0.06)
    assert wind["net_p50_gwh"] == pytest_approx(178.34, abs=0.05)
    assert wind["sigma_pct"] == pytest_approx(9.47, abs=0.01)
    assert 100 * wind["plevels"]["P50"]["plf"] == pytest_approx(40.38, abs=0.02)
    assert 100 * wind["plevels"]["P90"]["plf"] == pytest_approx(35.48, abs=0.03)


def test_solar_eya_matches_report_calibration():
    solar = {site["name"]: site for site in YA.solar_eya()}

    assert solar["Bikaner II"]["plevels"]["P50"]["mwh_y1"] == 165349.0
    assert solar["Bikaner III"]["plevels"]["P50"]["mwh_y1"] == 653237.0
    assert 100 * solar["Bikaner II"]["plevels"]["P50"]["ac_cuf"] == pytest_approx(31.46, abs=0.01)
    assert 100 * solar["Bikaner III"]["plevels"]["P50"]["ac_cuf"] == pytest_approx(31.07, abs=0.01)
    assert solar["Bikaner II"]["plevels"]["P90"]["mwh_y1"] < solar["Bikaner II"]["plevels"]["P75"]["mwh_y1"]


def test_bess_schedules_include_year_11_reset():
    bess = {item["spec"]["name"]: item["schedule"] for item in YA.bess_tables(years=20)}

    b540 = bess["Bikaner III BESS (540 MWh)"]
    b200 = bess["Bikaner II BESS (200 MWh)"]
    assert b540.loc[b540["Year"] == 1, "SoH (%)"].iloc[0] == 100.0
    assert b540.loc[b540["Year"] == 10, "SoH (%)"].iloc[0] < 85.0
    assert b540.loc[b540["Year"] == 11, "SoH (%)"].iloc[0] == 100.0
    assert b200.loc[b200["Year"] == 11, "SoH (%)"].iloc[0] == 100.0


def test_eya_project_matches_report_portfolio():
    project = YA.eya_project()
    capacity = E.project_capacity_summary(project)
    peak_hours = set(project.tender.fixed_morning_peak_hours) | set(project.tender.fixed_evening_peak_hours)

    assert capacity["contracted_capacity_mw"] == 250.0
    assert capacity["wind_mw"] == pytest_approx(50.4)
    assert capacity["solar_ac_mw"] == pytest_approx(300.0)
    assert capacity["solar_dc_mwp"] == pytest_approx(450.0)
    assert capacity["bess_power_mw"] == pytest_approx(185.0)
    assert capacity["bess_energy_mwh"] == pytest_approx(740.0)
    assert peak_hours == {18, 19, 20, 21}


def test_hybrid_eya_outputs_are_stable_and_conservative():
    project = YA.eya_project()
    results = YA.hybrid_eya(project, years=(1, 5, 10, 15, 20), horizon=20)
    summary = YA.hybrid_summary_table(results)
    p50 = summary.set_index("Particulars")["P50"]
    p90 = summary.set_index("Particulars")["P90"]

    assert p50["Energy sold under PPA (GWh)"] == pytest_approx(852.65, abs=1.0)
    assert p50["Energy sold under PPA (GWh)"] < 907.3
    assert (907.3 - p50["Energy sold under PPA (GWh)"]) / 907.3 < 0.07
    assert p90["Energy sold under PPA (GWh)"] < p50["Energy sold under PPA (GWh)"]
    assert p50["RE supply to ESS (GWh)"] == pytest_approx(276.66, abs=1.0)
    assert p50["Shortfall on monthly availability (GWh)"] > 0.0


def test_hybrid_eya_full_25_year_ppa_run_is_stable():
    project = YA.eya_project()
    results = YA.hybrid_eya(project, levels=("P50",), years=tuple(range(1, 26)), horizon=25)
    summary = YA.hybrid_summary_table(results).set_index("Particulars")["P50"]

    assert len(results["P50"]["yearly"]) == 25
    assert summary["Energy sold under PPA (GWh)"] == pytest_approx(848.1, abs=1.0)
    assert summary["Energy sold under PPA (GWh)"] < 907.3
    assert summary["RE supply to ESS (GWh)"] > 250.0


def test_pvsyst_text_parser_extracts_solar_cuf_inputs():
    text = """
PVsyst V8.1.4
Project: NHPC Bikaner
Variant: New simulation variant
Geographical Site
Bikaner Solar1
India
Latitude
Longitude
Altitude
Time zone
28.1600
72.9600
178
UTC+5.5
Weather data
Bikaner Solar1
Meteonorm 9.0 dll, Sat=100% - Synthetic
System power: 90.00 MWp
Inverters
Nb. of units
Total power
Pnom ratio
14
61600
1.46
units
kWac
Produced Energy 153429330 kWh/year Specific production 1705 kWh/kWp/year Perf. Ratio PR
Bifacial perf. ratio
77.02
74.94
Balances and main results
GlobHor DiffHor T_Amb GlobInc GlobEff EArray E_Grid PR PRBifi
kWh/m2 kWh/m2 C kWh/m2 kWh/m2 kWh kWh ratio ratio
January 119.6 37.6 15.03 171.9 148.7 12173194 11183747 0.723 0.717
Year 1982.9 797.5 27.28 2213.6 2021.5 160076466 153429330 0.770 0.749
"""
    report = YA.parse_pvsyst_text(text, source_name="sample.pdf")
    converted = YA.pvsyst_to_solar_site(report, YA.SOLAR_SITES_DEFAULTS[0], name="Bikaner II")

    assert report["project"] == "NHPC Bikaner"
    assert report["site"] == "Bikaner Solar1"
    assert report["dc_mwp"] == pytest_approx(90.0)
    assert report["ac_mw"] == pytest_approx(61.6)
    assert report["p50_mwh_y1"] == pytest_approx(153429.33)
    assert report["ghi_kwh_m2"] == pytest_approx(1982.9)
    assert 100 * report["ac_cuf"] == pytest_approx(28.43, abs=0.01)
    assert converted["p50_mwh_y1"] == pytest_approx(153429.33)
    assert converted["meteo"].startswith("PVsyst:")

    probability = YA.pvsyst_probability_table(report, uncertainty_pct=4.87)
    ptable = probability.set_index("P-level")
    assert ptable.loc["P75", "Generation Y1 (MWh)"] < ptable.loc["P50", "Generation Y1 (MWh)"]
    assert ptable.loc["P90", "Generation Y1 (MWh)"] < ptable.loc["P75", "Generation Y1 (MWh)"]
    assert ptable.loc["P75", "AC CUF %"] == pytest_approx(27.50, abs=0.02)
    assert ptable.loc["P90", "AC CUF %"] == pytest_approx(26.66, abs=0.02)

    sites = YA.apply_pvsyst_to_solar_sites(YA.SOLAR_SITES_DEFAULTS, report, "Bikaner II", level="P90")
    project = YA.eya_project(solar_res=sites)
    bikaner_ii_gen = next(g for g in project.generators if g.name == "Bikaner_II_Solar")
    assert bikaner_ii_gen.cuf == pytest_approx(ptable.loc["P90", "AC CUF %"] / 100.0)


def test_supplied_pvsyst_pdf_extracts_expected_nhpc_bikaner_values():
    pdf = Path("/Users/rachitagarwal/Downloads/NHPC Bikaner.pdf")
    if not pdf.exists():
        import pytest
        pytest.skip("Supplied NHPC Bikaner PVsyst PDF is not available on this machine.")

    report = YA.parse_pvsyst_pdf_bytes(pdf.read_bytes(), source_name=pdf.name)

    assert report["project"] == "NHPC Bikaner"
    assert report["dc_mwp"] == pytest_approx(90.0)
    assert report["ac_mw"] == pytest_approx(61.6)
    assert report["p50_mwh_y1"] == pytest_approx(153429.33)
    assert report["specific_yield_kwh_per_kwp"] == pytest_approx(1705.0)
    assert report["pr_pct"] == pytest_approx(77.02)
    assert report["ghi_kwh_m2"] == pytest_approx(1982.9)
    assert len(report["monthly"]) == 13


def test_second_supplied_pvsyst_pdf_extracts_independent_solar_site():
    pdf = Path("/Users/rachitagarwal/Downloads/NHPC Bikaner 1.pdf")
    if not pdf.exists():
        import pytest
        pytest.skip("Second supplied NHPC Bikaner PVsyst PDF is not available on this machine.")

    report = YA.parse_pvsyst_pdf_bytes(pdf.read_bytes(), source_name=pdf.name)

    assert report["project"] == "NHPC Bikaner 1"
    assert report["site"] == "NHPC Bikaner 2"
    assert report["dc_mwp"] == pytest_approx(360.0)
    assert report["ac_mw"] == pytest_approx(242.0)
    assert report["p50_mwh_y1"] == pytest_approx(607739.873)
    assert 100 * report["ac_cuf"] == pytest_approx(28.67, abs=0.01)


def test_engine_scales_individual_pvsyst_solar_generators():
    project = E.default_fdre2_project()
    scaled = E.scale_project(
        project,
        gen_Bikaner_II_Solar_ac_mw=80.0,
        gen_Bikaner_III_Solar_ac_mw=300.0,
    )
    gens = {g.name: g for g in scaled.generators}

    assert gens["Bikaner_II_Solar"].ac_mw == pytest_approx(80.0)
    assert gens["Bikaner_II_Solar"].dc_mwp == pytest_approx(120.0)
    assert gens["Bikaner_III_Solar"].ac_mw == pytest_approx(300.0)
    assert gens["Bikaner_III_Solar"].dc_mwp == pytest_approx(450.0)


def test_printable_html_report_contains_main_sections():
    wind = YA.wind_eya()
    solar = YA.solar_eya()
    bess = YA.bess_tables(years=20)
    results = YA.hybrid_eya(YA.eya_project(), years=(1, 5, 10, 15, 20), horizon=20)
    html = YA.build_html_report(wind, solar, bess, results, YA.HYBRID_DEFAULTS, "EYA_250MW_NHPC_FDRE")

    assert "Hybrid Energy Yield Assessment" in html
    assert "Wind EYA" in html
    assert "Solar EYA" in html
    assert "Battery energy storage" in html
    assert "Annexure - yearly results (P50)" in html


def pytest_approx(value, **kwargs):
    import pytest

    return pytest.approx(value, **kwargs)
