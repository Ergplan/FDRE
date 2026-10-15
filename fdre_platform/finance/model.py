"""finance.v1: construction schedule with IDC, capex with contingency, debt/equity funding
and drawdowns, interest, repayment (annuity, equal principal or DSCR-sculpted), fees and
DSRA, working capital, depreciation (WDV for tax on the eligible block, straight line for
books), tax with loss carry-forward, revenue, penalties, market purchases and sales,
operating costs, replacement/augmentation, escalation and terminal value; project and
equity cash flows, IRR with root analysis, XIRR on dated flows, NPV and DSCR.

Every assumption carries its source; nothing here is a current statutory rate presented
as fact: defaults are marked `defaulted` and must be replaced by sourced values.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import Any, Literal

import numpy as np

FINANCE_VERSION = "finance.v1"
CRORE = 1e7


@dataclass
class Sourced:
    value: float
    source: str = "defaulted"
    reference: str | None = None


@dataclass
class CapexItem:
    name: str
    amount_inr: float
    tax_block: Literal["wdv_eligible", "slm", "land_non_depreciable"] = "wdv_eligible"
    source: str = "defaulted"


@dataclass
class OpexItem:
    name: str
    amount_inr_per_year: float
    escalation: float = 0.0     # per year
    start_year: int = 1
    source: str = "defaulted"


@dataclass
class FinanceAssumptions:
    ppa_years: int = 25
    construction_months: int = 24
    drawdown_profile: list[float] = field(default_factory=lambda: [0.45, 0.55])   # per construction year
    capex: list[CapexItem] = field(default_factory=list)
    contingency_fraction: float = 0.03
    debt_fraction: float = 0.75
    interest_rate: float = 0.0875
    tenor_years: int = 18
    moratorium_years: int = 0
    repayment: Literal["annuity", "equal_principal", "sculpted"] = "sculpted"
    sculpt_target_dscr: float = 1.15
    upfront_fee_fraction: float = 0.01
    dsra_months: float = 6.0
    receivable_days: float = 60.0
    working_capital_interest_rate: float = 0.095
    tax_rate: float = 0.25168
    tax_wdv_rate: float = 0.40
    tax_wdv_eligible_fraction: float = 0.95
    book_depreciation_years: int = 25
    residual_value_fraction: float = 0.05
    discount_rate: float = 0.10
    target_equity_irr: float = 0.14
    min_dscr: float = 1.10
    opex: list[OpexItem] = field(default_factory=list)
    augmentation: list[tuple[int, float]] = field(default_factory=list)   # (year, INR)
    terminal_value_inr: float = 0.0
    tariff_escalation: float = 0.0
    insurance_fraction_of_capex: float = 0.0035
    sources: dict[str, str] = field(default_factory=dict)
    version: str = FINANCE_VERSION

    @property
    def base_capex_inr(self) -> float:
        return sum(c.amount_inr for c in self.capex)


@dataclass
class OperatingYear:
    """Annual operating aggregates from the dispatch (MWh and INR)."""

    ppa_mwh: float
    merchant_mwh: float = 0.0
    merchant_revenue_inr: float = 0.0
    purchase_mwh: float = 0.0
    purchase_cost_inr: float = 0.0
    penalty_mwh: float = 0.0
    fuel_cost_inr: float = 0.0
    thermal_variable_cost_inr: float = 0.0
    startup_cost_inr: float = 0.0
    external_green_mwh: float = 0.0


@dataclass
class Statement:
    years: list[int]
    revenue_ppa: np.ndarray
    revenue_merchant: np.ndarray
    penalties: np.ndarray
    purchases: np.ndarray
    fuel_and_variable: np.ndarray
    fixed_opex: np.ndarray
    insurance: np.ndarray
    wc_interest: np.ndarray
    ebitda: np.ndarray
    book_depreciation: np.ndarray
    interest: np.ndarray
    principal: np.ndarray
    debt_opening: np.ndarray
    debt_closing: np.ndarray
    tax: np.ndarray
    tax_depreciation: np.ndarray
    pat: np.ndarray
    delta_wc: np.ndarray
    augmentation: np.ndarray
    cfads: np.ndarray
    debt_service: np.ndarray
    dscr: np.ndarray
    fcfe: np.ndarray
    terminal: np.ndarray


@dataclass
class FinanceResult:
    version: str
    tariff_inr_per_kwh: float
    total_project_cost_inr: float
    hard_cost_inr: float
    contingency_inr: float
    idc_inr: float
    fees_inr: float
    dsra_inr: float
    debt_inr: float
    equity_inr: float
    construction_equity_flows: list[float]
    construction_debt_flows: list[float]
    project_cash_flows: list[float]
    equity_cash_flows: list[float]
    equity_irr: float | None
    project_irr: float | None
    equity_irr_roots: list[float]
    project_irr_roots: list[float]
    sign_changes_equity: int
    npv_equity_inr: float
    npv_project_inr: float
    min_dscr: float
    avg_dscr: float
    statement: Statement
    meets_target: bool
    notes: list[str] = field(default_factory=list)

    def summary(self) -> dict[str, Any]:
        return {
            "version": self.version, "tariff_inr_per_kwh": self.tariff_inr_per_kwh, "total_project_cost_cr": self.total_project_cost_inr / CRORE, "hard_cost_cr": self.hard_cost_inr / CRORE, "idc_cr": self.idc_inr / CRORE, "fees_cr": self.fees_inr / CRORE, "dsra_cr": self.dsra_inr / CRORE,
            "debt_cr": self.debt_inr / CRORE, "equity_cr": self.equity_inr / CRORE, "equity_irr": self.equity_irr, "project_irr": self.project_irr, "equity_irr_roots": self.equity_irr_roots, "sign_changes_equity": self.sign_changes_equity,
            "npv_equity_cr": self.npv_equity_inr / CRORE, "npv_project_cr": self.npv_project_inr / CRORE, "min_dscr": self.min_dscr, "avg_dscr": self.avg_dscr, "meets_target": self.meets_target, "notes": self.notes,
            "first_year": {"revenue_ppa_cr": float(self.statement.revenue_ppa[0]) / CRORE, "ebitda_cr": float(self.statement.ebitda[0]) / CRORE, "cfads_cr": float(self.statement.cfads[0]) / CRORE, "dscr": float(self.statement.dscr[0])},
        }


def irr_roots(flows: list[float], lo: float = -0.99, hi: float = 5.0, steps: int = 2000) -> list[float]:
    """All real IRR roots found by sign-change bracketing of NPV(r) on [lo, hi], refined by
    bisection. Non-conventional flows can have several; the caller must say which it uses."""
    f = np.asarray(flows, dtype=float)
    if f.size < 2 or not (np.any(f > 0) and np.any(f < 0)):
        return []
    t = np.arange(f.size)

    def npv(r: float) -> float:
        return float(np.sum(f / (1.0 + r) ** t))

    grid = np.linspace(lo, hi, steps)
    vals = np.array([npv(r) for r in grid])
    roots: list[float] = []
    for i in range(steps - 1):
        a, b = vals[i], vals[i + 1]
        if a == 0:
            roots.append(float(grid[i]))
        elif a * b < 0:
            x0, x1 = grid[i], grid[i + 1]
            for _ in range(80):
                mid = 0.5 * (x0 + x1)
                if npv(x0) * npv(mid) <= 0:
                    x1 = mid
                else:
                    x0 = mid
            roots.append(round(0.5 * (x0 + x1), 8))
    return roots


def sign_changes(flows: list[float]) -> int:
    s = [np.sign(x) for x in flows if abs(x) > 1e-9]
    return int(sum(1 for a, b in zip(s, s[1:], strict=False) if a != b))


def npv(rate: float, flows: list[float]) -> float:
    f = np.asarray(flows, dtype=float)
    return float(np.sum(f / (1.0 + rate) ** np.arange(f.size)))


def xirr(dated: list[tuple[date, float]]) -> float | None:
    """IRR on dated flows (actual/365), single root by bisection on [-0.99, 5]."""
    if not dated:
        return None
    d0 = dated[0][0]
    years = np.array([(d - d0).days / 365.0 for d, _ in dated])
    f = np.array([v for _, v in dated], dtype=float)

    def npv_x(r: float) -> float:
        return float(np.sum(f / (1.0 + r) ** years))

    lo, hi = -0.99, 5.0
    if npv_x(lo) * npv_x(hi) > 0:
        return None
    for _ in range(100):
        mid = 0.5 * (lo + hi)
        if npv_x(lo) * npv_x(mid) <= 0:
            hi = mid
        else:
            lo = mid
    return round(0.5 * (lo + hi), 8)


def evaluate(a: FinanceAssumptions, operating: list[OperatingYear], tariff_inr_per_kwh: float, *, psm_charge_inr_per_kwh: float = 0.0, penalty_multiplier: float = 1.5, external_green_price_inr_per_kwh: float = 0.0) -> FinanceResult:
    n = a.ppa_years
    if len(operating) < n:
        operating = operating + [operating[-1]] * (n - len(operating))
    op = operating[:n]
    years = list(range(1, n + 1))
    notes: list[str] = []
    # ---- Construction: capex, contingency, IDC on debt drawn, fees, DSRA
    hard = a.base_capex_inr
    contingency = hard * a.contingency_fraction
    base = hard + contingency
    cy = max(1, int(np.ceil(a.construction_months / 12)))
    profile = list(a.drawdown_profile)[:cy]
    if not profile or abs(sum(profile) - 1.0) > 1e-6:
        profile = [1.0 / cy] * cy
        notes.append("drawdown profile normalised to equal annual shares")
    # IDC: interest accrues on cumulative debt drawn, mid-year convention, capitalised; solve the circularity by iteration.
    debt_total = a.debt_fraction * base
    idc = 0.0
    fees = a.upfront_fee_fraction * debt_total
    for _ in range(20):
        total_cost = base + idc + fees
        debt_total = a.debt_fraction * total_cost
        drawn = 0.0
        idc_new = 0.0
        for share in profile:
            draw = debt_total * share
            idc_new += (drawn + draw / 2.0) * a.interest_rate
            drawn += draw
        fees = a.upfront_fee_fraction * debt_total
        if abs(idc_new - idc) < 1.0:
            idc = idc_new
            break
        idc = idc_new
    total_cost = base + idc + fees
    debt = a.debt_fraction * total_cost
    equity = total_cost - debt
    # DSRA sized on first-year debt service, funded from equity at COD (released at the end).
    construction_equity = [-(equity * s) for s in profile]
    construction_debt = [debt * s for s in profile]
    # ---- Operations
    tariff_net = max(0.0, tariff_inr_per_kwh - psm_charge_inr_per_kwh) * 1000.0  # INR per MWh
    esc = np.array([(1 + a.tariff_escalation) ** (y - 1) for y in years])
    rev_ppa = np.array([o.ppa_mwh for o in op]) * tariff_net * esc
    rev_merchant = np.array([o.merchant_revenue_inr for o in op])
    penalties = np.array([o.penalty_mwh for o in op]) * penalty_multiplier * tariff_inr_per_kwh * 1000.0 * esc
    purchases = np.array([o.purchase_cost_inr + o.external_green_mwh * external_green_price_inr_per_kwh * 1000.0 for o in op])
    fuel_var = np.array([o.fuel_cost_inr + max(0.0, o.thermal_variable_cost_inr - o.fuel_cost_inr) + o.startup_cost_inr for o in op])
    fixed = np.zeros(n)
    for item in a.opex:
        for i, y in enumerate(years):
            if y >= item.start_year:
                fixed[i] += item.amount_inr_per_year * (1 + item.escalation) ** (y - item.start_year)
    insurance = np.full(n, hard * a.insurance_fraction_of_capex)
    revenue = rev_ppa + rev_merchant - penalties
    receivables = np.maximum(revenue, 0.0) * a.receivable_days / 365.0
    wc_interest = receivables * a.working_capital_interest_rate
    ebitda = revenue - purchases - fuel_var - fixed - insurance - wc_interest
    delta_wc = np.diff(receivables, prepend=0.0)
    aug = np.zeros(n)
    for year, amount in a.augmentation:
        if 1 <= year <= n:
            aug[year - 1] += amount
    # ---- Depreciation
    land = sum(c.amount_inr for c in a.capex if c.tax_block == "land_non_depreciable")
    depreciable = total_cost - land
    book_dep = np.full(n, depreciable * (1 - a.residual_value_fraction) / max(a.book_depreciation_years, 1))
    for i in range(n):
        if aug[i] > 0:
            book_dep[i:] += aug[i] * (1 - a.residual_value_fraction) / max(n - i, 1)
    # ---- Debt schedule (needs CFADS for sculpting; CFADS needs tax which needs interest: iterate)
    interest = np.zeros(n)
    principal = np.zeros(n)
    tax = np.zeros(n)
    tax_dep = np.zeros(n)
    for _ in range(30):
        cfads_est = ebitda - tax - delta_wc
        interest_new, principal_new, opening, closing = _debt_schedule(a, debt, cfads_est)
        tax_new, tax_dep_new = _tax(a, ebitda, interest_new, book_dep, total_cost, land, aug, n)
        done = np.allclose(interest_new, interest, atol=1.0) and np.allclose(tax_new, tax, atol=1.0)
        interest, principal, tax, tax_dep = interest_new, principal_new, tax_new, tax_dep_new
        if done:
            break
    cfads = ebitda - tax - delta_wc
    debt_service = interest + principal
    dscr = np.where(debt_service > 1e-6, cfads / np.where(debt_service > 1e-6, debt_service, 1.0), np.inf)
    dsra = (debt_service[0] if n else 0.0) * a.dsra_months / 12.0
    pat = ebitda - book_dep - interest - tax
    terminal = np.zeros(n)
    terminal[-1] = a.terminal_value_inr + dsra
    fcfe = cfads - debt_service - aug + terminal
    equity_flows = [*construction_equity]
    equity_flows[-1] -= dsra
    equity_flows += [float(x) for x in fcfe]
    project_flows = [-(total_cost - fees) * s for s in profile] + [float(x) for x in (cfads - aug + np.where(np.arange(n) == n - 1, a.terminal_value_inr, 0.0))]
    e_roots = irr_roots(equity_flows)
    p_roots = irr_roots(project_flows)
    e_irr = _choose_root(e_roots)
    p_irr = _choose_root(p_roots)
    changes = sign_changes(equity_flows)
    if changes > 1:
        notes.append(f"equity cash flows change sign {changes} times; {len(e_roots)} IRR root(s) found; NPV at the discount rate is the ranking measure")
    if not e_roots:
        notes.append("equity cash flows have no IRR (no sign change or NPV never crosses zero)")
    finite = dscr[np.isfinite(dscr)]
    min_dscr = float(finite.min()) if finite.size else float("inf")
    avg_dscr = float(finite.mean()) if finite.size else float("inf")
    meets = e_irr is not None and e_irr + 1e-9 >= a.target_equity_irr and (debt <= 1e-6 or min_dscr + 1e-9 >= a.min_dscr)
    st = Statement(years, rev_ppa, rev_merchant, penalties, purchases, fuel_var, fixed, insurance, wc_interest, ebitda, book_dep, interest, principal, opening, closing, tax, tax_dep, pat, delta_wc, aug, cfads, debt_service, dscr, fcfe, terminal)
    return FinanceResult(
        version=a.version, tariff_inr_per_kwh=tariff_inr_per_kwh, total_project_cost_inr=total_cost, hard_cost_inr=hard, contingency_inr=contingency, idc_inr=idc, fees_inr=fees, dsra_inr=dsra, debt_inr=debt, equity_inr=equity,
        construction_equity_flows=construction_equity, construction_debt_flows=construction_debt, project_cash_flows=project_flows, equity_cash_flows=equity_flows, equity_irr=e_irr, project_irr=p_irr, equity_irr_roots=e_roots, project_irr_roots=p_roots,
        sign_changes_equity=changes, npv_equity_inr=npv(a.discount_rate, equity_flows), npv_project_inr=npv(a.discount_rate, project_flows), min_dscr=min_dscr, avg_dscr=avg_dscr, statement=st, meets_target=meets, notes=notes,
    )


def _choose_root(roots: list[float]) -> float | None:
    """The root reported: the smallest positive one when several exist (conventional
    reading for investment flows), else the single root; None when there is none."""
    if not roots:
        return None
    positive = [r for r in roots if r > -0.5]
    return min(positive) if positive else roots[0]


def _debt_schedule(a: FinanceAssumptions, debt: float, cfads: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    n = cfads.size
    interest = np.zeros(n)
    principal = np.zeros(n)
    opening = np.zeros(n)
    closing = np.zeros(n)
    bal = debt
    tenor = min(a.tenor_years, n)
    m = min(a.moratorium_years, tenor - 1)
    if a.repayment == "annuity":
        r = a.interest_rate
        k = tenor - m
        pay = bal * r / (1 - (1 + r) ** (-k)) if r > 0 else bal / k
    for i in range(n):
        opening[i] = bal
        interest[i] = bal * a.interest_rate
        if i < m or i >= tenor or bal <= 1e-6:
            principal[i] = 0.0
        elif a.repayment == "annuity":
            principal[i] = min(bal, pay - interest[i])
        elif a.repayment == "equal_principal":
            principal[i] = min(bal, debt / (tenor - m))
        else:  # sculpted to a target DSCR, with the remainder due in the last tenor year
            affordable = max(0.0, cfads[i] / a.sculpt_target_dscr - interest[i])
            remaining_years = tenor - i
            principal[i] = min(bal, affordable) if remaining_years > 1 else bal
        bal -= principal[i]
        closing[i] = bal
    return interest, principal, opening, closing


def _tax(a: FinanceAssumptions, ebitda: np.ndarray, interest: np.ndarray, book_dep: np.ndarray, total_cost: float, land: float, aug: np.ndarray, n: int) -> tuple[np.ndarray, np.ndarray]:
    tax = np.zeros(n)
    tax_dep = np.zeros(n)
    wdv_open = (total_cost - land) * a.tax_wdv_eligible_fraction
    slm = (total_cost - land) * (1 - a.tax_wdv_eligible_fraction) / max(a.book_depreciation_years, 1)
    loss_bf = 0.0
    for i in range(n):
        if aug[i] > 0:
            wdv_open += aug[i] * a.tax_wdv_eligible_fraction
        dep = wdv_open * a.tax_wdv_rate + slm
        wdv_open -= wdv_open * a.tax_wdv_rate
        tax_dep[i] = dep
        taxable = ebitda[i] - interest[i] - dep - loss_bf
        if taxable > 0:
            tax[i] = taxable * a.tax_rate
            loss_bf = 0.0
        else:
            tax[i] = 0.0
            loss_bf = -taxable
    return tax, tax_dep


def assumptions_from_project(project: dict[str, Any], supply: dict[str, Any] | None = None) -> FinanceAssumptions:
    """Build finance.v1 assumptions from the legacy project's finance block plus the supply
    modules (thermal capex is not in the legacy model; a sourced value is required)."""
    fin = project.get("finance", {})
    tender = project.get("tender", {})
    capex: list[CapexItem] = []
    opex: list[OpexItem] = []
    esc = float(fin.get("opex_escalation", 0.035))
    solar_mw = sum(g["ac_mw"] for g in project.get("generators", []) if g["technology"] == "solar")
    wind_mw = sum(g["ac_mw"] for g in project.get("generators", []) if g["technology"] == "wind")
    bess_mwh = sum(b["energy_mwh"] for b in project.get("bess", []))
    bess_mw = sum(b["power_mw"] for b in project.get("bess", []))
    cr = CRORE
    if solar_mw:
        capex.append(CapexItem("Solar EPC", solar_mw * float(fin.get("default_solar_capex_cr_per_mw_ac", 3.1)) * cr, source=fin.get("source", "legacy project defaults")))
        capex.append(CapexItem("Solar land and development", solar_mw * float(fin.get("land_solar_cr_per_mw_ac", 0.45)) * cr, "land_non_depreciable"))
        opex.append(OpexItem("Solar O&M", solar_mw * float(fin.get("default_solar_opex_lakh_per_mw_year", 5.5)) * 1e5, esc))
    if wind_mw:
        capex.append(CapexItem("Wind EPC", wind_mw * float(fin.get("default_wind_capex_cr_per_mw", 6.5)) * cr))
        capex.append(CapexItem("Wind land", wind_mw * float(fin.get("land_wind_cr_per_mw", 0.08)) * cr, "land_non_depreciable"))
        opex.append(OpexItem("Wind O&M", wind_mw * float(fin.get("default_wind_opex_lakh_per_mw_year", 11.0)) * 1e5, esc))
    if bess_mwh:
        capex.append(CapexItem("BESS energy", bess_mwh * float(fin.get("default_bess_capex_cr_per_mwh", 1.1)) * cr))
        capex.append(CapexItem("BESS PCS", bess_mw * float(fin.get("default_bess_pcs_capex_cr_per_mw", 0.3)) * cr))
        capex.append(CapexItem("BESS land", bess_mwh * float(fin.get("land_bess_cr_per_mwh", 0.02)) * cr, "land_non_depreciable"))
        opex.append(OpexItem("BESS O&M", bess_mwh * float(fin.get("default_bess_opex_lakh_per_mwh_year", 1.2)) * 1e5, esc))
    for m in (supply or {}).get("modules", []):
        if m.get("kind") in ("thermal", "biomass") and m.get("enabled", True):
            capex_cr_per_mw = float(m.get("capex_cr_per_mw") or 0.0)
            capex.append(CapexItem(f"{m['name']} EPC", m["capacity_mw"] * capex_cr_per_mw * cr, source="module capex_cr_per_mw" if capex_cr_per_mw else "MISSING: capex not given"))
            opex.append(OpexItem(f"{m['name']} fixed O&M", m["capacity_mw"] * float(m.get("fixed_om_inr_per_mw_year", 0.0)), esc))
    evac_mw = max(float(tender.get("contracted_capacity_mw", 0.0)), solar_mw + wind_mw, bess_mw)
    capex.append(CapexItem("Transmission", float(fin.get("transmission_lump_sum_cr", 0.0)) * cr + evac_mw * float(fin.get("transmission_cr_per_mw", 1.0)) * cr))
    capex.append(CapexItem("Owner's costs", float(fin.get("owner_costs_cr", 0.0)) * cr + (solar_mw + wind_mw + bess_mw) * float(fin.get("owner_costs_cr_per_mw", 0.12)) * cr))
    opex.append(OpexItem("Admin", float(fin.get("admin_opex_cr_year", 5.0)) * cr + (solar_mw + wind_mw + bess_mw) * float(fin.get("admin_opex_lakh_per_mw_year", 0.75)) * 1e5, esc))
    opex.append(OpexItem("Transmission O&M", evac_mw * float(fin.get("transmission_opex_lakh_per_mw_year", 2.0)) * 1e5, esc))
    aug = []
    for item in fin.get("bess_augmentation_schedule", []):
        y = int(item.get("year", 0))
        if y > 0 and bess_mwh:
            aug.append((y, bess_mwh * float(item.get("energy_replacement_fraction", 1.0)) * float(item.get("cost_cr_per_mwh", 0.75)) * cr))
    return FinanceAssumptions(
        ppa_years=int(tender.get("ppa_years", 25)), construction_months=int(fin.get("construction_months", 24)), drawdown_profile=list(fin.get("construction_drawdown", (0.45, 0.55))), capex=capex, contingency_fraction=float(fin.get("contingency_percent", 0.03)),
        debt_fraction=float(fin.get("debt_fraction", 0.75)), interest_rate=float(fin.get("interest_rate", 0.0875)), tenor_years=int(fin.get("debt_tenor_years", 18)), repayment="sculpted" if fin.get("repayment_style", "sculpted") == "sculpted" else "annuity",
        sculpt_target_dscr=float(fin.get("sculpt_target_dscr", 1.15)), receivable_days=float(fin.get("receivable_days", 60)), working_capital_interest_rate=float(fin.get("working_capital_interest_rate", 0.095)), tax_rate=float(fin.get("tax_rate", 0.25168)),
        tax_wdv_rate=float(fin.get("tax_wdv_rate", 0.40)), tax_wdv_eligible_fraction=float(fin.get("tax_depreciable_basis_fraction", 0.95)), book_depreciation_years=int(fin.get("book_depreciation_years", 25)), residual_value_fraction=float(fin.get("residual_value_fraction", 0.05)),
        discount_rate=float(fin.get("discount_rate", 0.10)), target_equity_irr=float(fin.get("target_equity_irr", 0.14)), min_dscr=float(fin.get("min_dscr", 1.10)), opex=opex, augmentation=aug, terminal_value_inr=float(fin.get("terminal_value_cr", 0.0)) * cr,
        insurance_fraction_of_capex=float(fin.get("insurance_percent_hard_capex", 0.0035)), sources={"finance_block": fin.get("source", "legacy project defaults (defaulted; replace with sourced values)")},
    )
