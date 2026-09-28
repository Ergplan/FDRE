import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import enterprise_fdre_engine as E


def test_default_capacity_summary_alias_import():
    project = E.default_fdre2_project()
    summary = E.project_capacity_summary(project)
    assert summary['solar_ac_mw'] == 300.0
    assert summary['wind_mw'] == 31.5
    assert summary['bess_power_mw'] == 185.0
    assert summary['bess_usable_poi_mwh_y1'] == 700.0
    expected_final_usable = sum(b.usable_for_year(project.tender.ppa_years) for b in project.bess)
    assert math.isclose(summary['bess_usable_poi_mwh_final'], expected_final_usable, rel_tol=0, abs_tol=1e-9)
    assert summary['bess_usable_poi_mwh_final'] < summary['bess_usable_poi_mwh_y1']
    assert math.isclose(summary['bess_nameplate_duration_hours'], 4.0, rel_tol=0, abs_tol=1e-9)


def test_rfs_peak_target_four_hours_per_day():
    project = E.default_fdre2_project()
    profile = E.generation_profile(project, year=1)
    target = E.build_peak_target(project, profile)
    assert (target > 0).sum() == 365 * 4
    first_day_hours = [int(i) for i in range(24) if target[i] > 0]
    assert first_day_hours == [7, 8, 19, 20]
    assert sum(project.tender.morning_window[0] <= h < project.tender.morning_window[1] for h in first_day_hours) == 2
    assert sum(project.tender.evening_window[0] <= h < project.tender.evening_window[1] for h in first_day_hours) == 2
    assert max(b - a for a, b in zip(first_day_hours, first_day_hours[1:])) > 2


def test_security_amounts_match_rfs_formula():
    project = E.default_fdre2_project()
    emd, pbg = E.security_amounts_cr(project)
    raw_emd = 0.0928 * 300.0 + 0.1264 * 31.5 + 0.1464 * 185.0
    raw_pbg = 0.2320 * 300.0 + 0.3160 * 31.5 + 0.3660 * 185.0
    assert math.isclose(emd, min(raw_emd, 10.0), rel_tol=0, abs_tol=1e-9)
    assert math.isclose(pbg, raw_pbg, rel_tol=0, abs_tol=1e-9)
