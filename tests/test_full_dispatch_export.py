import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import fdre_enterprise_engine as E


def test_full_term_dispatch_export_shapes():
    project = E.default_fdre2_project()
    project.tender.ppa_years = 2
    project.simulation.circular_soc_iterations = 1
    tables = E.full_term_dispatch_tables(project, include_hourly=True)
    assert set(tables) == {'annual', 'monthly', 'hourly'}
    assert len(tables['annual']) == 2
    assert len(tables['monthly']) == 24
    assert len(tables['hourly']) == 2 * E.HOURS_PER_YEAR
    assert {'year', 'hour_of_ppa', 'day_of_ppa', 'ppa_mwh', 'soc_mwh'}.issubset(tables['hourly'].columns)
    assert tables['hourly']['hour_of_ppa'].iloc[0] == 1
    assert tables['hourly']['hour_of_ppa'].iloc[-1] == 2 * E.HOURS_PER_YEAR
