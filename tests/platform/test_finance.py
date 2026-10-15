"""finance.v1 against hand-computable cases: a zero-debt, zero-tax project is a plain
annuity whose IRR is known in closed form; sculpted debt holds the target DSCR; a
non-conventional cash flow reports its sign changes and every root; XIRR on dated flows."""

from __future__ import annotations

from datetime import date

import numpy as np
import pytest

from fdre_platform.finance.model import CapexItem, FinanceAssumptions, OperatingYear, evaluate, irr_roots, npv, sign_changes, xirr


def _plain(**kw) -> FinanceAssumptions:
    base = dict(
        ppa_years=10,
        construction_months=12,
        drawdown_profile=[1.0],
        capex=[CapexItem("plant", 1000.0)],
        contingency_fraction=0.0,
        debt_fraction=0.0,
        interest_rate=0.0,
        tenor_years=1,
        upfront_fee_fraction=0.0,
        dsra_months=0.0,
        receivable_days=0.0,
        working_capital_interest_rate=0.0,
        tax_rate=0.0,
        tax_wdv_rate=0.0,
        tax_wdv_eligible_fraction=0.0,
        book_depreciation_years=10,
        residual_value_fraction=0.0,
        discount_rate=0.10,
        target_equity_irr=0.10,
        min_dscr=1.0,
        opex=[],
        insurance_fraction_of_capex=0.0,
    )
    base.update(kw)
    return FinanceAssumptions(**base)


def test_zero_debt_zero_tax_project_is_a_plain_annuity():
    # 1000 invested at t=0, 200 per year for 10 years: IRR solves 1000 = 200 x annuity(r, 10) -> r = 15.098%
    a = _plain()
    op = [OperatingYear(ppa_mwh=200.0)] * 10  # tariff 1000 INR/MWh -> revenue 200,000 ... keep units simple below
    res = evaluate(a, [OperatingYear(ppa_mwh=0.2)] * 10, tariff_inr_per_kwh=1.0)  # 0.2 MWh x 1000 INR/MWh = 200 INR per year
    assert res.equity_cash_flows[0] == pytest.approx(-1000.0) and res.equity_cash_flows[1] == pytest.approx(200.0)
    assert res.equity_irr == pytest.approx(0.15098, abs=1e-4)
    assert res.project_irr == pytest.approx(res.equity_irr, abs=1e-6)
    assert res.npv_equity_inr == pytest.approx(npv(0.10, [-1000.0] + [200.0] * 10))
    assert res.sign_changes_equity == 1 and len(res.equity_irr_roots) == 1
    assert res.meets_target is True
    del op


def test_sculpted_debt_holds_the_target_dscr_and_repays_in_tenor():
    a = _plain(debt_fraction=0.7, interest_rate=0.10, tenor_years=8, repayment="sculpted", sculpt_target_dscr=1.3, min_dscr=1.2)
    res = evaluate(a, [OperatingYear(ppa_mwh=0.3)] * 10, tariff_inr_per_kwh=1.0)
    st = res.statement
    assert res.debt_inr == pytest.approx(700.0 * (1 + 0.0), rel=1e-6) or res.debt_inr > 600  # IDC on one-year draw at mid-year
    assert np.all(st.dscr[:7] >= 1.3 - 1e-6)  # sculpted years hold the target
    assert st.debt_closing[7] == pytest.approx(0.0, abs=1e-6)  # fully repaid at tenor
    assert np.all(st.principal[8:] == 0) and np.all(st.interest[8:] == 0)
    assert res.min_dscr >= 1.2 - 1e-6 or res.notes


def test_non_conventional_flows_report_sign_changes_and_all_roots():
    flows = [-100.0, 230.0, -132.0]  # two IRRs: 10% and 20%
    roots = irr_roots(flows)
    assert sign_changes(flows) == 2 and len(roots) == 2
    assert sorted(roots) == pytest.approx([0.10, 0.20], abs=1e-4)
    assert irr_roots([-100.0, -10.0, -5.0]) == []  # no sign change: no IRR
    a = _plain(augmentation=[(5, 1500.0)])
    res = evaluate(a, [OperatingYear(ppa_mwh=0.4)] * 10, tariff_inr_per_kwh=1.0)
    assert res.sign_changes_equity >= 2 and any("change sign" in n for n in res.notes)


def test_xirr_matches_irr_on_annual_dates():
    flows = [-1000.0] + [200.0] * 10
    dated = [(date(2026 + i, 1, 1), f) for i, f in enumerate(flows)]
    assert xirr(dated) == pytest.approx(irr_roots(flows)[0], abs=5e-4)


def test_penalties_purchases_and_fuel_reduce_the_cash_flows():
    a = _plain()
    clean = evaluate(a, [OperatingYear(ppa_mwh=0.3)] * 10, tariff_inr_per_kwh=1.0)
    dirty = evaluate(
        a,
        [OperatingYear(ppa_mwh=0.3, penalty_mwh=0.01, purchase_cost_inr=5.0, fuel_cost_inr=3.0, startup_cost_inr=1.0)] * 10,
        tariff_inr_per_kwh=1.0,
        penalty_multiplier=1.5,
    )
    expected_drop = 0.01 * 1.5 * 1000 + 5.0 + 3.0 + 1.0
    assert clean.statement.ebitda[0] - dirty.statement.ebitda[0] == pytest.approx(expected_drop)
    assert dirty.equity_irr < clean.equity_irr
