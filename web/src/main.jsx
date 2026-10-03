"use client";
import React, { useEffect, useMemo, useRef, useState } from "react";
import TenderReview, { restoreTenderReviews, saveTenderReviews } from "./TenderReview";
import { flushActivity, startActivityTracker, trackEvent } from "./activity";
import * as echarts from "echarts";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  BatteryCharging,
  Calculator,
  CheckCircle2,
  CircleDollarSign,
  Clock3,
  CloudSun,
  Database,
  Download,
  FileText,
  FolderOpen,
  Lock,
  LogOut,
  Save,
  UserRound,
  Users,
  Gauge,
  LayoutDashboard,
  Loader2,
  MessageCircle,
  Play,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sun,
  Table2,
  TrendingUp,
  Upload,
  Wind,
  Zap,
} from "lucide-react";
import "./styles.css";
import { THEME_NAME } from "./chartTheme";
import RtcTab from "./rtc/RtcTab";
import BessTab from "./bess/BessTab";
import SaveDialog from "./scenarios/SaveDialog";
import Brand from "./Brand";
import { ALL_TAB_IDS, usesEngine } from "../lib/tabs";
import { authApi } from "./scenarios/client";

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `API error ${res.status}`);
  }
  return res.json();
}

async function downloadApiFile(path, body, fallbackName) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `API error ${res.status}`);
  }
  const blob = await res.blob();
  const disposition = res.headers.get("content-disposition") || "";
  const match = disposition.match(/filename="?([^"]+)"?/i);
  const name = match?.[1] || fallbackName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function pct(value, digits = 1) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "N/A";
  return `${(Number(value) * 100).toFixed(digits)}%`;
}

function pctRaw(value, digits = 1) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "N/A";
  return `${Number(value).toFixed(digits)}%`;
}

function num(value, digits = 1) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "N/A";
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: digits }).format(Number(value));
}

function cloneProjectWith(project, updates, { capacity = true, tender = true, finance = true } = {}) {
  const copy = structuredClone(project);
  if (tender) {
    if (updates.contractedCapacity !== undefined) copy.tender.contracted_capacity_mw = Number(updates.contractedCapacity);
    if (updates.declaredCuf !== undefined) copy.tender.declared_annual_cuf = Number(updates.declaredCuf) / 100;
    if (updates.externalSupport !== undefined) copy.tender.allow_external_green_purchase = Boolean(updates.externalSupport);
    if (updates.hardCompliance !== undefined) copy.finance.hard_compliance_required = Boolean(updates.hardCompliance);
    if (updates.hardCompliance !== undefined) {
      copy.tender.hard_monthly_peak_compliance = Boolean(updates.hardCompliance);
      copy.tender.hard_annual_cuf_compliance = Boolean(updates.hardCompliance);
    }
    const hasPeakScheduleInputs = updates.dispatchMorningPeakStart !== undefined
      || updates.dispatchMorningPeakEnd !== undefined
      || updates.dispatchEveningPeakStart !== undefined
      || updates.dispatchEveningPeakEnd !== undefined;
    if (hasPeakScheduleInputs || updates.useCustomDispatchRules) {
      const clampStartHour = (value, fallback) => Math.min(Math.max(Math.round(Number(value ?? fallback)), 0), 23);
      const clampEndHour = (value, fallback) => Math.min(Math.max(Math.round(Number(value ?? fallback)), 1), 24);
      const hourRange = (start, end) => Array.from({ length: Math.max(0, end - start) }, (_, i) => start + i).filter((h) => h >= 0 && h <= 23);
      const morningStart = clampStartHour(updates.dispatchMorningPeakStart, 8);
      const morningEnd = Math.max(morningStart + 1, clampEndHour(updates.dispatchMorningPeakEnd, 10));
      const eveningStart = clampStartHour(updates.dispatchEveningPeakStart, 18);
      const eveningEnd = Math.max(eveningStart + 1, clampEndHour(updates.dispatchEveningPeakEnd, 20));
      copy.tender.peak_schedule_mode = "fixed";
      copy.tender.morning_window = [morningStart, morningEnd];
      copy.tender.evening_window = [eveningStart, eveningEnd];
      copy.tender.fixed_morning_peak_hours = hourRange(morningStart, morningEnd);
      copy.tender.fixed_evening_peak_hours = hourRange(eveningStart, eveningEnd);
    }
    if (updates.useCustomDispatchRules) {
      copy.tender.peak_availability_floor = Math.max(0.90, Number(updates.dispatchPeakAvailability ?? 90) / 100);
      copy.tender.declared_annual_cuf = Math.max(0.40, Number(updates.dispatchMinCuf ?? 40) / 100);
      copy.tender.cuf_lower_tolerance = 0.0;
      copy.tender.hard_monthly_peak_compliance = true;
      copy.tender.hard_annual_cuf_compliance = true;
      copy.tender.allow_external_green_purchase = false;
    }
  }
  if (finance) {
    if (updates.debtFraction !== undefined) copy.finance.debt_fraction = Number(updates.debtFraction) / 100;
    if (updates.interestRate !== undefined) copy.finance.interest_rate = Number(updates.interestRate) / 100;
    if (updates.targetEquityIrr !== undefined) copy.finance.target_equity_irr = Number(updates.targetEquityIrr) / 100;
    if (updates.minDscr !== undefined) copy.finance.min_dscr = Number(updates.minDscr);
    if (updates.repaymentStyle !== undefined) copy.finance.repayment_style = updates.repaymentStyle;
    if (updates.sculptTargetDscr !== undefined) copy.finance.sculpt_target_dscr = Number(updates.sculptTargetDscr);
    if (updates.sizeDebtByDscr !== undefined) copy.finance.size_debt_by_dscr = Boolean(updates.sizeDebtByDscr);
    if (updates.solarCapexCrPerMw !== undefined) {
      const value = Number(updates.solarCapexCrPerMw);
      copy.finance.default_solar_capex_cr_per_mw_ac = value;
      copy.generators = copy.generators.map((g) => g.technology === "solar" ? { ...g, capex_cr_per_mw: value } : g);
    }
    if (updates.windCapexCrPerMw !== undefined) {
      const value = Number(updates.windCapexCrPerMw);
      copy.finance.default_wind_capex_cr_per_mw = value;
      copy.generators = copy.generators.map((g) => g.technology === "wind" ? { ...g, capex_cr_per_mw: value } : g);
    }
    if (updates.bessEnergyCapexCrPerMwh !== undefined) {
      const value = Number(updates.bessEnergyCapexCrPerMwh);
      copy.finance.default_bess_capex_cr_per_mwh = value;
      copy.bess = copy.bess.map((b) => ({ ...b, capex_cr_per_mwh: value }));
    }
    if (updates.bessPcsCapexCrPerMw !== undefined) {
      const value = Number(updates.bessPcsCapexCrPerMw);
      copy.finance.default_bess_pcs_capex_cr_per_mw = value;
      copy.bess = copy.bess.map((b) => ({ ...b, pcs_capex_cr_per_mw: value }));
    }
    if (updates.enableBessAugmentation !== undefined) {
      if (Boolean(updates.enableBessAugmentation)) {
        const startYear = Math.min(Math.max(Math.round(Number(updates.bessAugmentationStartYear ?? 6)), 2), Number(copy.tender?.ppa_years || 25));
        const annualPct = Math.max(0, Number(updates.bessAugmentationAnnualPct ?? 3)) / 100;
        const decline = Math.min(Math.max(Number(updates.bessAugmentationCostDeclinePct ?? 6) / 100, 0), 0.5);
        const floorCost = Math.max(0, Number(updates.bessAugmentationFloorCostCrPerMwh ?? 0.45));
        const baseCost = Number(updates.bessEnergyCapexCrPerMwh ?? copy.finance.default_bess_capex_cr_per_mwh ?? 1.1);
        const years = Array.from({ length: Math.max(0, Number(copy.tender?.ppa_years || 25) - startYear + 1) }, (_, i) => startYear + i);
        copy.finance.bess_augmentation_schedule = years.map((year) => ({
          year,
          energy_replacement_fraction: annualPct,
          cost_cr_per_mwh: Math.max(floorCost, baseCost * ((1 - decline) ** (year - 1))),
        }));
        copy.bess = copy.bess.map((b) => ({
          ...b,
          augmentation_years: years,
          energy_augmentation_schedule: years.map((year) => ({
            year,
            energy_mwh: Number(b.energy_mwh || 0) * annualPct,
            usable_mwh_at_poi: Number(b.usable_mwh_at_poi || 0) * annualPct,
          })),
        }));
      }
    }
    if (updates.landSolarCrPerMw !== undefined) copy.finance.land_solar_cr_per_mw_ac = Number(updates.landSolarCrPerMw);
    if (updates.landWindCrPerMw !== undefined) copy.finance.land_wind_cr_per_mw = Number(updates.landWindCrPerMw);
    if (updates.landBessCrPerMwh !== undefined) copy.finance.land_bess_cr_per_mwh = Number(updates.landBessCrPerMwh);
    if (updates.transmissionCrPerMw !== undefined) copy.finance.transmission_cr_per_mw = Number(updates.transmissionCrPerMw);
    if (updates.ownerCostsCrPerMw !== undefined) copy.finance.owner_costs_cr_per_mw = Number(updates.ownerCostsCrPerMw);
    if (updates.adminOpexCrYear !== undefined) copy.finance.admin_opex_cr_year = Number(updates.adminOpexCrYear);
    if (updates.adminOpexLakhPerMwYear !== undefined) copy.finance.admin_opex_lakh_per_mw_year = Number(updates.adminOpexLakhPerMwYear);
    if (updates.transmissionOpexLakhPerMwYear !== undefined) copy.finance.transmission_opex_lakh_per_mw_year = Number(updates.transmissionOpexLakhPerMwYear);
    if (updates.transmissionLossPercent !== undefined) copy.finance.transmission_loss_percent = Number(updates.transmissionLossPercent);
    if (updates.receivableDays !== undefined) copy.finance.receivable_days = Number(updates.receivableDays);
    if (updates.workingCapitalInterestRate !== undefined) copy.finance.working_capital_interest_rate = Number(updates.workingCapitalInterestRate) / 100;
  }
  if (capacity) {
    const solar = updates.enableSolar === false ? 0 : Number(updates.solarAcMw);
    const wind = updates.enableWind === false ? 0 : Number(updates.windMw);
    const bessPower = updates.enableBess === false ? 0 : Number(updates.bessPowerMw);
    const bessEnergy = updates.enableBess === false ? 0 : Number(updates.bessEnergyMwh);
    const solarCurrent = copy.generators.filter((g) => g.technology === "solar").reduce((a, g) => a + g.ac_mw, 0);
    const windCurrent = copy.generators.filter((g) => g.technology === "wind").reduce((a, g) => a + g.ac_mw, 0);
    copy.generators = copy.generators.map((g) => {
      const next = { ...g };
      if (g.technology === "solar" && solarCurrent > 0 && Number.isFinite(solar)) {
        const ratio = solar / solarCurrent;
        next.ac_mw = g.ac_mw * ratio;
        next.dc_mwp = g.dc_mwp * ratio;
      }
      if (g.technology === "wind" && windCurrent > 0 && Number.isFinite(wind)) {
        const ratio = wind / windCurrent;
        next.ac_mw = g.ac_mw * ratio;
        next.dc_mwp = g.dc_mwp * ratio;
      }
      return next;
    });
    const bpCurrent = copy.bess.reduce((a, b) => a + b.power_mw, 0);
    const beCurrent = copy.bess.reduce((a, b) => a + b.energy_mwh, 0);
    copy.bess = copy.bess.map((b) => ({
      ...b,
      power_mw: bpCurrent > 0 && Number.isFinite(bessPower) ? b.power_mw * bessPower / bpCurrent : b.power_mw,
      energy_mwh: beCurrent > 0 && Number.isFinite(bessEnergy) ? b.energy_mwh * bessEnergy / beCurrent : b.energy_mwh,
      usable_mwh_at_poi: beCurrent > 0 && Number.isFinite(bessEnergy) ? b.usable_mwh_at_poi * bessEnergy / beCurrent : b.usable_mwh_at_poi,
    }));
  }
  if (updates.bessRtePercent !== undefined || updates.bessDodPercent !== undefined || updates.bessAvailabilityPercent !== undefined) {
    const rte = updates.bessRtePercent === undefined ? null : Math.min(Math.max(Number(updates.bessRtePercent) / 100, 0.5), 1);
    const dod = updates.bessDodPercent === undefined ? null : Math.min(Math.max(Number(updates.bessDodPercent) / 100, 0), 1);
    const availability = updates.bessAvailabilityPercent === undefined ? null : Math.min(Math.max(Number(updates.bessAvailabilityPercent) / 100, 0), 1);
    copy.bess = copy.bess.map((b) => {
      const next = { ...b };
      if (rte !== null && Number.isFinite(rte)) {
        next.rte = rte;
        next.rte_curve = Array.isArray(next.rte_curve) && next.rte_curve.length ? next.rte_curve.map(() => rte) : [];
      }
      if (availability !== null && Number.isFinite(availability)) next.availability = availability;
      if (dod !== null && Number.isFinite(dod)) {
        next.usable_mwh_at_poi = Number(next.energy_mwh || 0) * dod;
        next.energy_augmentation_schedule = (next.energy_augmentation_schedule || []).map((item) => ({
          ...item,
          usable_mwh_at_poi: Number(item.energy_mwh || 0) * dod,
        }));
      }
      return next;
    });
  }
  return copy;
}

function financeOnlyUpdates(updates = {}) {
  const {
    contractedCapacity,
    solarAcMw,
    windMw,
    bessPowerMw,
    bessEnergyMwh,
    solarMinMw,
    solarMaxMw,
    windMinMw,
    windMaxMw,
    bessPowerMinMw,
    bessPowerMaxMw,
    bessEnergyMinMwh,
    bessEnergyMaxMwh,
    enableSolar,
    enableWind,
    enableBess,
    forceTwoHourBess,
    bessRtePercent,
    bessDodPercent,
    bessAvailabilityPercent,
    dispatchMinCuf,
    dispatchPeakAvailability,
    dispatchMorningPeakStart,
    dispatchMorningPeakEnd,
    dispatchEveningPeakStart,
    dispatchEveningPeakEnd,
    useCustomDispatchRules,
    tenderProcurementMw,
    ...financeUpdates
  } = updates;
  return financeUpdates;
}

function defaultScenarioInputs(settings = {}) {
  return {
    debtFraction: Number(settings.debtFraction ?? 75),
    interestRate: Number(settings.interestRate ?? 8.75),
    targetEquityIrr: Number(settings.targetEquityIrr ?? 14),
    minDscr: Number(settings.minDscr ?? 1.1),
    sculptTargetDscr: Number(settings.sculptTargetDscr ?? 1.1),
  };
}

function financeModelExplanationRows(settings = {}) {
  return [
    { Step: "1. Dispatch and energy", Calculation: "Hourly dispatch determines PPA MWh, merchant MWh, spill, peak shortfall and annual CUF for each PPA year.", Output: "Operating matrix used by tariff and compliance checks" },
    { Step: "2. Revenue", Calculation: "PPA revenue = PPA MWh x net tariff. Merchant revenue = merchant MWh x merchant price. Penalties and external green support are deducted.", Output: "Net revenue" },
    { Step: "3. Capex", Calculation: "Solar, wind, BESS energy, BESS PCS, land, transmission, owner costs, success charges, contingency and IDC are built from size-linked assumptions.", Output: "Total project cost, debt and equity base" },
    { Step: "4. Opex", Calculation: "Plant O&M, BESS O&M, admin opex, transmission O&M, insurance and transmission loss cost are escalated over the PPA.", Output: "Operating expenses" },
    { Step: "5. Working capital", Calculation: `Receivables = revenue x ${settings.receivableDays ?? 60} days / 365. WC interest uses ${settings.workingCapitalInterestRate ?? 9.5}% rate.`, Output: "WC interest and change in receivables" },
    { Step: "6. EBITDA and CFADS", Calculation: "EBITDA = net revenue - opex. CFADS = EBITDA - tax - change in working capital.", Output: "Cash available for debt service" },
    { Step: "7. Debt sizing", Calculation: "Debt is sculpted to DSCR capacity when enabled; otherwise it follows the selected debt fraction and repayment style.", Output: "Debt, interest, principal, DSCR" },
    { Step: "8. Tax", Calculation: "Tax uses WDV depreciation on eligible basis, book depreciation for P&L view, interest deduction and carried-forward losses.", Output: "Annual tax cash outflow" },
    { Step: "9. BESS augmentation", Calculation: "Scheduled future BESS augmentation is charged in the relevant year and deducted from equity cash flow.", Output: "Augmentation capex and physical usable BESS if enabled" },
    { Step: "10. Equity cash flow", Calculation: "FCFE = CFADS - debt service - augmentation. Initial equity is negative at COD.", Output: "Equity cash flow series" },
    { Step: "11. Tariff solve", Calculation: "The required tariff is found by bisection so equity IRR reaches the target while hard compliance and DSCR constraints are respected.", Output: "Required gross tariff, equity IRR, project IRR, min DSCR" },
  ];
}

function projectCapacity(project) {
  if (!project) return {};
  const solar = (project.generators || []).filter((g) => g.technology === "solar").reduce((a, g) => a + Number(g.ac_mw || 0), 0);
  const wind = (project.generators || []).filter((g) => g.technology === "wind").reduce((a, g) => a + Number(g.ac_mw || 0), 0);
  const bessPower = (project.bess || []).reduce((a, b) => a + Number(b.power_mw || 0), 0);
  const bessEnergy = (project.bess || []).reduce((a, b) => a + Number(b.energy_mwh || 0), 0);
  const contracted = Number(project.tender?.contracted_capacity_mw || 0);
  return { solar, wind, bessPower, bessEnergy, contracted };
}

function optimizerBoundsFromSettings(settings) {
  const contracted = Number(settings.contractedCapacity);
  return {
    wind_mw: settings.enableWind === false ? [0, 0] : [Number(settings.windMinMw), Number(settings.windMaxMw)],
    solar_ac_mw: settings.enableSolar === false ? [0, 0] : [Number(settings.solarMinMw), Number(settings.solarMaxMw)],
    bess_power_mw: settings.enableBess === false ? [0, 0] : [Number(settings.bessPowerMinMw), Number(settings.bessPowerMaxMw)],
    bess_energy_mwh: settings.enableBess === false ? [0, 0] : [Number(settings.bessEnergyMinMwh), Number(settings.bessEnergyMaxMwh)],
    contracted_capacity_mw: [contracted, contracted],
  };
}

function validateOptimizerBounds(bounds) {
  const labels = {
    solar_ac_mw: "Solar AC MW",
    wind_mw: "Wind MW",
    bess_power_mw: "BESS power MW",
    bess_energy_mwh: "BESS energy MWh",
    contracted_capacity_mw: "Bid / project contracted MW",
  };
  for (const [key, [lower, upper]] of Object.entries(bounds)) {
    if (!Number.isFinite(lower) || !Number.isFinite(upper)) {
      throw new Error(`${labels[key]} search bounds must be valid numbers.`);
    }
    if (lower < 0 || upper < 0) {
      throw new Error(`${labels[key]} search bounds cannot be negative.`);
    }
    if (upper < lower) {
      throw new Error(`${labels[key]} max must be greater than or equal to min. Current values: min ${lower}, max ${upper}.`);
    }
    if (key === "contracted_capacity_mw") {
      const multiple = 10;
      const rounded = Math.round(lower / multiple) * multiple;
      if (Math.abs(lower - rounded) > 1e-6) {
        throw new Error(`Contracted capacity must be in ${multiple} MW tender multiples. Current value: ${lower} MW.`);
      }
    }
  }
}

function boundsRows(bounds) {
  if (!bounds) return [];
  return [
    { Variable: "Solar AC MW", Minimum: num(bounds.solar_ac_mw[0], 1), Maximum: num(bounds.solar_ac_mw[1], 1) },
    { Variable: "Wind MW", Minimum: num(bounds.wind_mw[0], 1), Maximum: num(bounds.wind_mw[1], 1) },
    { Variable: "BESS MW", Minimum: num(bounds.bess_power_mw[0], 1), Maximum: num(bounds.bess_power_mw[1], 1) },
    { Variable: "BESS MWh", Minimum: num(bounds.bess_energy_mwh[0], 1), Maximum: num(bounds.bess_energy_mwh[1], 1) },
    { Variable: "Fixed contracted MW", Minimum: num(bounds.contracted_capacity_mw[0], 1), Maximum: num(bounds.contracted_capacity_mw[1], 1) },
  ];
}

function downloadJson(name, payload) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function downloadCsv(name, rows = []) {
  if (!rows.length) return;
  const cols = Object.keys(rows[0]);
  const escape = (value) => {
    const text = String(value ?? "");
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const csv = [cols.join(","), ...rows.map((row) => cols.map((col) => escape(row[col])).join(","))].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function annualGenerationMatrixRows(result) {
  return (result?.operating?.annual || []).map((row) => ({
    year: row.year,
    contracted_capacity_mw: result?.capacity?.contracted_capacity_mw ?? "",
    solar_mw: result?.capacity?.solar_ac_mw ?? "",
    wind_mw: result?.capacity?.wind_mw ?? "",
    bess_mw: result?.capacity?.bess_power_mw ?? "",
    bess_mwh: result?.capacity?.bess_energy_mwh ?? "",
    ppa_generation_gwh: Number(row.ppa_mwh || 0) / 1000,
    merchant_generation_gwh: Number(row.merchant_mwh || 0) / 1000,
    spill_gwh: Number(row.spill_mwh || 0) / 1000,
    penalty_gwh: Number(row.total_penalty_mwh || 0) / 1000,
    annual_cuf_percent: Number(row.annual_cuf || 0) * 100,
    annual_cuf_cap_utilization_percent: Number(row.annual_cuf_cap_utilization || 0) * 100,
    min_monthly_peak_availability_percent: Number(row.min_monthly_peak_availability || 0) * 100,
  }));
}

function KpiCard({ icon: Icon, label, value, detail, tone = "neutral" }) {
  return (
    <div className={`kpi kpi-${tone}`}>
      <div className="kpi-top">
        <span className="kpi-icon"><Icon size={18} /></span>
        <span>{label}</span>
      </div>
      <strong>{value}</strong>
      {detail && <small>{detail}</small>}
    </div>
  );
}

function DataTable({ rows = [], columns, maxRows = 14 }) {
  const data = rows.slice(0, maxRows);
  if (!data.length) return <div className="empty-chart">No table data available</div>;
  const cols = columns || Object.keys(data[0]);
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>{cols.map((c) => <th key={c}>{c.replaceAll("_", " ")}</th>)}</tr>
        </thead>
        <tbody>
          {data.map((row, idx) => (
            <tr key={idx}>
              {cols.map((c) => <td key={c}>{typeof row[c] === "number" ? num(row[c], Math.abs(row[c]) > 10 ? 1 : 3) : String(row[c] ?? "")}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MiniLine({ data = [], xKey = "year", yKey, floor, format = (v) => v, color = "#5ab4e8" }) {
  const points = data.filter((d) => Number.isFinite(Number(d[yKey])));
  if (!points.length) return <div className="empty-chart">No trend data</div>;
  const values = points.map((d) => Number(d[yKey]));
  const floorValue = Number.isFinite(Number(floor)) ? Number(floor) : null;
  const min = Math.min(...values, floorValue ?? Infinity);
  const max = Math.max(...values, floorValue ?? -Infinity);
  const span = Math.max(max - min, 0.0001);
  const w = 760;
  const h = 220;
  const pad = 26;
  const xy = points.map((d, i) => {
    const x = pad + (i / Math.max(points.length - 1, 1)) * (w - pad * 2);
    const y = h - pad - ((Number(d[yKey]) - min) / span) * (h - pad * 2);
    return [x, y, d];
  });
  const path = xy.map(([x, y], i) => `${i ? "L" : "M"} ${x} ${y}`).join(" ");
  const floorY = floorValue === null ? null : h - pad - ((floorValue - min) / span) * (h - pad * 2);
  return (
    <svg className="chart" viewBox={`0 0 ${w} ${h}`} role="img">
      <line x1={pad} y1={h - pad} x2={w - pad} y2={h - pad} className="axis" />
      {floorY !== null && <line x1={pad} y1={floorY} x2={w - pad} y2={floorY} className="floor" />}
      <path d={path} fill="none" stroke={color} strokeWidth="4" strokeLinecap="round" />
      {xy.map(([x, y, d]) => <circle key={d[xKey]} cx={x} cy={y} r="5" fill={color} />)}
      <text x={pad} y={18} className="chart-label">{format(max)}</text>
      <text x={pad} y={h - 32} className="chart-label">{format(min)}</text>
    </svg>
  );
}

function Bars({ data = [], keys, labels }) {
  if (!data.length) return <div className="empty-chart">No dispatch data</div>;
  const max = Math.max(1, ...data.flatMap((d) => keys.map((k) => Number(d[k]) || 0)));
  return (
    <div className="bar-grid">
      {data.slice(0, 24).map((d, idx) => (
        <div className="bar-slot" key={`${d.hour}-${idx}`}>
          <div className="bar-stack">
            {keys.map((key, i) => (
              <span
                key={key}
                className={`bar bar-${i}`}
                style={{ height: `${Math.max(2, ((Number(d[key]) || 0) / max) * 100)}%` }}
                title={`${labels[i]}: ${num(d[key])}`}
              />
            ))}
          </div>
          <small>{d.hour}</small>
        </div>
      ))}
    </div>
  );
}

function EChart({ option, height = 360 }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current) return undefined;
    const chart = echarts.init(ref.current, THEME_NAME, { renderer: "canvas" });
    chart.setOption(option);
    const resize = () => chart.resize();
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
      chart.dispose();
    };
  }, [option]);
  return <div className="echart" ref={ref} style={{ height }} />;
}

function Sidebar({ tabs, activeTab, setActiveTab, user, onSave, canSave, linked, allowed }) {
  return (
    <aside className="sidebar">
      <a href="/" className="brand sidebar-brand" aria-label="Joulewise FDRE home"><Brand /></a>

      <div className="side-section">
        <h3>Workspace</h3>
        <nav className="side-nav">
          {tabs.map(([id, Icon, label, tag]) => {
            const ok = allowed.has(id);
            return (
              <button
                key={id}
                className={`${activeTab === id ? "active" : ""} ${ok ? "" : "nav-locked"}`}
                onClick={() => setActiveTab(id)}
                title={ok ? undefined : "Contact Administrator for access"}
                aria-disabled={!ok}
              >
                {ok ? <Icon size={15} /> : <Lock size={15} />}
                <span className="nav-label">{label}{!ok && <small>Contact Administrator</small>}</span>
                {ok && tag && <span className="nav-tag">{tag}</span>}
              </button>
            );
          })}
        </nav>
      </div>

      <div className="side-section">
        <h3>Results</h3>
        <nav className="side-nav">
          <button type="button" onClick={onSave} disabled={!canSave} title={canSave ? "Save the FDRE settings and results" : "Run or evaluate a case first"}>
            <Save size={15} /> {linked ? `Save FDRE · v${linked.version + 1}` : "Save FDRE results"}
          </button>
          <a href="/scenarios"><FolderOpen size={15} /> Saved scenarios</a>
          {user?.role === "admin" && <a href="/admin/users"><Users size={15} /> Users</a>}
          {user?.role === "admin" && <a href="/admin/activity"><Activity size={15} /> Activity</a>}
        </nav>
        {linked && <p className="side-note">Open: {linked.name} · v{linked.version}</p>}
      </div>

      {user && (
        <div className="side-section side-user">
          <a href="/account" className="side-user-link"><UserRound size={15} /><span><strong>{user.name || user.email}</strong><small>{user.role}</small></span></a>
          <button type="button" className="rtc-icon-btn" title="Sign out" onClick={async () => { await flushActivity(); await authApi.logout().catch(() => {}); window.location.href = "/login"; }}><LogOut size={15} /></button>
        </div>
      )}
    </aside>
  );
}

function ResultHeader({ result, title, subtitle, loading, statusLabel }) {
  const cap = result?.capacity || {};
  const totals = result?.operating?.totals || {};
  const finance = result?.finance;
  const status = result?.status || {};
  const compliant = (status.reason || "ok") === "ok" && (status.total_penalty_mwh || 0) <= 1e-6;
  return (
    <>
      <section className="hero compact-hero">
        <div className="hero-copy">
          <div className="eyebrow"><LayoutDashboard size={16} /> {statusLabel}</div>
          <h1>{title}</h1>
          <p>{subtitle}</p>
        </div>
        <div className="hero-panel">
          <div>
            <small>Required gross tariff</small>
            <strong>{loading ? "Solving..." : result?.tariff_label || "Run solve"}</strong>
            <span className={compliant ? "pill pass" : "pill warn"}>{compliant ? "Tender pass" : "Review case"}</span>
          </div>
          <div className="hero-meter">
            <Gauge size={42} />
            <span>{pct(totals.min_peak_availability)}</span>
            <small>minimum peak availability</small>
          </div>
        </div>
      </section>
      <section className="kpi-grid">
        <KpiCard icon={CloudSun} label="Solar / Wind" value={`${num(cap.solar_ac_mw, 0)} / ${num(cap.wind_mw, 1)} MW`} detail="portfolio capacity" />
        <KpiCard icon={BatteryCharging} label="BESS" value={`${num(cap.bess_power_mw, 0)} MW / ${num(cap.bess_energy_mwh, 0)} MWh`} detail="power and nameplate energy" />
        <KpiCard icon={CircleDollarSign} label="Project cost" value={finance ? `Rs ${num(finance.total_project_cost_cr, 0)} cr` : "N/A"} detail="total project cost" />
        <KpiCard icon={TrendingUp} label="Equity IRR" value={finance ? pct(finance.equity_irr, 2) : "N/A"} detail="target financial output" />
        <KpiCard icon={ShieldCheck} label="Penalty energy" value={`${num(totals.penalty_gwh || 0, 2)} GWh`} detail={status.reason || "ok"} tone={compliant ? "good" : "warning"} />
      </section>
    </>
  );
}

function InputField({ settings, setSettings, name, label, type = "number", step }) {
  return (
    <label>
      {label}
      <input type={type} step={step} value={settings[name]} onChange={(e) => setSettings({ ...settings, [name]: e.target.value })} />
    </label>
  );
}

function SelectField({ settings, setSettings, name, label, children }) {
  return (
    <label>
      {label}
      <select value={settings[name]} onChange={(e) => setSettings({ ...settings, [name]: e.target.value })}>
        {children}
      </select>
    </label>
  );
}

function ToggleField({ settings, setSettings, name, label }) {
  return (
    <label className="toggle light-toggle">
      <input type="checkbox" checked={Boolean(settings[name])} onChange={(e) => setSettings({ ...settings, [name]: e.target.checked })} />
      {label}
    </label>
  );
}

function SliderField({ values, setValues, name, label, min, max, step = 1, suffix = "" }) {
  const value = Number(values[name] ?? min);
  return (
    <label className="range-field">
      <span>{label}</span>
      <strong>{num(value, step < 1 ? 2 : 1)}{suffix}</strong>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => setValues({ ...values, [name]: Number(e.target.value) })}
      />
    </label>
  );
}

function BoundsSliderField({
  settings,
  setSettings,
  minName,
  maxName,
  label,
  unit = "MW",
  ceiling,
  step = 1,
  disabled = false,
  disabledLabel = null,
}) {
  const minValue = Number(settings[minName] ?? 0);
  const maxValue = Number(settings[maxName] ?? 0);
  const sliderMax = Math.max(Number(ceiling || 0), minValue, maxValue, step);
  const digits = step < 1 ? 2 : step < 5 ? 1 : 0;

  function updateMin(next) {
    const value = Math.min(Number(next), maxValue);
    setSettings({ ...settings, [minName]: value });
  }

  function updateMax(next) {
    const value = Math.max(Number(next), minValue);
    setSettings({ ...settings, [maxName]: value });
  }

  return (
    <div className={`bounds-slider ${disabled ? "bounds-disabled" : ""}`}>
      <div className="bounds-slider-top">
        <span>{label}</span>
        <strong>{disabled ? (disabledLabel || `0 ${unit}`) : `${num(minValue, digits)}-${num(maxValue, digits)} ${unit}`}</strong>
      </div>
      <div className="bounds-rail">
        <input
          aria-label={`${label} minimum`}
          type="range"
          min="0"
          max={sliderMax}
          step={step}
          value={disabled ? 0 : minValue}
          disabled={disabled}
          onChange={(e) => updateMin(e.target.value)}
        />
        <input
          aria-label={`${label} maximum`}
          type="range"
          min="0"
          max={sliderMax}
          step={step}
          value={disabled ? 0 : maxValue}
          disabled={disabled}
          onChange={(e) => updateMax(e.target.value)}
        />
      </div>
      <div className="bounds-slider-scale">
        <span>0</span>
        <span>{num(sliderMax, digits)} {unit}</span>
      </div>
    </div>
  );
}

function CustomInputsPanel({ settings, setSettings, onEvaluate, loading }) {
  return (
    <article className="panel span-all">
      <header><h2>Custom case inputs</h2><span>Manual sizing and tender assumptions live here, not in the sidebar</span></header>
      <div className="form-grid">
        <InputField settings={settings} setSettings={setSettings} name="contractedCapacity" label="Contracted capacity MW" />
        <InputField settings={settings} setSettings={setSettings} name="declaredCuf" label="Declared annual CUF %" step="0.1" />
        <SelectField settings={settings} setSettings={setSettings} name="yearsMode" label="Operating solve mode">
          <option value="fast">Fast representative years</option>
          <option value="exact">Exact full PPA term</option>
        </SelectField>
        <InputField settings={settings} setSettings={setSettings} name="solarAcMw" label="Solar AC MW" step="5" />
        <InputField settings={settings} setSettings={setSettings} name="windMw" label="Wind MW" step="1" />
        <InputField settings={settings} setSettings={setSettings} name="bessPowerMw" label="BESS power MW" step="5" />
        <InputField settings={settings} setSettings={setSettings} name="bessEnergyMwh" label="BESS energy MWh" step="10" />
        <SelectField settings={settings} setSettings={setSettings} name="windLevel" label="Wind yield case">
          <option>P50</option><option>P75</option><option>P90</option>
        </SelectField>
        <SelectField settings={settings} setSettings={setSettings} name="solarLevel" label="Solar model input">
          <option>P50</option><option>P75</option><option>P90</option>
        </SelectField>
        <ToggleField settings={settings} setSettings={setSettings} name="hardCompliance" label="Hard compliance tariff" />
        <ToggleField settings={settings} setSettings={setSettings} name="externalSupport" label="External green support" />
        <ToggleField settings={settings} setSettings={setSettings} name="windProfile" label="Use Bikaner wind CSV" />
      </div>
      <div className="panel-actions">
        <button className="primary" onClick={onEvaluate} disabled={Boolean(loading)}>
          {loading ? <Loader2 className="spin" size={18} /> : <Play size={18} />} Evaluate custom case
        </button>
      </div>
    </article>
  );
}

function TenderUploadTab({ settings, setSettings }) {
  const [parser, setParser] = useState("auto");
  const [parsing, setParsing] = useState(false);
  const [documents, setDocuments] = useState(restoreTenderReviews);
  const [activeDocumentId, setActiveDocumentId] = useState(null);
  const [storageError, setStorageError] = useState("");
  const activeDocument = documents.find((doc) => doc.parsed.document_id === activeDocumentId) || documents.at(-1);
  const parseResult = activeDocument?.parsed;
  useEffect(() => {
    try {
      saveTenderReviews(documents);
      setStorageError("");
    } catch { setStorageError("Browser storage is full. Download your review JSON to retain these decisions."); }
  }, [documents]);
  const [parseError, setParseError] = useState("");
  const [tenderQuestion, setTenderQuestion] = useState("What are the key financial conditions?");
  const [tenderView, setTenderView] = useState("terms");

  async function parseTender(file) {
    if (!file) return;
    setParsing(true);
    setParseError("");
    try {
      const parsed = await api("/api/tender/parse", {
        parser,
        file: {
          name: file.name,
          content_base64: await fileToBase64(file),
        },
      });
      const sourceUrl = file.name.toLowerCase().endsWith(".pdf") ? URL.createObjectURL(file) : null;
      setDocuments((current) => {
        const existing = current.find((doc) => doc.parsed.document_id === parsed.document_id);
        if (existing?.sourceUrl) URL.revokeObjectURL(existing.sourceUrl);
        const entry = existing ? { ...existing, sourceUrl } : { parsed, sourceUrl, decisions: {}, audit: [], reviewer: "" };
        return [...current.filter((doc) => doc.parsed.document_id !== parsed.document_id), entry];
      });
      setActiveDocumentId(parsed.document_id);
    } catch (err) {
      setParseError(err.message);
    } finally {
      setParsing(false);
    }
  }

  const schema = parseResult?.tender_schema || {
    title: "FDRE tender intelligence",
    issuer: "Upload tender to identify issuer",
    rfs_no: "Not parsed",
    rfs_date: "",
    search_code: "",
    procurement_mw: settings.tenderProcurementMw,
    peak_supply_mwh: null,
    peak_hours: null,
    ppa_years: 25,
    location: "Anywhere in India / ISTS-connected basis",
    storage_required: true,
    procurement_type: "FDRE / firm renewable power",
  };
  const overviewRows = parseResult?.overview || [
    { Item: "Tender size", "Parsed detail": `${num(settings.tenderProcurementMw, 0)} MW`, "Bid impact": "Total procurement programme size; this project's fixed contracted capacity is set in Project Configuration" },
    { Item: "Procurement type", "Parsed detail": "FDRE / firm renewable power under TBCB", "Bid impact": "Optimize for lowest required tariff at target equity return and tender compliance" },
    { Item: "Location allowed", "Parsed detail": "Anywhere in India / ISTS-connected basis", "Bid impact": "Resource quality, evacuation cost and land cost should drive site strategy" },
    { Item: "PPA tenor", "Parsed detail": "25 years", "Bid impact": "Sets finance horizon, degradation exposure, debt tenor and BESS augmentation profile" },
  ];
  const technicalRows = parseResult?.technical || [
    { Aspect: "Peak-period supply", "Parsed detail": "90% monthly peak-period availability", "Bid strategy implication": "Main driver for BESS power/duration and hybrid resource mix" },
    { Aspect: "Annual CUF floor", "Parsed detail": `${settings.declaredCuf}% declared annual CUF`, "Bid strategy implication": "Controls bid capacity versus annual energy sold under PPA" },
    { Aspect: "Bid multiple", "Parsed detail": "10 MW", "Bid strategy implication": "Fixed contracted capacity must be entered in a valid tender multiple" },
    { Aspect: "External green support", "Parsed detail": settings.externalSupport ? "Yes" : "No", "Bid strategy implication": "If allowed, shortfalls can be priced instead of forced physical compliance" },
  ];
  const timelineRows = parseResult?.timeline || [
    { Milestone: "Tender issue / RfS date", "Parsed detail": "Upload tender to parse", "Bid impact": "Sets bid clock and clarification window" },
    { Milestone: "Bid submission deadline", "Parsed detail": "Upload tender to parse", "Bid impact": "Drives EPC quote validity and financing timetable" },
    { Milestone: "Scheduled commissioning", "Parsed detail": "Upload tender to parse", "Bid impact": "Controls module/turbine procurement and land readiness risk" },
  ];
  const commercialRows = parseResult?.commercial || [
    { Aspect: "Tariff objective", "Model treatment": "Lowest gross tariff that meets target equity IRR, DSCR and selected compliance settings", "Bid impact": "Prevents oversizing just to create energy surplus" },
    { Aspect: "Debt structure", "Model treatment": "DSCR-sculpted debt with optional debt sizing by DSCR capacity", "Bid impact": "Avoids inflated tariff caused by late-year DSCR pressure" },
    { Aspect: "Capex basis", "Model treatment": "Solar, wind, BESS, land and transmission costs scale with optimized size", "Bid impact": "Search bounds directly affect tariff through capex and opex" },
  ];
  const financialRows = parseResult?.financial || [
    { "Financial condition": "EMD / earnest money", "Extracted clause detail": "Upload tender to extract", "Bid impact": "Bid-stage guarantee/cash exposure.", Source: "N/A" },
    { "Financial condition": "PBG / performance security", "Extracted clause detail": "Upload tender to extract", "Bid impact": "Post-award bank guarantee exposure and cost.", Source: "N/A" },
    { "Financial condition": "Penalty / liquidated damages", "Extracted clause detail": "Upload tender to extract", "Bid impact": "Defines cost of non-compliance.", Source: "N/A" },
    { "Financial condition": "Payment security / PSM", "Extracted clause detail": "Upload tender to extract", "Bid impact": "Receivable risk and net tariff adjustment.", Source: "N/A" },
  ];
  const amendmentRows = parseResult?.amendments || [
    { "Document role": "Base tender", "Clause reference": "N/A", "Change type": "Upload tender to classify", "Impact summary": "Amendment/corrigendum tracking will appear here.", Source: "N/A" },
  ];
  const securityRows = parseResult?.security || [
    { Instrument: "EMD", Formula: "Upload tender to extract formula", "Validity / timing": "N/A", Clause: "N/A" },
    { Instrument: "PBG", Formula: "Upload tender to extract formula", "Validity / timing": "N/A", Clause: "N/A" },
  ];
  const eligibilityRows = parseResult?.eligibility || [
    { Requirement: "Financial eligibility", Threshold: "Upload tender to extract", "Bidder action": "Review after parsing", Clause: "N/A", Evidence: "N/A" },
  ];
  const riskRows = parseResult?.risk_flags || [
    { Severity: "Info", "Risk / opportunity": "Upload tender", "Bid implication": "Risk flags will appear after parsing.", Source: "N/A", Evidence: "N/A" },
  ];
  const ragRows = parseResult?.rag_sources || [];
  const ragStatus = parseResult?.rag_status;
  const questionTerms = tenderQuestion.toLowerCase().match(/[a-z0-9]{3,}/g) || [];
  const qaRows = ragRows
    .map((row) => {
      const text = `${row.Theme || ""} ${row.Snippet || ""}`.toLowerCase();
      const matches = questionTerms.reduce((sum, term) => sum + (text.includes(term) ? 1 : 0), 0);
      return { ...row, _matches: matches };
    })
    .filter((row) => row._matches > 0)
    .sort((a, b) => b._matches - a._matches)
    .slice(0, 4)
    .map(({ _matches, ...row }) => row);
  const primaryDeadline = timelineRows.find((r) => /submission/i.test(r.Milestone || ""))?.["Parsed detail"] || "Upload tender to parse";
  const procurementLabel = schema.peak_supply_mwh
    ? `${num(schema.peak_supply_mwh, 0)} MWh`
    : `${num(schema.procurement_mw || settings.tenderProcurementMw, 0)} MW`;
  const peakLabel = schema.peak_hours
    ? `${num(schema.procurement_mw, 0)} MW x ${num(schema.peak_hours, 0)} hrs`
    : `${num(schema.procurement_mw || settings.tenderProcurementMw, 0)} MW`;
  const activeRows = {
    terms: financialRows,
    scope: [...overviewRows, ...technicalRows],
    elig: eligibilityRows,
    risk: riskRows,
    dates: timelineRows,
    amend: amendmentRows,
  }[tenderView] || financialRows;
  const activeTitle = {
    terms: "Commercial Term Sheet",
    scope: "Scope & Technical Conditions",
    elig: "Eligibility Checklist",
    risk: "Risk & Deviations",
    dates: "Critical Dates",
    amend: "Amendments",
  }[tenderView];

  return (
    <section className="tender-intel">
      {documents.length > 0 && <label className="review-document-select">Review document<select value={activeDocument?.parsed.document_id || ""} onChange={(event) => setActiveDocumentId(event.target.value)}>{documents.map((doc) => <option key={doc.parsed.document_id} value={doc.parsed.document_id}>{doc.parsed.rag_status.amendment_role} | {doc.parsed.source_name}</option>)}</select></label>}
      {storageError && <div className="alert">{storageError}</div>}
      <article className="tender-hero">
        <div className="tender-upload-rail">
          <div className="eyebrow"><FileText size={16} /> ergOS tender intelligence</div>
          <h1>{schema.title}</h1>
          <p>{schema.issuer} {schema.rfs_no ? `| ${schema.rfs_no}` : ""} {schema.rfs_date ? `| ${schema.rfs_date}` : ""}</p>
          <label>Document extraction
            <select aria-label="Document extraction" value={parser} onChange={(e) => setParser(e.target.value)} disabled={parsing}>
              <option value="auto">Automatic (Docling when available)</option>
              <option value="docling">Docling (tables and OCR)</option>
              <option value="standard">Standard (fast text extraction)</option>
            </select>
          </label>
          <label className="tender-upload-card">
            <Upload size={24} />
            <strong>{parsing ? "Reading clauses..." : "Add tender / amendment"}</strong>
            <span>PDF, DOCX or text. Extraction creates a review draft; project inputs change only after approval.</span>
            <input type="file" disabled={parsing} accept=".pdf,.docx,.txt,application/pdf" onChange={(e) => { parseTender(e.target.files?.[0]); e.target.value = ""; }} />
          </label>
          {parseError && <div className="alert slim-alert">{parseError}</div>}
          {ragStatus?.extraction && <p className="note">Extraction: {ragStatus.extraction.engine} · {ragStatus.extraction.pages} pages</p>}
          {ragStatus?.extraction?.warning && <div className="alert slim-alert">{ragStatus.extraction.warning}</div>}
          <div className="mini-stack">
            <span className="pill pass">{ragStatus?.mode || "clause-aware extraction"}</span>
            <span className="pill warn">{ragStatus?.chunks || 0} chunks</span>
            <span className="pill warn">{ragStatus?.amendment_role || "base tender"}</span>
          </div>
        </div>
        <div className="tender-decision-band">
          <div>
            <span>Procurement quantum</span>
            <strong>{procurementLabel}</strong>
            <small>{peakLabel}</small>
          </div>
          <div>
            <span>Bid deadline</span>
            <strong>{primaryDeadline.length > 70 || ragStatus?.amendment_role === "amendment" ? "Review required" : primaryDeadline}</strong>
            <small>{schema.search_code || parseResult?.source_name || "Upload document"}</small>
          </div>
          <div>
            <span>Contract tenor</span>
            <strong>{schema.ppa_years ? `${schema.ppa_years} years` : "Not extracted"}</strong>
            <small>{schema.location}</small>
          </div>
        </div>
      </article>

      <div className="tender-stat-grid">
        <KpiCard icon={ShieldCheck} label="Storage condition" value={schema.storage_required ? "Required" : "Review"} detail={schema.procurement_type} />
        <KpiCard icon={CircleDollarSign} label="Bid securities" value={`${securityRows.length} items`} detail="EMD, PBG, fee formulas" />
        <KpiCard icon={AlertTriangle} label="Risk flags" value={`${riskRows.length}`} detail="Auto-graded from clauses" tone={riskRows.length > 1 ? "warning" : "good"} />
        <KpiCard icon={CheckCircle2} label="Eligibility checks" value={`${eligibilityRows.length}`} detail="Financial and submission requirements" />
      </div>

      <TenderReview document={activeDocument} documents={documents} onChange={(updated) => setDocuments((current) => current.map((doc) => doc.parsed.document_id === updated.parsed.document_id ? updated : doc))} onApply={(updates) => setSettings({ ...settings, ...updates })} />
      <div className="tender-workspace">
        <article className="panel tender-main-panel">
          <div className="tender-tabs">
            {[
              ["terms", "Terms"],
              ["scope", "Scope"],
              ["elig", "Eligibility"],
              ["risk", "Risk"],
              ["dates", "Dates"],
              ["amend", "Amendments"],
            ].map(([id, label]) => (
              <button key={id} className={tenderView === id ? "active" : ""} onClick={() => setTenderView(id)}>{label}</button>
            ))}
          </div>
          <header><h2>{activeTitle}</h2><span>Unreviewed extraction; verify values and source references above</span></header>
          <DataTable rows={activeRows} maxRows={16} />
        </article>

        <aside className="tender-side-rail">
          <article className="panel">
            <header><h2>Security Model</h2><span>Formula sheet</span></header>
            <DataTable rows={securityRows} maxRows={6} />
          </article>
          <article className="panel">
            <header><h2>Parsed Model Fields</h2><span>Editable downstream inputs</span></header>
            <DataTable rows={parseResult?.constraints || [
              { Constraint: "Monthly peak availability", "Parsed value": "90.0%", "Model field": "peak_availability_floor" },
              { Constraint: "Declared annual CUF", "Parsed value": `${settings.declaredCuf}%`, "Model field": "declared_annual_cuf" },
              { Constraint: "Bid capacity multiple", "Parsed value": "10 MW", "Model field": "project_mw_multiple" },
            ]} />
          </article>
        </aside>
      </div>

      <div className="tender-workspace">
        <article className="panel tender-main-panel">
          <header><h2>Tender RAG Evidence</h2><span>Retrieved snippets used for extraction</span></header>
          <p className="note">{ragStatus?.notes || "Upload a tender to see the source snippets used by the clause-aware retrieval layer."}</p>
          <DataTable rows={ragRows.length ? ragRows : [{ Theme: "No upload", Source: "N/A", Snippet: "Upload tender to build extraction evidence.", Score: "N/A" }]} maxRows={12} />
        </article>
        <aside className="tender-side-rail dark">
          <article className="ask-card">
            <header><h2>Tender Clause Q&A</h2><span>Clause-cited retrieval</span></header>
            <div className="inline-form inverse">
              <Search size={18} />
              <input value={tenderQuestion} onChange={(e) => setTenderQuestion(e.target.value)} placeholder="Ask about tariff, PBG, bid dates, CUF..." />
              <MessageCircle size={18} />
            </div>
            <DataTable rows={parseResult ? (qaRows.length ? qaRows : ragRows.slice(0, 4)) : [{ Theme: "Upload required", Source: "N/A", Snippet: "Upload a tender first, then ask a question.", Score: "N/A" }]} maxRows={4} />
            <p>Answers are retrieval snippets, not legal advice. Verify the cited clause before relying on it in the bid.</p>
          </article>
        </aside>
      </div>

      <article className="panel">
        <header><h2>Commercial & Bidding Strategy</h2><span>How clauses change the bid model</span></header>
        <DataTable rows={commercialRows} />
      </article>
    </section>
  );
}

function ProjectConfigurationTab({ settings, setSettings, result, defaults, project }) {
  const tables = result?.project_tables || defaults?.project_tables || {};
  const bounds = optimizerBoundsFromSettings(settings);
  const twoHourEnergyLabel = `${num(Number(settings.bessPowerMinMw || 0) * 2, 0)}-${num(Number(settings.bessPowerMaxMw || 0) * 2, 0)} MWh linked`;
  const bessRows = (project?.bess || []).map((b) => ({
    name: b.name,
    node: b.node,
    power_mw: b.power_mw,
    energy_mwh: b.energy_mwh,
    usable_mwh_at_poi: b.usable_mwh_at_poi,
    rte: b.rte,
    availability: b.availability,
  }));
  return (
    <>
      <section className="panel-grid">
        <article className="panel span-all">
          <header><h2>Project Configuration</h2><span>Editable inputs extracted from tender and project documents</span></header>
          <p className="note">This is the source of truth for tender constraints, site setup, technology eligibility and the fixed contracted capacity. The optimizer sizes solar, wind and BESS for this one bid capacity.</p>
          <DataTable rows={[
            { Item: "Tender procurement capacity", Value: `${num(settings.tenderProcurementMw, 0)} MW`, Meaning: "Total NHPC tranche size, not this project's bid size" },
            { Item: "Fixed contracted capacity", Value: `${num(settings.contractedCapacity, 0)} MW`, Meaning: "Exact bid capacity used for optimization and tariff solve" },
          ]} />
          <div className="form-grid">
            <InputField settings={settings} setSettings={setSettings} name="contractedCapacity" label="Contracted capacity MW" step="10" />
            <InputField settings={settings} setSettings={setSettings} name="declaredCuf" label="Declared annual CUF %" step="0.1" />
            <SelectField settings={settings} setSettings={setSettings} name="yearsMode" label="Operating solve mode">
              <option value="fast">Fast representative years</option>
              <option value="exact">Exact full PPA term</option>
            </SelectField>
            <InputField settings={settings} setSettings={setSettings} name="dispatchMorningPeakStart" label="Morning peak start hour" step="1" />
            <InputField settings={settings} setSettings={setSettings} name="dispatchMorningPeakEnd" label="Morning peak end hour" step="1" />
            <InputField settings={settings} setSettings={setSettings} name="dispatchEveningPeakStart" label="Evening peak start hour" step="1" />
            <InputField settings={settings} setSettings={setSettings} name="dispatchEveningPeakEnd" label="Evening peak end hour" step="1" />
            <ToggleField settings={settings} setSettings={setSettings} name="hardCompliance" label="Hard tender compliance" />
            <ToggleField settings={settings} setSettings={setSettings} name="externalSupport" label="Allow external green support" />
            <ToggleField settings={settings} setSettings={setSettings} name="enableSolar" label="Allow solar PV" />
            <ToggleField settings={settings} setSettings={setSettings} name="enableWind" label="Allow wind" />
            <ToggleField settings={settings} setSettings={setSettings} name="enableBess" label="Allow BESS" />
            <ToggleField settings={settings} setSettings={setSettings} name="forceTwoHourBess" label="Force 2-hour BESS in optimizer" />
          </div>
          <p className="note">Optimizer peak schedule uses these fixed hours. Defaults are 08:00-10:00 in the morning and 18:00-20:00 in the evening, i.e. two hourly blocks in each window.</p>
        </article>
        <article className="panel span-all">
          <header><h2>Technology Search Bounds</h2><span>Solar, wind and BESS ranges sent to HiGHS at fixed contracted capacity</span></header>
          <div className="bounds-grid">
            <BoundsSliderField
              settings={settings}
              setSettings={setSettings}
              minName="solarMinMw"
              maxName="solarMaxMw"
              label="Solar AC search range"
              unit="MW"
              ceiling={1000}
              step={5}
              disabled={!settings.enableSolar}
            />
            <BoundsSliderField
              settings={settings}
              setSettings={setSettings}
              minName="windMinMw"
              maxName="windMaxMw"
              label="Wind search range"
              unit="MW"
              ceiling={500}
              step={1}
              disabled={!settings.enableWind}
            />
            <BoundsSliderField
              settings={settings}
              setSettings={setSettings}
              minName="bessPowerMinMw"
              maxName="bessPowerMaxMw"
              label="BESS power search range"
              unit="MW"
              ceiling={500}
              step={5}
              disabled={!settings.enableBess}
            />
            <BoundsSliderField
              settings={settings}
              setSettings={setSettings}
              minName="bessEnergyMinMwh"
              maxName="bessEnergyMaxMwh"
              label="BESS energy search range"
              unit="MWh"
              ceiling={2000}
              step={10}
              disabled={!settings.enableBess || settings.forceTwoHourBess}
              disabledLabel={settings.forceTwoHourBess ? twoHourEnergyLabel : null}
            />
          </div>
          <p className="note">{settings.forceTwoHourBess ? "2-hour BESS mode is active: the optimizer fixes BESS MWh = 2 x BESS MW for every candidate. The energy slider is shown as linked output and the backend still checks that the selected BESS MWh bounds can support this duration." : "The table below is the exact optimizer payload. Disabled technologies are locked to 0-0 before the HiGHS seed and nonlinear dispatch evaluation run."}</p>
          <DataTable rows={boundsRows(bounds)} />
        </article>
        <article className="panel">
          <header><h2>Site Coordinates</h2><span>Portfolio locations</span></header>
          <DataTable rows={(defaults?.eya?.solar || []).map((s) => ({
            Site: s.name,
            Location: s.location || "Bikaner, Rajasthan",
            Latitude: s.lat || "-",
            Longitude: s.lon || "-",
            "Altitude m": s.altitude_m,
          }))} />
        </article>
        <article className="panel span-2">
          <header><h2>Grid Interconnection</h2><span>Node and injection constraints</span></header>
          <DataTable rows={tables.nodes || []} />
        </article>
        <article className="panel span-2">
          <header><h2>Technology Options</h2><span>Solar, wind and hybrid generation inputs</span></header>
          <DataTable rows={tables.generators || []} columns={["name", "technology", "node", "ac_mw", "dc_mwp", "cuf", "degradation_per_year", "availability"]} />
        </article>
        <article className="panel">
          <header><h2>BESS Operating Assumptions</h2><span>Efficiency, usable depth and availability</span></header>
          <div className="form-grid single-col-form">
            <InputField settings={settings} setSettings={setSettings} name="bessRtePercent" label="BESS round-trip efficiency %" step="0.1" />
            <InputField settings={settings} setSettings={setSettings} name="bessDodPercent" label="BESS DoD / usable energy %" step="0.1" />
            <InputField settings={settings} setSettings={setSettings} name="bessAvailabilityPercent" label="BESS availability %" step="0.1" />
          </div>
          <p className="note">DoD converts installed MWh into usable PoI MWh before SoH degradation. RTE controls charging losses. Availability derates usable BESS energy for dispatch.</p>
          <DataTable rows={bessRows.length ? bessRows : (tables.bess || [])} columns={["name", "node", "power_mw", "energy_mwh", "usable_mwh_at_poi", "rte", "availability"]} />
        </article>
      </section>
    </>
  );
}

function ComplianceTab({ result }) {
  const annual = result?.operating?.annual || [];
  const monthly = result?.first_year?.monthly || [];
  const checklist = result?.compliance || [];
  return (
    <section className="panel-grid">
      <article className="panel">
        <header><h2>Hard tender conditions</h2><span>Optimized output validation</span></header>
        <ul className="checks">
          {checklist.map((row) => (
            <li key={row.check} className={row.pass ? "" : "bad-check"}>
              {row.pass ? <CheckCircle2 /> : <AlertTriangle />} <span>{row.check}</span><small>{row.evidence}</small>
            </li>
          ))}
        </ul>
      </article>
      <article className="panel span-2">
        <header><h2>25-year compliance trend</h2><span>Peak availability with RfS floor</span></header>
        <EChart
          option={{
            tooltip: { trigger: "axis", valueFormatter: (v) => pct(v, 2) },
            legend: { top: 0 },
            grid: { left: 42, right: 24, top: 42, bottom: 36 },
            xAxis: { type: "category", data: annual.map((d) => `Y${d.year}`) },
            yAxis: { type: "value", axisLabel: { formatter: (v) => `${Math.round(v * 100)}%` } },
            series: [
              { name: "Peak availability", type: "line", smooth: true, symbolSize: 9, areaStyle: { opacity: 0.12 }, data: annual.map((d) => d.min_monthly_peak_availability) },
              { name: "RfS floor", type: "line", symbol: "none", lineStyle: { type: "dashed" }, data: annual.map(() => 0.9) },
            ],
          }}
          height={300}
        />
      </article>
      <article className="panel span-all">
        <header><h2>First-year monthly peak availability</h2><span>Month-by-month tender dashboard</span></header>
        <div className="month-grid">
          {monthly.map((m) => (
            <div key={m.month} className={(m.peak_availability || 0) >= 0.9 ? "month pass" : "month fail"}>
              <strong>{m.month_name}</strong>
              <span>{pct(m.peak_availability)}</span>
              <small>shortfall {num(m.peak_shortfall_mwh || 0, 0)} MWh</small>
            </div>
          ))}
        </div>
      </article>
    </section>
  );
}

function FinanceTab({ optimizedResult, financeResult, settings, setSettings, onFinanceRerun, loading }) {
  const result = financeResult || optimizedResult;
  const finance = result?.finance;
  return (
    <section className="panel-grid">
      <article className="panel span-all">
        <header><h2>Finance rerun inputs</h2><span>Change financial assumptions without changing optimized sizing</span></header>
        <div className="form-grid finance-form">
          <InputField settings={settings} setSettings={setSettings} name="debtFraction" label="Debt %" step="1" />
          <InputField settings={settings} setSettings={setSettings} name="interestRate" label="Debt rate %" step="0.05" />
          <InputField settings={settings} setSettings={setSettings} name="targetEquityIrr" label="Cost of equity %" step="0.25" />
          <InputField settings={settings} setSettings={setSettings} name="minDscr" label="Minimum DSCR" step="0.05" />
          <SelectField settings={settings} setSettings={setSettings} name="repaymentStyle" label="Debt repayment style">
            <option value="sculpted">Sculpted DSCR</option>
            <option value="annuity">Flat annuity</option>
          </SelectField>
          <InputField settings={settings} setSettings={setSettings} name="sculptTargetDscr" label="Debt sizing DSCR" step="0.05" />
          <ToggleField settings={settings} setSettings={setSettings} name="sizeDebtByDscr" label="Size debt by DSCR capacity" />
          <ToggleField settings={settings} setSettings={setSettings} name="hardCompliance" label="Hard compliance tariff" />
          <ToggleField settings={settings} setSettings={setSettings} name="externalSupport" label="External green support" />
        </div>
        <div className="panel-actions">
          <button className="primary" onClick={onFinanceRerun} disabled={Boolean(loading) || !optimizedResult}>
            {loading ? <Loader2 className="spin" size={18} /> : <Calculator size={18} />} Recalculate finance only
          </button>
        </div>
      </article>
      <article className="panel">
        <header><h2>Finance Rerun on Fixed Optimized Sizing</h2><span>Only financial assumptions change; solar, wind and BESS stay fixed</span></header>
        <div className="mix">
          <div><strong>{finance ? result.tariff_label : "Run finance rerun"}</strong><span>required gross tariff</span></div>
          <div><strong>{finance ? pct(finance.equity_irr, 2) : `${settings.targetEquityIrr}%`}</strong><span>equity IRR / cost of equity</span></div>
          <div><strong>{finance ? pct(finance.project_irr, 2) : "N/A"}</strong><span>project IRR</span></div>
          <div><strong>{finance ? `${num(finance.min_dscr, 2)}x` : "N/A"}</strong><span>minimum DSCR</span></div>
        </div>
      </article>
      <article className="panel span-all">
        <header><h2>Capex & Opex Assumptions</h2><span>Size-linked benchmark inputs used by the finance model</span></header>
        <p className="note">These inputs flow into the next optimizer run and the fixed-size finance rerun. EPC capex is written into each solar, wind and BESS asset before the backend solves tariff.</p>
        <div className="form-grid finance-form">
          <InputField settings={settings} setSettings={setSettings} name="solarCapexCrPerMw" label="Solar EPC Rs cr/MWac" step="0.05" />
          <InputField settings={settings} setSettings={setSettings} name="windCapexCrPerMw" label="Wind EPC Rs cr/MW" step="0.05" />
          <InputField settings={settings} setSettings={setSettings} name="bessEnergyCapexCrPerMwh" label="BESS energy EPC Rs cr/MWh" step="0.05" />
          <InputField settings={settings} setSettings={setSettings} name="bessPcsCapexCrPerMw" label="BESS PCS Rs cr/MW" step="0.05" />
          <ToggleField settings={settings} setSettings={setSettings} name="enableBessAugmentation" label="Annual BESS augmentation" />
          <InputField settings={settings} setSettings={setSettings} name="bessAugmentationStartYear" label="Augmentation start year" step="1" />
          <InputField settings={settings} setSettings={setSettings} name="bessAugmentationAnnualPct" label="Annual BESS add % of COD MWh" step="0.5" />
          <InputField settings={settings} setSettings={setSettings} name="bessAugmentationCostDeclinePct" label="BESS cost decline %/yr" step="0.5" />
          <InputField settings={settings} setSettings={setSettings} name="bessAugmentationFloorCostCrPerMwh" label="Future BESS cost floor Rs cr/MWh" step="0.05" />
          <InputField settings={settings} setSettings={setSettings} name="landSolarCrPerMw" label="Land solar Rs cr/MWac" step="0.01" />
          <InputField settings={settings} setSettings={setSettings} name="landWindCrPerMw" label="Land wind Rs cr/MW" step="0.01" />
          <InputField settings={settings} setSettings={setSettings} name="landBessCrPerMwh" label="Land BESS Rs cr/MWh" step="0.005" />
          <InputField settings={settings} setSettings={setSettings} name="transmissionCrPerMw" label="Transmission/connectivity Rs cr/MW" step="0.05" />
          <InputField settings={settings} setSettings={setSettings} name="ownerCostsCrPerMw" label="Owner costs Rs cr/MW" step="0.01" />
          <InputField settings={settings} setSettings={setSettings} name="adminOpexCrYear" label="Admin opex fixed Rs cr/yr" step="0.1" />
          <InputField settings={settings} setSettings={setSettings} name="adminOpexLakhPerMwYear" label="Admin opex Rs lakh/MW-yr" step="0.05" />
          <InputField settings={settings} setSettings={setSettings} name="transmissionOpexLakhPerMwYear" label="Transmission O&M Rs lakh/MW-yr" step="0.05" />
          <InputField settings={settings} setSettings={setSettings} name="transmissionLossPercent" label="Transmission loss cost %" step="0.05" />
          <InputField settings={settings} setSettings={setSettings} name="receivableDays" label="Receivable days" step="1" />
          <InputField settings={settings} setSettings={setSettings} name="workingCapitalInterestRate" label="Working capital interest %" step="0.05" />
        </div>
        <DataTable rows={[
          { Assumption: "Solar EPC", Value: `${settings.solarCapexCrPerMw} Rs cr/MWac`, Basis: "Scales with optimized solar AC MW and is used in optimizer objective/finance" },
          { Assumption: "Wind EPC", Value: `${settings.windCapexCrPerMw} Rs cr/MW`, Basis: "Scales with optimized wind MW and is used in optimizer objective/finance" },
          { Assumption: "BESS energy EPC", Value: `${settings.bessEnergyCapexCrPerMwh} Rs cr/MWh`, Basis: "Scales with optimized BESS MWh" },
          { Assumption: "BESS PCS", Value: `${settings.bessPcsCapexCrPerMw} Rs cr/MW`, Basis: "Scales with optimized BESS power MW" },
          { Assumption: "BESS augmentation", Value: settings.enableBessAugmentation ? `${settings.bessAugmentationAnnualPct}%/yr from Y${settings.bessAugmentationStartYear}` : "Default replacement schedule", Basis: settings.enableBessAugmentation ? `Future battery capex declines ${settings.bessAugmentationCostDeclinePct}%/yr to floor ${settings.bessAugmentationFloorCostCrPerMwh} Rs cr/MWh` : "Uses bundled year-11 augmentation profile" },
          { Assumption: "Land - solar", Value: `${settings.landSolarCrPerMw} Rs cr/MWac`, Basis: "Scales with optimized solar AC MW" },
          { Assumption: "Land - wind", Value: `${settings.landWindCrPerMw} Rs cr/MW`, Basis: "Scales with optimized wind MW" },
          { Assumption: "Land - BESS", Value: `${settings.landBessCrPerMwh} Rs cr/MWh`, Basis: "Scales with optimized BESS MWh" },
          { Assumption: "Transmission/connectivity", Value: `${settings.transmissionCrPerMw} Rs cr/MW`, Basis: "Scales with evacuation basis MW, capped by interconnection limit" },
          { Assumption: "Owner costs", Value: `${settings.ownerCostsCrPerMw} Rs cr/MW`, Basis: "Scales with solar + wind + BESS power MW" },
          { Assumption: "Admin opex", Value: `${settings.adminOpexCrYear} Rs cr/yr + ${settings.adminOpexLakhPerMwYear} lakh/MW-yr`, Basis: "Fixed plus size-linked annual cost" },
          { Assumption: "Transmission O&M/loss", Value: `${settings.transmissionOpexLakhPerMwYear} lakh/MW-yr + ${settings.transmissionLossPercent}% loss cost`, Basis: "Annual opex escalated with plant opex" },
          { Assumption: "Working capital", Value: `${settings.receivableDays} receivable days at ${settings.workingCapitalInterestRate}%`, Basis: "WC interest = positive revenue x receivable days / 365 x WC interest rate" },
        ]} />
      </article>
      <article className="panel span-all">
        <header><h2>How The Finance Model Works</h2><span>Calculation sheet logic</span></header>
        <DataTable rows={financeModelExplanationRows(settings)} maxRows={30} />
      </article>
      <article className="panel span-2">
        <header><h2>Finance table</h2><span>First 30 years / cashflow rows</span></header>
        <DataTable rows={finance?.table || []} maxRows={30} />
      </article>
      <article className="panel span-all">
        <header><h2>Capex components</h2><span>Rs crore</span></header>
        <div className="optimizer-vars">
          {Object.entries(finance?.capex_components || {}).map(([key, value]) => (
            <div key={key}><span>{key.replaceAll("_", " ")}</span><strong>{num(value, 1)}</strong></div>
          ))}
        </div>
      </article>
    </section>
  );
}

function sumBy(table = [], key) {
  return table.reduce((acc, row) => acc + (Number(row?.[key]) || 0), 0);
}

function cumulative(values = []) {
  let running = 0;
  return values.map((value) => {
    running += Number(value) || 0;
    return running;
  });
}

function FinancialStatementsTab({ optimizedResult, financeResult }) {
  const result = financeResult || optimizedResult;
  const finance = result?.finance;
  const table = finance?.table || [];
  const capexComponents = finance?.capex_components || {};

  if (!optimizedResult) {
    return (
      <section className="panel-grid">
        <article className="panel span-all">
          <header><h2>Financial Statements</h2><span>Run optimization first</span></header>
          <div className="empty-chart">Run the optimizer once to create the optimized tariff, finance table and statement graphs.</div>
        </article>
      </section>
    );
  }

  if (!finance || !table.length) {
    return (
      <section className="panel-grid">
        <article className="panel span-all">
          <header><h2>Financial Statements</h2><span>No solved finance case</span></header>
          <div className="empty-chart">Finance statements are unavailable because the current optimized case is infeasible or tariff could not be solved.</div>
        </article>
      </section>
    );
  }

  const years = table.map((d) => `Y${d.year}`);
  const statementRows = table.map((d) => {
    const grossRevenue = Number(d.revenue_ppa_cr || 0) + Number(d.revenue_merchant_cr || 0);
    const ebit = Number(d.ebitda_cr || 0) - Number(d.book_dep_cr || 0);
    const pbt = ebit - Number(d.interest_cr || 0);
    const pat = pbt - Number(d.tax_cr || 0);
    const debtService = Number(d.interest_cr || 0) + Number(d.principal_cr || 0);
    const fcfe = Number(d.fcfe_cr || 0);
    return {
      Year: d.year,
      "PPA revenue": d.revenue_ppa_cr,
      "Merchant revenue": d.revenue_merchant_cr,
      "Gross revenue": grossRevenue,
      Penalty: d.penalty_cr,
      "Green support cost": d.green_cost_cr,
      "Net revenue": d.revenue_net_cr,
      Opex: d.opex_cr,
      EBITDA: d.ebitda_cr,
      Depreciation: d.book_dep_cr,
      EBIT: ebit,
      Interest: d.interest_cr,
      PBT: pbt,
      Tax: d.tax_cr,
      PAT: pat,
      CFADS: d.cfads_cr,
      Principal: d.principal_cr,
      "Debt service": debtService,
      Augmentation: d.augmentation_cr,
      FCFE: fcfe,
      DSCR: d.dscr,
    };
  });
  const cumulativeFcfe = cumulative(table.map((d) => d.fcfe_cr));
  const statementWithCumulative = statementRows.map((row, idx) => ({
    ...row,
    "Cumulative FCFE": cumulativeFcfe[idx],
  }));

  const totalPpaRevenue = sumBy(table, "revenue_ppa_cr");
  const totalMerchantRevenue = sumBy(table, "revenue_merchant_cr");
  const totalPenalty = sumBy(table, "penalty_cr");
  const totalGreenCost = sumBy(table, "green_cost_cr");
  const totalNetRevenue = sumBy(table, "revenue_net_cr");
  const totalOpex = sumBy(table, "opex_cr");
  const totalEbitda = sumBy(table, "ebitda_cr");
  const totalTax = sumBy(table, "tax_cr");
  const totalInterest = sumBy(table, "interest_cr");
  const totalPrincipal = sumBy(table, "principal_cr");
  const totalAugmentation = sumBy(table, "augmentation_cr");
  const totalFcfe = sumBy(table, "fcfe_cr");
  const totalCapex = Number(finance.total_project_cost_cr || 0);
  const netMargin = totalNetRevenue > 0 ? totalEbitda / totalNetRevenue : 0;
  const averageDscr = Number(finance.avg_dscr);
  const minDscr = Number(finance.min_dscr);

  const revenueChart = {
    color: ["#5ab4e8", "#a98bff", "#ff6b5f", "#f5b83d"],
    tooltip: { trigger: "axis", valueFormatter: (v) => `Rs ${num(v, 1)} cr` },
    legend: { top: 0 },
    grid: { left: 58, right: 22, top: 48, bottom: 46 },
    xAxis: { type: "category", data: years },
    yAxis: { type: "value", name: "Rs cr", splitLine: { lineStyle: { color: "#242424" } } },
    dataZoom: [{ type: "inside" }, { type: "slider", height: 18, bottom: 8 }],
    series: [
      { name: "PPA revenue", type: "bar", stack: "revenue", data: table.map((d) => d.revenue_ppa_cr) },
      { name: "Merchant revenue", type: "bar", stack: "revenue", data: table.map((d) => d.revenue_merchant_cr) },
      { name: "Penalty", type: "bar", stack: "deductions", data: table.map((d) => -(Number(d.penalty_cr) || 0)) },
      { name: "Green support cost", type: "bar", stack: "deductions", data: table.map((d) => -(Number(d.green_cost_cr) || 0)) },
      { name: "Net revenue", type: "line", smooth: true, symbolSize: 6, data: table.map((d) => d.revenue_net_cr) },
    ],
  };

  const profitChart = {
    color: ["#5ab4e8", "#a98bff", "#f5b83d", "#ff6b5f", "#7ddc9a"],
    tooltip: { trigger: "axis", valueFormatter: (v) => `Rs ${num(v, 1)} cr` },
    legend: { top: 0 },
    grid: { left: 58, right: 22, top: 48, bottom: 46 },
    xAxis: { type: "category", boundaryGap: false, data: years },
    yAxis: { type: "value", name: "Rs cr", splitLine: { lineStyle: { color: "#242424" } } },
    dataZoom: [{ type: "inside" }, { type: "slider", height: 18, bottom: 8 }],
    series: [
      { name: "Net revenue", type: "line", smooth: true, symbol: "none", areaStyle: { opacity: 0.08 }, data: table.map((d) => d.revenue_net_cr) },
      { name: "Opex", type: "line", smooth: true, symbol: "none", data: table.map((d) => d.opex_cr) },
      { name: "EBITDA", type: "line", smooth: true, symbol: "none", areaStyle: { opacity: 0.10 }, data: table.map((d) => d.ebitda_cr) },
      { name: "Tax", type: "line", smooth: true, symbol: "none", data: table.map((d) => d.tax_cr) },
      { name: "PAT", type: "line", smooth: true, symbol: "none", data: statementRows.map((d) => d.PAT) },
    ],
  };

  const cashFlowChart = {
    color: ["#5ab4e8", "#a98bff", "#f5b83d", "#ff6b5f", "#7ddc9a"],
    tooltip: { trigger: "axis", valueFormatter: (v) => `Rs ${num(v, 1)} cr` },
    legend: { top: 0 },
    grid: { left: 58, right: 22, top: 48, bottom: 46 },
    xAxis: { type: "category", boundaryGap: false, data: years },
    yAxis: { type: "value", name: "Rs cr", splitLine: { lineStyle: { color: "#242424" } } },
    dataZoom: [{ type: "inside" }, { type: "slider", height: 18, bottom: 8 }],
    series: [
      { name: "CFADS", type: "line", smooth: true, symbol: "none", data: table.map((d) => d.cfads_cr) },
      { name: "Debt service", type: "line", smooth: true, symbol: "none", data: table.map((d) => (Number(d.interest_cr) || 0) + (Number(d.principal_cr) || 0)) },
      { name: "Augmentation", type: "bar", data: table.map((d) => d.augmentation_cr) },
      { name: "FCFE", type: "line", smooth: true, symbolSize: 7, data: table.map((d) => d.fcfe_cr) },
      { name: "Cumulative FCFE", type: "line", smooth: true, symbol: "none", areaStyle: { opacity: 0.08 }, data: cumulativeFcfe },
    ],
  };

  const debtChart = {
    color: ["#a98bff", "#5ab4e8", "#ff6b5f", "#f5b83d"],
    tooltip: { trigger: "axis" },
    legend: { top: 0 },
    grid: { left: 58, right: 58, top: 48, bottom: 46 },
    xAxis: { type: "category", data: years },
    yAxis: [
      { type: "value", name: "Rs cr", splitLine: { lineStyle: { color: "#242424" } } },
      { type: "value", name: "DSCR", min: 0, splitLine: { show: false } },
    ],
    dataZoom: [{ type: "inside" }, { type: "slider", height: 18, bottom: 8 }],
    series: [
      { name: "Interest", type: "bar", stack: "debt", data: table.map((d) => d.interest_cr) },
      { name: "Principal", type: "bar", stack: "debt", data: table.map((d) => d.principal_cr) },
      { name: "Tax", type: "bar", data: table.map((d) => d.tax_cr) },
      { name: "DSCR", type: "line", yAxisIndex: 1, smooth: true, symbolSize: 7, data: table.map((d) => Number.isFinite(Number(d.dscr)) ? d.dscr : null) },
    ],
  };

  const revenueBuildRows = [
    { Line: "PPA revenue", "PPA total": `Rs ${num(totalPpaRevenue, 1)} cr`, Formula: "PPA MWh x net tariff" },
    { Line: "Merchant revenue", "PPA total": `Rs ${num(totalMerchantRevenue, 1)} cr`, Formula: "Merchant MWh x merchant price" },
    { Line: "Penalty deductions", "PPA total": `Rs ${num(totalPenalty, 1)} cr`, Formula: "Shortfall MWh x penalty multiplier x tariff" },
    { Line: "External green support", "PPA total": `Rs ${num(totalGreenCost, 1)} cr`, Formula: "External green MWh x support price" },
    { Line: "Net revenue", "PPA total": `Rs ${num(totalNetRevenue, 1)} cr`, Formula: "PPA + merchant - penalties - green support" },
  ];
  const cashFlowSummaryRows = [
    { Line: "Project cost", "PPA total": `Rs ${num(totalCapex, 1)} cr`, Formula: "EPC + land + transmission + owner costs + IDC" },
    { Line: "Operating expenses", "PPA total": `Rs ${num(totalOpex, 1)} cr`, Formula: "Plant O&M, BESS O&M, admin, insurance, WC interest and transmission loss cost" },
    { Line: "EBITDA", "PPA total": `Rs ${num(totalEbitda, 1)} cr`, Formula: "Net revenue - operating expenses" },
    { Line: "Tax", "PPA total": `Rs ${num(totalTax, 1)} cr`, Formula: "Tax after depreciation, interest and carried losses" },
    { Line: "Debt service", "PPA total": `Rs ${num(totalInterest + totalPrincipal, 1)} cr`, Formula: "Interest + scheduled principal repayment" },
    { Line: "BESS augmentation", "PPA total": `Rs ${num(totalAugmentation, 1)} cr`, Formula: "Scheduled replacement capex" },
    { Line: "Equity cash flow", "PPA total": `Rs ${num(totalFcfe, 1)} cr`, Formula: "CFADS - debt service - augmentation" },
  ];

  return (
    <section className="panel-grid">
      <article className="panel span-all">
        <header><h2>Financial Statements</h2><span>{financeResult ? "Latest finance rerun" : "Optimized result"}</span></header>
        <p className="note">This tab converts the solved backend finance table into statement-style revenue build-up, profit and loss, debt service and equity cash flow views. Plant sizing is fixed from the latest optimized output; rerun Optimization to reset the case.</p>
        <div className="statement-kpis">
          <KpiCard icon={CircleDollarSign} label="Tariff" value={`Rs ${num(finance.tariff_rs_per_kwh, 2)}/kWh`} detail="required gross tariff" />
          <KpiCard icon={TrendingUp} label="Equity IRR" value={pct(finance.equity_irr, 2)} detail="post-debt equity return" />
          <KpiCard icon={Activity} label="EBITDA margin" value={pct(netMargin, 1)} detail="PPA-term EBITDA / net revenue" />
          <KpiCard icon={ShieldCheck} label="Min DSCR" value={Number.isFinite(minDscr) ? `${num(minDscr, 2)}x` : "N/A"} detail={`Average ${Number.isFinite(averageDscr) ? `${num(averageDscr, 2)}x` : "N/A"}`} />
        </div>
      </article>
      <article className="panel span-all">
        <header><h2>Revenue Build-up</h2><span>PPA, merchant and deductions</span></header>
        <EChart option={revenueChart} height={420} />
        <DataTable rows={revenueBuildRows} />
      </article>
      <article className="panel span-all">
        <header><h2>Profit & Loss Trend</h2><span>Revenue to PAT</span></header>
        <EChart option={profitChart} height={420} />
      </article>
      <article className="panel span-all">
        <header><h2>Cash Flow Statement</h2><span>CFADS, debt service, augmentation and FCFE</span></header>
        <EChart option={cashFlowChart} height={430} />
        <DataTable rows={cashFlowSummaryRows} />
      </article>
      <article className="panel span-all">
        <header><h2>Debt Service & DSCR</h2><span>Sculpted repayment view</span></header>
        <EChart option={debtChart} height={400} />
      </article>
      <article className="panel span-2">
        <header><h2>Statement Table</h2><span>Rs crore by PPA year</span></header>
        <DataTable rows={statementWithCumulative} maxRows={30} />
      </article>
      <article className="panel">
        <header><h2>Capex Schedule</h2><span>Project cost build-up</span></header>
        <div className="optimizer-vars single-col">
          {Object.entries(capexComponents).map(([key, value]) => (
            <div key={key}><span>{key.replaceAll("_", " ")}</span><strong>{num(value, 1)}</strong></div>
          ))}
        </div>
      </article>
    </section>
  );
}

function SensitivityScenariosTab({ optimizedResult, scenarioInputs, setScenarioInputs, scenarioResult, scenarioLoading, onRunScenario, onResetScenario }) {
  const finance = scenarioResult?.finance || optimizedResult?.finance;
  const baseFinance = optimizedResult?.finance;
  const cap = optimizedResult?.capacity || {};
  const table = finance?.table || [];
  const years = table.map((d) => `Y${d.year}`);
  const fixedSizingRows = [
    { Item: "Solar AC MW", Value: num(cap.solar_ac_mw, 1), Treatment: "Fixed from latest optimizer output" },
    { Item: "Wind MW", Value: num(cap.wind_mw, 1), Treatment: "Fixed from latest optimizer output" },
    { Item: "BESS MW", Value: num(cap.bess_power_mw, 1), Treatment: "Fixed from latest optimizer output" },
    { Item: "BESS MWh", Value: num(cap.bess_energy_mwh, 1), Treatment: "Fixed from latest optimizer output" },
    { Item: "Selected bid capacity MW", Value: num(cap.contracted_capacity_mw, 1), Treatment: "Fixed from latest optimizer output" },
  ];
  const scenarioRows = [
    { Metric: "Tariff", "Optimizer base": baseFinance ? `Rs ${num(baseFinance.tariff_rs_per_kwh, 2)}/kWh` : "N/A", Scenario: finance ? `Rs ${num(finance.tariff_rs_per_kwh, 2)}/kWh` : "Run scenario" },
    { Metric: "Equity IRR", "Optimizer base": baseFinance ? pct(baseFinance.equity_irr, 2) : "N/A", Scenario: finance ? pct(finance.equity_irr, 2) : "Run scenario" },
    { Metric: "Project IRR", "Optimizer base": baseFinance ? pct(baseFinance.project_irr, 2) : "N/A", Scenario: finance ? pct(finance.project_irr, 2) : "Run scenario" },
    { Metric: "Minimum DSCR", "Optimizer base": baseFinance ? `${num(baseFinance.min_dscr, 2)}x` : "N/A", Scenario: finance ? `${num(finance.min_dscr, 2)}x` : "Run scenario" },
    { Metric: "Project cost", "Optimizer base": baseFinance ? `Rs ${num(baseFinance.total_project_cost_cr, 0)} cr` : "N/A", Scenario: finance ? `Rs ${num(finance.total_project_cost_cr, 0)} cr` : "Run scenario" },
  ];
  const chartOption = {
    color: ["#5ab4e8", "#a98bff", "#f5b83d", "#ff6b5f"],
    tooltip: { trigger: "axis" },
    legend: { top: 0 },
    grid: { left: 58, right: 56, top: 48, bottom: 44 },
    xAxis: { type: "category", boundaryGap: false, data: years },
    yAxis: [
      { type: "value", name: "Rs cr", splitLine: { lineStyle: { color: "#242424" } } },
      { type: "value", name: "DSCR", min: 0, splitLine: { show: false } },
    ],
    dataZoom: [{ type: "inside" }, { type: "slider", height: 18, bottom: 8 }],
    series: [
      { name: "EBITDA", type: "line", smooth: true, symbol: "none", areaStyle: { opacity: 0.08 }, data: table.map((d) => d.ebitda_cr) },
      { name: "CFADS", type: "line", smooth: true, symbol: "none", data: table.map((d) => d.cfads_cr) },
      { name: "FCFE", type: "line", smooth: true, symbol: "none", data: table.map((d) => d.fcfe_cr) },
      { name: "DSCR", type: "line", yAxisIndex: 1, smooth: true, symbolSize: 7, data: table.map((d) => Number.isFinite(Number(d.dscr)) ? d.dscr : null) },
    ],
  };

  if (!optimizedResult) {
    return (
      <section className="panel-grid">
        <article className="panel span-all">
          <header><h2>Sensitivity & Scenarios</h2><span>Run optimization first</span></header>
          <div className="empty-chart">Run the optimizer once. This tab then keeps solar, wind, BESS and bid capacity fixed while finance sliders recompute tariff and cashflows.</div>
        </article>
      </section>
    );
  }

  return (
    <section className="panel-grid">
      <article className="panel span-all">
        <header><h2>Sensitivity & Scenarios</h2><span>Financial sensitivities on fixed optimized sizing</span></header>
        <p className="note">These sliders do not change solar, wind, BESS or selected bid capacity. Capex, opex and working-capital assumptions are maintained in Financial Inputs and flow into this scenario from the current finance settings.</p>
        <DataTable rows={fixedSizingRows} />
      </article>
      <article className="panel span-all">
        <header><h2>Scenario Sliders</h2><span>Auto-reruns finance after changes</span></header>
        <div className="scenario-grid">
          <SliderField values={scenarioInputs} setValues={setScenarioInputs} name="debtFraction" label="Debt %" min={0} max={85} step={1} suffix="%" />
          <SliderField values={scenarioInputs} setValues={setScenarioInputs} name="interestRate" label="Debt rate %" min={6} max={14} step={0.05} suffix="%" />
          <SliderField values={scenarioInputs} setValues={setScenarioInputs} name="targetEquityIrr" label="Cost of equity %" min={10} max={20} step={0.25} suffix="%" />
          <SliderField values={scenarioInputs} setValues={setScenarioInputs} name="minDscr" label="Minimum DSCR" min={1.0} max={1.6} step={0.05} suffix="x" />
          <SliderField values={scenarioInputs} setValues={setScenarioInputs} name="sculptTargetDscr" label="Debt sizing DSCR" min={1.0} max={1.6} step={0.05} suffix="x" />
        </div>
        <div className="panel-actions gap-actions">
          <button className="secondary" onClick={onResetScenario}>Reset to optimizer finance inputs</button>
          <button className="primary" onClick={onRunScenario} disabled={Boolean(scenarioLoading)}>
            {scenarioLoading ? <Loader2 className="spin" size={18} /> : <Calculator size={18} />} Run scenario now
          </button>
        </div>
      </article>
      <article className="panel span-all">
        <header><h2>Scenario Financial Outputs</h2><span>{scenarioLoading || "Backend finance rerun on fixed plant"}</span></header>
        <DataTable rows={scenarioRows} />
      </article>
      <article className="panel span-all">
        <header><h2>Cashflow Response Graph</h2><span>EBITDA, CFADS, FCFE and DSCR by PPA year</span></header>
        {table.length ? <EChart option={chartOption} height={420} /> : <div className="empty-chart">Move a slider or click Run scenario now to plot financial outputs.</div>}
      </article>
      <article className="panel span-2">
        <header><h2>Scenario Finance Table</h2><span>Cashflow rows from backend model</span></header>
        <DataTable rows={table} maxRows={30} />
      </article>
      <article className="panel">
        <header><h2>Scenario Capex Components</h2><span>Rs crore</span></header>
        <div className="optimizer-vars single-col">
          {Object.entries(finance?.capex_components || {}).map(([key, value]) => (
            <div key={key}><span>{key.replaceAll("_", " ")}</span><strong>{num(value, 1)}</strong></div>
          ))}
        </div>
      </article>
    </section>
  );
}

function DispatchTab({ result, embedded = false }) {
  const dispatch = result?.first_year?.week || [];
  const monthly = result?.first_year?.monthly || [];
  const hours = dispatch.map((d, i) => `D${d.day || Math.floor(i / 24) + 1} ${String(d.hour ?? i % 24).padStart(2, "0")}:00`);
  const dispatchChart = (
    <article className="panel span-all dispatch-cockpit">
      <header><h2>Ultra dispatch cockpit</h2><span>Hourly curve for the first operating week</span></header>
      <EChart
        option={{
          color: ["#5ab4e8", "#a98bff", "#f5b83d", "#e07b39", "#7ddc9a", "#ff6b5f"],
          animation: false,
          tooltip: {
            trigger: "axis",
            confine: true,
            axisPointer: { type: "cross", label: { backgroundColor: "#202020" } },
            valueFormatter: (v) => `${num(v, 1)} MWh`,
          },
          legend: {
            top: 0,
            left: 8,
            type: "scroll",
            itemWidth: 14,
            itemHeight: 8,
            textStyle: { color: "#c2c2bc", fontWeight: 700 },
          },
          grid: { left: 74, right: 74, top: 72, bottom: 92, containLabel: true },
          xAxis: {
            type: "category",
            boundaryGap: false,
            data: hours,
            axisLabel: {
              color: "#86867f",
              interval: 11,
              rotate: 0,
              formatter: (value) => value.replace(" ", "\n"),
            },
            axisTick: { alignWithLabel: true },
            splitLine: {
              show: true,
              interval: (index) => index % 24 === 0,
              lineStyle: { color: "#333333" },
            },
          },
          yAxis: [
            {
              type: "value",
              name: "Dispatch MW / MWh",
              nameGap: 42,
              nameLocation: "middle",
              axisLabel: { formatter: (v) => num(v, 0), color: "#86867f" },
              splitLine: { lineStyle: { color: "#242424" } },
            },
            {
              type: "value",
              name: "SOC MWh",
              nameGap: 48,
              nameLocation: "middle",
              axisLabel: { formatter: (v) => num(v, 0), color: "#86867f" },
              splitLine: { show: false },
            },
          ],
          dataZoom: [
            { type: "inside", start: 0, end: 100 },
            { type: "slider", height: 28, bottom: 28, start: 0, end: 100, brushSelect: false },
          ],
          series: [
            { name: "RE generation", type: "line", smooth: true, symbol: "none", lineStyle: { width: 3 }, areaStyle: { opacity: 0.10 }, data: dispatch.map((d) => d.total_re_mw) },
            { name: "PPA schedule", type: "line", smooth: true, symbol: "none", lineStyle: { width: 3 }, data: dispatch.map((d) => d.ppa_mwh) },
            { name: "BESS discharge", type: "line", smooth: true, symbol: "none", lineStyle: { width: 2.5 }, areaStyle: { opacity: 0.14 }, data: dispatch.map((d) => d.bess_discharge_mwh) },
            { name: "BESS charge", type: "line", smooth: true, symbol: "none", lineStyle: { width: 2 }, data: dispatch.map((d) => d.bess_charge_mwh) },
            { name: "SOC", type: "line", yAxisIndex: 1, smooth: true, symbol: "none", lineStyle: { width: 4 }, data: dispatch.map((d) => d.soc_mwh) },
            { name: "Spill", type: "bar", barWidth: "45%", itemStyle: { opacity: 0.45 }, data: dispatch.map((d) => d.spill_mwh) },
          ],
        }}
        height={560}
      />
      <div className="dispatch-legend-note">Use the lower slider or mouse wheel to zoom into peak windows. Labels are day/hour, with dashed guides at day boundaries.</div>
    </article>
  );
  const tablePanel = (
    <article className="panel span-all">
      <header><h2>Monthly dispatch and compliance table</h2><span>First operating year</span></header>
      <DataTable rows={monthly} maxRows={12} />
    </article>
  );
  if (embedded) {
    return (
      <>
        {dispatchChart}
        {tablePanel}
      </>
    );
  }
  return (
    <section className="panel-grid">
      {dispatchChart}
      {tablePanel}
    </section>
  );
}

function CustomDispatchTab({ settings, setSettings, result, onRunDispatch, loading }) {
  const cap = result?.capacity || {};
  const totals = result?.operating?.totals || {};
  const annual = result?.operating?.annual || [];
  const monthly = result?.first_year?.monthly || [];
  const status = result?.status || {};
  const tender = result?.project?.tender || {};
  const morningWindow = tender.morning_window || [5, 10];
  const eveningWindow = tender.evening_window || [18, 23];
  const minPeakAvailability = Number(totals.min_peak_availability ?? NaN);
  const annualCufFloor = Number(totals.annual_cuf_floor ?? Number(settings.declaredCuf || 0) * 0.85 / 100);
  const annualCufCeiling = Number(totals.annual_cuf_ceiling ?? Number(settings.declaredCuf || 0) * 1.10 / 100);
  const minAnnualCuf = Number(totals.min_annual_cuf ?? NaN);
  const maxAnnualCuf = Number(totals.max_annual_cuf ?? NaN);
  const peakShortfallGwh = monthly.reduce((sum, row) => sum + Number(row.peak_shortfall_mwh || 0), 0) / 1000;
  const annualPenaltyGwh = annual.reduce((sum, row) => sum + Number(row.annual_penalty_mwh || 0), 0) / 1000;
  const peakOk = Number.isFinite(minPeakAvailability) && minPeakAvailability >= 0.9 - 1e-9;
  const cufFloorOk = Number.isFinite(minAnnualCuf) && minAnnualCuf >= annualCufFloor - 1e-9;
  const cufCeilingOk = Number.isFinite(maxAnnualCuf) && maxAnnualCuf <= annualCufCeiling + 1e-9;
  const conditionRows = result ? [
    { Condition: "Monthly peak availability", Required: `>= ${pct(tender.peak_availability_floor ?? 0.9, 1)} of contracted capacity`, Actual: pct(minPeakAvailability, 2), Shortfall: `${num(peakShortfallGwh, 3)} GWh`, Status: peakOk ? "Pass" : "Fail" },
    { Condition: "Annual CUF minimum", Required: `>= ${pct(annualCufFloor, 2)}`, Actual: pct(minAnnualCuf, 2), Shortfall: `${num(annualPenaltyGwh, 3)} GWh`, Status: cufFloorOk ? "Pass" : "Fail" },
    { Condition: "Annual CUF upper band", Required: `<= ${pct(annualCufCeiling, 2)}`, Actual: pct(maxAnnualCuf, 2), Shortfall: `${num(Number(totals.cuf_upper_headroom_gwh || 0), 3)} GWh headroom`, Status: cufCeilingOk ? "Pass" : "Fail" },
    { Condition: "Daily peak schedule", Required: "2h morning + 2h evening", Actual: `${num(morningWindow[0], 0)}:00-${num(morningWindow[1], 0)}:00 and ${num(eveningWindow[0], 0)}:00-${num(eveningWindow[1], 0)}:00`, Shortfall: "Modeled hourly", Status: "Dispatch run" },
  ] : [];
  const monthlyRows = monthly.map((row) => ({
    Month: row.month_name || row.month,
    "Peak obligation MWh": row.peak_obligation_mwh,
    "Peak floor MWh": row.peak_floor_mwh,
    "Delivered MWh": row.peak_delivered_mwh,
    "Shortfall MWh": row.peak_shortfall_mwh,
    "Availability": pct(row.peak_availability, 2),
    Status: row.compliant ? "Pass" : "Fail",
  }));
  const annualRows = annual.map((row) => ({
    Year: row.year,
    "Annual CUF": pct(row.annual_cuf, 2),
    "Min peak availability": pct(row.min_monthly_peak_availability, 2),
    "PPA GWh": Number(row.ppa_mwh || 0) / 1000,
    "Penalty GWh": Number(row.total_penalty_mwh || 0) / 1000,
    "Spill GWh": Number(row.spill_mwh || 0) / 1000,
  }));

  return (
    <section className="panel-grid">
      <article className="panel span-all">
        <header><h2>Custom Dispatch</h2><span>Dispatch-only tender compliance test for manually entered capacities</span></header>
        <p className="note">This tab does not use tariff or finance inputs. It runs the hourly dispatch for the selected solar, wind and BESS size, tries to serve the FDRE schedule to the extent possible, and then reports CUF, monthly peak availability and shortfalls.</p>
        <div className="form-grid">
          <InputField settings={settings} setSettings={setSettings} name="contractedCapacity" label="Contracted capacity MW" step="10" />
          <InputField settings={settings} setSettings={setSettings} name="dispatchMinCuf" label="Minimum annual CUF %" step="0.1" />
          <InputField settings={settings} setSettings={setSettings} name="dispatchPeakAvailability" label="Peak availability floor %" step="0.1" />
          <SelectField settings={settings} setSettings={setSettings} name="yearsMode" label="Dispatch solve mode">
            <option value="fast">Fast representative years</option>
            <option value="exact">Exact full PPA term</option>
          </SelectField>
          <InputField settings={settings} setSettings={setSettings} name="dispatchMorningPeakStart" label="Morning peak start hour" step="1" />
          <InputField settings={settings} setSettings={setSettings} name="dispatchMorningPeakEnd" label="Morning peak end hour" step="1" />
          <InputField settings={settings} setSettings={setSettings} name="dispatchEveningPeakStart" label="Evening peak start hour" step="1" />
          <InputField settings={settings} setSettings={setSettings} name="dispatchEveningPeakEnd" label="Evening peak end hour" step="1" />
          <SelectField settings={settings} setSettings={setSettings} name="windLevel" label="Wind yield case">
            <option>P50</option><option>P75</option><option>P90</option>
          </SelectField>
          <InputField settings={settings} setSettings={setSettings} name="solarAcMw" label="Solar AC MW" step="5" />
          <InputField settings={settings} setSettings={setSettings} name="windMw" label="Wind MW" step="1" />
          <InputField settings={settings} setSettings={setSettings} name="bessPowerMw" label="BESS power MW" step="5" />
          <InputField settings={settings} setSettings={setSettings} name="bessEnergyMwh" label="BESS energy MWh" step="10" />
          <ToggleField settings={settings} setSettings={setSettings} name="windProfile" label="Use Bikaner wind CSV" />
          <SelectField settings={settings} setSettings={setSettings} name="solarLevel" label="Solar model input">
            <option>P50</option><option>P75</option><option>P90</option>
          </SelectField>
        </div>
        <p className="note">Default custom dispatch rule: peak hours are 08:00-10:00 and 18:00-20:00. The model enforces at least 90% of contracted capacity during these peak hours and at least 40% annual CUF.</p>
        <div className="panel-actions left-actions">
          <button className="primary" onClick={onRunDispatch} disabled={Boolean(loading)}>
            {loading ? <Loader2 className="spin" size={18} /> : <Play size={18} />} Run custom dispatch
          </button>
        </div>
      </article>

      {result && (
        <>
          <article className="panel span-all">
            <header><h2>Dispatch Capacity Summary</h2><span>No finance or tariff output</span></header>
            <div className="optimizer-vars">
              <div><span>Solar MW</span><strong>{num(cap.solar_ac_mw, 1)}</strong></div>
              <div><span>Wind MW</span><strong>{num(cap.wind_mw, 1)}</strong></div>
              <div><span>BESS MW</span><strong>{num(cap.bess_power_mw, 1)}</strong></div>
              <div><span>BESS MWh</span><strong>{num(cap.bess_energy_mwh, 1)}</strong></div>
              <div><span>Contracted MW</span><strong>{num(cap.contracted_capacity_mw, 1)}</strong></div>
              <div><span>Dispatch status</span><strong>{status.reason === "ok" ? "Tender pass" : "Shortfall"}</strong></div>
            </div>
          </article>
          <article className="panel span-all">
            <header><h2>Tender Condition Fulfilment</h2><span>CUF and split daily peak availability</span></header>
            <DataTable rows={conditionRows} maxRows={8} />
          </article>
          <article className="panel span-all">
            <header><h2>First-Year Monthly Peak Availability</h2><span>Shortfall is still shown when the case fails</span></header>
            <DataTable rows={monthlyRows} maxRows={12} />
          </article>
          <article className="panel span-all">
            <header><h2>Modeled Years Summary</h2><span>Representative years or exact 25-year run depending on solve mode</span></header>
            <DataTable rows={annualRows} maxRows={30} />
          </article>
          <DispatchTab result={result} embedded />
        </>
      )}
    </section>
  );
}

function ProjectInputsTab({ result, defaults }) {
  const tables = result?.project_tables || defaults?.project_tables || {};
  return (
    <section className="panel-grid">
      <article className="panel">
        <header><h2>Nodes / interconnection</h2><span>Grid injection limits</span></header>
        <DataTable rows={tables.nodes || []} />
      </article>
      <article className="panel span-2">
        <header><h2>Generators</h2><span>Solar and wind project inputs</span></header>
        <DataTable rows={tables.generators || []} columns={["name", "technology", "node", "ac_mw", "dc_mwp", "cuf", "degradation_per_year", "availability"]} />
      </article>
      <article className="panel span-all">
        <header><h2>BESS</h2><span>Power, energy, RTE and augmentation</span></header>
        <DataTable rows={tables.bess || []} columns={["name", "node", "power_mw", "energy_mwh", "usable_mwh_at_poi", "rte", "augmentation_years", "notes"]} />
      </article>
      {!!tables.warnings?.length && (
        <article className="panel span-all">
          <header><h2>Validation warnings</h2><span>Input checks</span></header>
          <ul className="checks">{tables.warnings.map((w) => <li className="bad-check" key={w}><AlertTriangle /> {w}</li>)}</ul>
        </article>
      )}
    </section>
  );
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function PvsystTab({ defaults, pvsystReports, setPvsystReports }) {
  const solar = defaults?.eya?.solar || [];
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");

  async function parseFiles(files) {
    const selected = Array.from(files || []).slice(0, 3);
    if (!selected.length) return;
    setUploading(true);
    setUploadError("");
    try {
      const payload = {
        files: await Promise.all(selected.map(async (file) => ({
          name: file.name,
          content_base64: await fileToBase64(file),
        }))),
      };
      const parsed = await api("/api/pvsyst/parse", payload);
      setPvsystReports(parsed.reports || []);
      if (parsed.errors?.length) setUploadError(parsed.errors.map((e) => `${e.name}: ${e.error}`).join("; "));
    } catch (err) {
      setUploadError(err.message);
    } finally {
      setUploading(false);
    }
  }

  return (
    <section className="panel-grid">
      <article className="panel">
        <header><h2>PVsyst report ingestion</h2><span>Provision for up to three solar sites</span></header>
        <label className="upload-drop">
          <Upload size={28} />
          <strong>{uploading ? "Parsing PVsyst reports..." : "Upload up to three PVsyst PDFs"}</strong>
          <span>The React app now sends PDFs to the FastAPI parser and returns P50/P75/P90 CUF tables.</span>
          <input type="file" accept="application/pdf,.pdf" multiple onChange={(e) => parseFiles(e.target.files)} />
        </label>
        {uploadError && <div className="alert slim-alert">{uploadError}</div>}
      </article>
      <article className="panel span-2">
        <header><h2>Solar CUF basis from EYA/PVsyst</h2><span>P50/P75/P90-ready inputs</span></header>
        <DataTable rows={(pvsystReports.length ? pvsystReports.map((r) => ({
          Site: r.site || r.project || r.source_name,
          "AC MW": r.ac_mw,
          "DC MWp": r.dc_mwp,
          "P50 AC CUF %": 100 * (r.probability?.find((p) => p["P-level"] === "P50")?.["AC CUF"] || 0),
          "P75 AC CUF %": 100 * (r.probability?.find((p) => p["P-level"] === "P75")?.["AC CUF"] || 0),
          "P90 AC CUF %": 100 * (r.probability?.find((p) => p["P-level"] === "P90")?.["AC CUF"] || 0),
          "Specific yield": r.specific_yield_kwh_per_kwp,
          "PR %": r.pr_pct,
        })) : solar.map((s) => ({
          Site: s.name,
          "AC MW": s.ac_mw,
          "DC MWp": s.dc_mwp,
          "GHI": s.ghi,
          "P50 AC CUF %": 100 * s.plevels.P50.ac_cuf,
          "P75 AC CUF %": 100 * s.plevels.P75.ac_cuf,
          "P90 AC CUF %": 100 * s.plevels.P90.ac_cuf,
        })))} />
      </article>
      {!!pvsystReports.length && (
        <article className="panel span-all">
          <header><h2>Parsed PVsyst reports</h2><span>Client upload results</span></header>
          <DataTable rows={pvsystReports} columns={["source_name", "project", "site", "ac_mw", "dc_mwp", "p50_mwh_y1", "specific_yield_kwh_per_kwp", "pr_pct"]} />
        </article>
      )}
    </section>
  );
}

function WindTab({ defaults, settings, optimizedResult }) {
  const windRows = defaults?.wind?.summary || [];
  const eyaWind = defaults?.eya?.wind;
  const selectedWind = windRows.find((r) => r["P-level"] === settings.windLevel);
  const optimizedWindMw = optimizedResult?.capacity?.wind_mw;
  const pLevels = Object.entries(eyaWind?.plevels || {}).map(([level, values]) => ({ level, ...values }));
  const uncertainty = Object.entries(eyaWind?.uncertainty || {}).map(([name, value]) => ({ name, value }));
  const wtgBasis = eyaWind?.n_wtg && eyaWind?.wtg_mw ? `${eyaWind.n_wtg} x ${num(eyaWind.wtg_mw, 2)} MW WTGs` : "Reference EYA default";
  return (
    <section className="panel-grid">
      <article className="panel">
        <header><h2>Bikaner wind turbine CSV</h2><span>3.15 MW WTG profile</span></header>
        <div className="wind-card">
          <Wind size={44} />
          <strong>{selectedWind ? `${num(selectedWind["Per-turbine AEP (GWh)"], 2)} GWh` : "N/A"}</strong>
          <span>{settings.windLevel} per turbine</span>
          <small>{selectedWind ? `${num(selectedWind["Capacity factor %"], 2)}% WTG CF` : ""}</small>
        </div>
      </article>
      <article className="panel span-2">
        <header><h2>P-level yield table</h2><span>Used by optimizer when enabled</span></header>
        <DataTable rows={windRows} columns={["P-level", "Per-turbine AEP (GWh)", "Capacity factor %"]} />
      </article>
      <article className="panel span-all">
        <header><h2>Wind P-level generation</h2><span>Bankability view across P50 / P75 / P90</span></header>
        <EChart
          option={{
            tooltip: { trigger: "axis" },
            grid: { left: 52, right: 24, top: 24, bottom: 36 },
            xAxis: { type: "category", data: pLevels.map((p) => p.level) },
            yAxis: { type: "value", name: "GWh" },
            series: [
              { name: "Net generation", type: "bar", barWidth: 34, itemStyle: { borderRadius: 0, color: "#5ab4e8" }, data: pLevels.map((p) => p.net_gwh) },
              { name: "PLF", type: "line", smooth: true, yAxisIndex: 0, data: pLevels.map((p) => p.plf * 100) },
            ],
          }}
          height={300}
        />
      </article>
      <article className="panel span-all">
        <header><h2>Enterprise wind EYA</h2><span>Loss waterfall and uncertainty</span></header>
        <p className="note">This section is a reference EYA basis. The optimizer scales wind separately using the selected turbine yield profile.</p>
        <div className="optimizer-vars">
          <div><span>Reference EYA wind park</span><strong>{num(eyaWind?.capacity_mw, 1)} MW</strong></div>
          <div><span>Reference turbine basis</span><strong>{wtgBasis}</strong></div>
          <div><span>Optimized wind capacity</span><strong>{optimizedWindMw == null ? "Run optimizer" : `${num(optimizedWindMw, 1)} MW`}</strong></div>
          <div><span>Gross generation</span><strong>{num(eyaWind?.gross_gwh, 1)} GWh</strong></div>
          <div><span>Net P50</span><strong>{num(eyaWind?.net_p50_gwh, 1)} GWh</strong></div>
          <div><span>Total uncertainty</span><strong>{pctRaw(eyaWind?.sigma_pct, 2)}</strong></div>
        </div>
      </article>
      <article className="panel span-2">
        <header><h2>Loss waterfall</h2><span>Gross to net production</span></header>
        <EChart
          option={{
            tooltip: { trigger: "axis", valueFormatter: (v) => `${num(v, 1)} GWh` },
            grid: { left: 52, right: 20, top: 20, bottom: 86 },
            xAxis: { type: "category", axisLabel: { rotate: 35 }, data: (eyaWind?.waterfall || []).map((r) => r.stage.replace(/\(.+\)/, "")) },
            yAxis: { type: "value", name: "GWh" },
            series: [{ type: "line", smooth: true, symbolSize: 8, areaStyle: { opacity: 0.12 }, data: (eyaWind?.waterfall || []).map((r) => r.gwh) }],
          }}
          height={360}
        />
      </article>
      <article className="panel">
        <header><h2>RSS uncertainty</h2><span>Component contribution</span></header>
        <EChart
          option={{
            tooltip: { trigger: "item", formatter: "{b}: {c}%" },
            series: [{ type: "pie", radius: ["42%", "72%"], data: uncertainty.map((u) => ({ name: u.name, value: u.value })) }],
          }}
          height={360}
        />
      </article>
      <article className="panel span-all">
        <header><h2>Wind EYA audit tables</h2><span>Loss chain and uncertainty assumptions</span></header>
        <DataTable rows={eyaWind?.waterfall || []} columns={["stage", "gwh"]} />
        <DataTable rows={uncertainty} columns={["name", "value"]} />
      </article>
    </section>
  );
}

function BessAssessment({ defaults }) {
  const bess = defaults?.eya?.bess || [];
  const first = bess[0];
  const schedule = first?.schedule || [];
  return (
    <section className="panel-grid nested-grid">
      <article className="panel">
        <header><h2>BESS Yield Assessment</h2><span>Technical storage inputs</span></header>
        <DataTable rows={bess.map((b) => ({
          BESS: b.name,
          "Power MW": b.power_mw,
          "PoI MWh": b.poi_mwh,
          Augmentation: b.augmentation,
        }))} />
      </article>
      <article className="panel span-2">
        <header><h2>SoH and RTE schedule</h2><span>{first?.name || "BESS"} degradation profile</span></header>
        <EChart
          option={{
            tooltip: { trigger: "axis" },
            legend: { top: 0 },
            grid: { left: 50, right: 44, top: 46, bottom: 36 },
            xAxis: { type: "category", data: schedule.map((r) => `Y${r.Year}`) },
            yAxis: [
              { type: "value", name: "SoH %", min: 75, max: 102 },
              { type: "value", name: "RTE %", min: 80, max: 90 },
            ],
            series: [
              { name: "SoH", type: "line", smooth: true, symbolSize: 7, areaStyle: { opacity: 0.12 }, data: schedule.map((r) => r["SoH (%)"]) },
              { name: "RTE", type: "line", smooth: true, yAxisIndex: 1, symbolSize: 7, data: schedule.map((r) => r["RTE (%)"]) },
            ],
          }}
          height={320}
        />
      </article>
      <article className="panel span-all">
        <header><h2>BESS yearly annexure</h2><span>Usable energy, state of health and round-trip efficiency</span></header>
        <DataTable rows={schedule} maxRows={20} />
      </article>
    </section>
  );
}

function OneMwYieldBasis({ defaults, settings, pvsystReports }) {
  const solar = defaults?.eya?.solar || [];
  const windRows = defaults?.wind?.summary || [];
  const solarRows = pvsystReports.length ? pvsystReports.map((r) => {
    const p50 = r.probability?.find((p) => p["P-level"] === "P50");
    const p75 = r.probability?.find((p) => p["P-level"] === "P75");
    const p90 = r.probability?.find((p) => p["P-level"] === "P90");
    return {
      Source: r.site || r.project || r.source_name,
      Technology: "Solar PV",
      "P50 MWh / MWac": num((p50?.["AC CUF"] || 0) * 8760, 1),
      "P75 MWh / MWac": num((p75?.["AC CUF"] || 0) * 8760, 1),
      "P90 MWh / MWac": num((p90?.["AC CUF"] || 0) * 8760, 1),
      Basis: "Uploaded PVsyst",
    };
  }) : solar.map((s) => ({
    Source: s.name,
    Technology: "Solar PV",
    "P50 MWh / MWac": num(s.plevels.P50.ac_cuf * 8760, 1),
    "P75 MWh / MWac": num(s.plevels.P75.ac_cuf * 8760, 1),
    "P90 MWh / MWac": num(s.plevels.P90.ac_cuf * 8760, 1),
    Basis: "EYA default",
  }));
  const windBasisRows = windRows.map((r) => ({
    Source: "Bikaner wind CSV",
    Technology: "Wind",
    "P-level": r["P-level"],
    "MWh / MW": num((r["Per-turbine AEP (MWh)"] || 0) / (defaults?.wind?.rated_power_mw || 3.15), 1),
    "Capacity factor %": num(r["Capacity factor %"], 2),
    Basis: `${num(defaults?.wind?.rated_power_mw || 3.15, 2)} MW WTG normalized to 1 MW`,
  }));
  return (
    <section className="panel-grid">
      <article className="panel span-all">
        <header><h2>1 MW Yield Basis</h2><span>Normalized inputs used before sizing</span></header>
        <p className="note">This page is not the optimized portfolio EYA. It stores the normalized resource assumptions: solar yield per 1 MWac, wind generation per 1 MW, and BESS efficiency/degradation basis.</p>
      </article>
      <article className="panel span-2">
        <header><h2>Solar 1 MWac Basis</h2><span>{settings.solarLevel} selectable in model input</span></header>
        <DataTable rows={solarRows} />
      </article>
      <article className="panel">
        <header><h2>Wind 1 MW Basis</h2><span>P50 / P75 / P90 from turbine CSV</span></header>
        <DataTable rows={windBasisRows} />
      </article>
    </section>
  );
}

function YieldAssessmentTab({ defaults, settings, pvsystReports, setPvsystReports, optimizedResult }) {
  return (
    <section className="workflow-stack">
      <div className="workflow-heading">
        <div className="eyebrow"><BarChart3 size={16} /> Yield Assessment</div>
        <h1>1 MW Resource Basis</h1>
        <p>Solar PVsyst, wind turbine generation and BESS degradation are normalized before the optimizer sizes the project.</p>
      </div>
      <OneMwYieldBasis defaults={defaults} settings={settings} pvsystReports={pvsystReports} />
      <PvsystTab defaults={defaults} pvsystReports={pvsystReports} setPvsystReports={setPvsystReports} />
      <WindTab defaults={defaults} settings={settings} optimizedResult={optimizedResult} />
      <BessAssessment defaults={defaults} />
    </section>
  );
}

function OptimizedEyaTab({ optimizedResult, defaults }) {
  const cap = optimizedResult?.capacity || {};
  const solar = defaults?.eya?.solar || [];
  const eyaWind = defaults?.eya?.wind || {};
  const solarCuf = solar.length ? solar.reduce((acc, s) => acc + s.plevels.P50.ac_cuf * s.ac_mw, 0) / solar.reduce((acc, s) => acc + s.ac_mw, 0) : 0;
  const windP50 = defaults?.wind?.summary?.find((r) => r["P-level"] === "P50");
  const windMwhPerMw = windP50 ? windP50["Per-turbine AEP (MWh)"] / (defaults?.wind?.rated_power_mw || 3.15) : 0;
  const windScale = eyaWind.capacity_mw ? (cap.wind_mw || 0) / eyaWind.capacity_mw : 0;
  const windLossRows = (eyaWind.waterfall || []).map((row) => ({
    Stage: row.stage,
    "Reference GWh": num(row.gwh, 2),
    "Optimized GWh": num(row.gwh * windScale, 2),
  }));
  const windPLevels = ["P50", "P75", "P90"].map((level) => {
    const netGwh = (eyaWind.plevels?.[level]?.net_gwh || 0) * windScale;
    return {
      "P-level": level,
      "Net AEP GWh": num(netGwh, 2),
      "PLF %": pct((cap.wind_mw || 0) > 0 ? (netGwh * 1000) / ((cap.wind_mw || 1) * 8760) : 0, 2),
      Basis: "Scaled from reference EYA loss chain",
    };
  });
  const p95Gwh = (eyaWind.net_p50_gwh || 0) * (1 - 1.64485 * (eyaWind.sigma_pct || 0) / 100) * windScale;
  windPLevels.push({
    "P-level": "P95",
    "Net AEP GWh": num(p95Gwh, 2),
    "PLF %": pct((cap.wind_mw || 0) > 0 ? (p95Gwh * 1000) / ((cap.wind_mw || 1) * 8760) : 0, 2),
    Basis: "P95 from RSS uncertainty",
  });
  const windWorkflowRows = [
    { Step: "1. Wind Measurements", Output: "Measured wind speed, shear, turbulence, air density", "Optimized basis": `${num(eyaWind.hub_m, 0)} m hub height, ${eyaWind.wtg_model || "WTG model"}` },
    { Step: "2. Long-Term Wind Climate (MCP)", Output: "Long-term corrected resource climate", "Optimized basis": "Reference EYA + Bikaner turbine profile" },
    { Step: "3. Flow Modelling", Output: "WAsP/OpenWind/CFD-style terrain and wake-ready flow field", "Optimized basis": "Moderate terrain, Rajasthan wind portfolio" },
    { Step: "4. Micrositing & Turbine Layout", Output: "WTG count/layout scaled to optimized MW", "Optimized basis": `${num(cap.wind_mw, 1)} MW selected by optimizer` },
    { Step: "5. Gross Annual Energy Production (Gross AEP)", Output: "Pre-loss wind generation", "Optimized basis": `${num((eyaWind.gross_gwh || 0) * windScale, 2)} GWh` },
    { Step: "6. Wake Losses", Output: "Array efficiency and wake adjustments", "Optimized basis": "Reference wake/array efficiency applied" },
    { Step: "7. Availability Losses", Output: "Scheduled maintenance, forced outages and grid availability", "Optimized basis": "Reference availability assumptions scaled to optimized wind MW" },
    { Step: "8. Electrical Losses", Output: "Collector, transformer, substation and auxiliary losses", "Optimized basis": "Electrical loss factors retained from reference EYA" },
    { Step: "9. Environmental & Curtailment Losses", Output: "High temperature, soiling, shutdown and curtailment impacts", "Optimized basis": "Environmental and curtailment loss factors retained from reference EYA" },
    { Step: "10. Net Annual Energy Production (Net AEP)", Output: "Final sellable wind energy after the full loss chain", "Optimized basis": `${num((eyaWind.net_p50_gwh || 0) * windScale, 2)} GWh at P50` },
    { Step: "11. Uncertainty Analysis", Output: "Measurement, MCP, power curve, wake, terrain and operating uncertainty by RSS", "Optimized basis": `${pctRaw(eyaWind.sigma_pct, 2)} total uncertainty` },
    { Step: "12. P50 / P75 / P90 / P95 Energy Estimates", Output: "Bankability generation cases for lender and bid review", "Optimized basis": "Scaled P-level table below" },
  ];
  const windInputRows = [
    { Parameter: "Optimized wind capacity", Value: `${num(cap.wind_mw, 1)} MW` },
    { Parameter: "Reference EYA capacity", Value: `${num(eyaWind.capacity_mw, 1)} MW` },
    { Parameter: "WTG basis", Value: eyaWind.wtg_model || "Suzlon S144_3.15MW" },
    { Parameter: "Hub height", Value: `${num(eyaWind.hub_m, 0)} m` },
    { Parameter: "Site", Value: eyaWind.site || "Rajasthan wind portfolio" },
    { Parameter: "Wind CSV 1 MW basis", Value: `${num(windMwhPerMw, 1)} MWh/MW at P50` },
  ];
  const eyaRows = [
    { Component: "Solar", "Optimized MW": num(cap.solar_ac_mw, 1), "1 MW basis": `${num(solarCuf * 8760, 1)} MWh/MWac`, "Estimated Year-1 energy": `${num((cap.solar_ac_mw || 0) * solarCuf * 8760 / 1000, 1)} GWh` },
    { Component: "Wind", "Optimized MW": num(cap.wind_mw, 1), "1 MW basis": `${num(windMwhPerMw, 1)} MWh/MW`, "Estimated Year-1 energy": `${num((cap.wind_mw || 0) * windMwhPerMw / 1000, 1)} GWh` },
    { Component: "BESS", "Optimized MW": num(cap.bess_power_mw, 1), "1 MW basis": "SoH / RTE schedule", "Estimated Year-1 energy": `${num(cap.bess_energy_mwh, 1)} MWh installed` },
  ];
  if (!optimizedResult) {
    return (
      <section className="panel-grid">
        <article className="panel span-all">
          <header><h2>Optimized EYA</h2><span>Run optimizer first</span></header>
          <p className="note">The optimized Energy Yield Assessment is generated only after the optimizer has selected Solar MW, Wind MW, BESS MW and BESS MWh.</p>
        </article>
      </section>
    );
  }
  return (
    <section className="workflow-stack">
      <ResultHeader
        result={optimizedResult}
        title="Optimized EYA"
        subtitle="Energy yield, dispatch and tender compliance for the optimized capacity selected by the solver."
        loading=""
        statusLabel="Post-optimization EYA"
      />
      <section className="panel-grid">
        <article className="panel span-all">
          <header><h2>Optimized Yield Build-up</h2><span>1 MW basis scaled to selected sizing</span></header>
          <DataTable rows={eyaRows} />
        </article>
        <article className="panel span-all">
          <header><h2>Optimized Wind EYA Workflow</h2><span>Measurement to bankable P-level output</span></header>
          <DataTable rows={windWorkflowRows} />
        </article>
        <article className="panel">
          <header><h2>Wind Measurements & MCP</h2><span>Resource basis</span></header>
          <DataTable rows={windInputRows} />
        </article>
        <article className="panel span-2">
          <header><h2>Gross to Net Wind AEP</h2><span>Loss waterfall scaled to optimized MW</span></header>
          <EChart
            option={{
              tooltip: { trigger: "axis", valueFormatter: (v) => `${num(v, 2)} GWh` },
              grid: { left: 54, right: 24, top: 24, bottom: 90 },
              xAxis: { type: "category", axisLabel: { rotate: 35 }, data: windLossRows.map((r) => r.Stage.replace(/\(.+\)/, "")) },
              yAxis: { type: "value", name: "GWh" },
              series: [{ name: "Optimized wind AEP", type: "line", smooth: true, symbolSize: 8, areaStyle: { opacity: 0.12 }, data: windLossRows.map((r) => Number(String(r["Optimized GWh"]).replace(/,/g, ""))) }],
            }}
            height={380}
          />
        </article>
        <article className="panel span-all">
          <header><h2>Wind Loss Waterfall Table</h2><span>Gross AEP to Net AEP</span></header>
          <DataTable rows={windLossRows} maxRows={20} />
        </article>
        <article className="panel span-all">
          <header><h2>Wind Uncertainty & P-Level Estimates</h2><span>P50 / P75 / P90 / P95</span></header>
          <DataTable rows={windPLevels} />
        </article>
      </section>
      <DispatchTab result={optimizedResult} />
      <ComplianceTab result={optimizedResult} />
    </section>
  );
}

function EyaTab({ defaults }) {
  const eya = defaults?.eya || {};
  return (
    <section className="panel-grid">
      <article className="panel span-all">
        <header><h2>Hybrid EYA summary</h2><span>P50/P75/P90 20-year average values</span></header>
        <p className="note">{eya.methodology_note}</p>
        <DataTable rows={eya.hybrid_summary || []} maxRows={18} />
      </article>
      <article className="panel">
        <header><h2>Wind EYA</h2><span>Report-calibrated</span></header>
        <div className="mix">
          <div><strong>{num(eya.wind?.net_p50_gwh, 1)} GWh</strong><span>net P50</span></div>
          <div><strong>{pctRaw(eya.wind?.sigma_pct, 2)}</strong><span>RSS uncertainty</span></div>
        </div>
      </article>
      <article className="panel">
        <header><h2>Solar EYA</h2><span>Bikaner sites</span></header>
        <DataTable rows={(eya.solar || []).map((s) => ({ Site: s.name, "AC MW": s.ac_mw, "P50 MWh": s.plevels.P50.mwh_y1 }))} />
      </article>
      <article className="panel">
        <header><h2>BESS schedules</h2><span>SoH / RTE</span></header>
        <DataTable rows={(eya.bess || []).map((b) => ({ BESS: b.name, "Power MW": b.power_mw, "PoI MWh": b.poi_mwh, Augmentation: b.augmentation }))} />
      </article>
    </section>
  );
}

function reportNumber(value) {
  const match = String(value ?? "").replaceAll(",", "").match(/-?\d+(\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function findReportTable(report, text) {
  const needle = text.toLowerCase();
  return (report?.blocks || []).find((block) => (
    block.type === "table"
    && `${block.caption || ""} ${(block.rows?.[0] || []).join(" ")}`.toLowerCase().includes(needle)
  ));
}

function findReportTables(report, text) {
  const needle = text.toLowerCase();
  return (report?.blocks || []).filter((block) => (
    block.type === "table"
    && `${block.caption || ""} ${(block.rows?.[0] || []).join(" ")}`.toLowerCase().includes(needle)
  ));
}

function customReportCapacityRows(result, settings) {
  const cap = result?.capacity || {};
  const solarTotal = Number(cap.solar_ac_mw || settings.solarAcMw || 0);
  const site1 = Number(settings.reportSolarSite1Mw || 0);
  const site2 = Number(settings.reportSolarSite2Mw || Math.max(0, solarTotal - site1));
  const dcRatio = Number(settings.reportDcAcRatio || 1.49);
  return [
    { Asset: "Wind", Site: settings.reportWindSite || "Barmer region, Rajasthan", Capacity: `${num(cap.wind_mw || settings.windMw, 1)} MW`, Details: settings.reportWindDetails || "3.15 MW WTG basis" },
    { Asset: "Solar Site 1", Site: settings.reportSolarSite1Name || "Bikaner, Rajasthan", Capacity: `${num(site1, 1)} MWac / ${num(site1 * dcRatio, 1)} MWp`, Details: `DC:AC ${num(dcRatio, 2)}` },
    { Asset: "Solar Site 2", Site: settings.reportSolarSite2Name || "Bikaner, Rajasthan", Capacity: `${num(site2, 1)} MWac / ${num(site2 * dcRatio, 1)} MWp`, Details: `DC:AC ${num(dcRatio, 2)}` },
    { Asset: "BESS", Site: settings.reportBessSite || "Bikaner / project PoI", Capacity: `${num(cap.bess_power_mw || settings.bessPowerMw, 1)} MW / ${num(cap.bess_energy_mwh || settings.bessEnergyMwh, 1)} MWh`, Details: `RTE ${settings.bessRtePercent}% / DoD ${settings.bessDodPercent}%` },
    { Asset: "Contracted Capacity", Site: "NHPC FDRE supply", Capacity: `${num(cap.contracted_capacity_mw || settings.contractedCapacity, 1)} MW`, Details: "Custom dispatch basis" },
  ];
}

function customReportMonthlyRows(result) {
  return (result?.first_year?.monthly || []).map((row) => ({
    Month: row.month_name || row.month,
    "Peak obligation MWh": row.peak_obligation_mwh,
    "Peak delivered MWh": row.peak_delivered_mwh,
    "Peak shortfall MWh": row.peak_shortfall_mwh,
    "Peak availability %": Number(row.peak_availability || 0) * 100,
    Status: row.compliant ? "Pass" : "Fail",
  }));
}

function customReportSummaryRows(result) {
  const totals = result?.operating?.totals || {};
  const status = result?.status || {};
  return [
    { Metric: "Minimum monthly peak availability", Value: pct(totals.min_peak_availability, 2), Tender: ">= 90.00%" },
    { Metric: "Minimum annual CUF", Value: pct(totals.min_annual_cuf, 2), Tender: `>= ${pct(totals.annual_cuf_floor ?? 0.4, 2)}` },
    { Metric: "Maximum annual CUF", Value: pct(totals.max_annual_cuf, 2), Tender: `<= ${pct(totals.annual_cuf_ceiling ?? 0.44, 2)}` },
    { Metric: "PPA energy", Value: `${num(totals.ppa_gwh, 2)} GWh`, Tender: "Annual CUF band" },
    { Metric: "Penalty / shortfall energy", Value: `${num(totals.penalty_gwh, 3)} GWh`, Tender: status.reason || "ok" },
    { Metric: "Spill energy", Value: `${num(totals.spill_gwh, 2)} GWh`, Tender: "Curtailment / surplus" },
  ];
}

function CustomReportInputPanel({ settings, setSettings }) {
  return (
    <article className="panel span-all">
      <header><h2>Custom Report Inputs</h2><span>Client-facing fields for custom dispatch report</span></header>
      <div className="form-grid">
        <InputField settings={settings} setSettings={setSettings} name="reportClientName" label="Client name" type="text" />
        <InputField settings={settings} setSettings={setSettings} name="reportProjectName" label="Project / report name" type="text" />
        <InputField settings={settings} setSettings={setSettings} name="reportVersion" label="Report version" type="text" />
        <InputField settings={settings} setSettings={setSettings} name="reportDate" label="Report date" type="text" />
        <InputField settings={settings} setSettings={setSettings} name="reportPreparedBy" label="Prepared by" type="text" />
        <InputField settings={settings} setSettings={setSettings} name="reportReviewer" label="Reviewer" type="text" />
        <InputField settings={settings} setSettings={setSettings} name="reportMethodology" label="Methodology note" type="text" />
        <InputField settings={settings} setSettings={setSettings} name="reportDcAcRatio" label="Solar DC:AC ratio" step="0.01" />
        <InputField settings={settings} setSettings={setSettings} name="reportSolarSite1Name" label="Solar site 1 name" type="text" />
        <InputField settings={settings} setSettings={setSettings} name="reportSolarSite1Mw" label="Solar site 1 MWac" step="1" />
        <InputField settings={settings} setSettings={setSettings} name="reportSolarSite2Name" label="Solar site 2 name" type="text" />
        <InputField settings={settings} setSettings={setSettings} name="reportSolarSite2Mw" label="Solar site 2 MWac" step="1" />
        <InputField settings={settings} setSettings={setSettings} name="reportWindSite" label="Wind site" type="text" />
        <InputField settings={settings} setSettings={setSettings} name="reportWindDetails" label="Wind details" type="text" />
        <InputField settings={settings} setSettings={setSettings} name="reportBessSite" label="BESS site / PoI" type="text" />
      </div>
    </article>
  );
}

function DocxTable({ rows = [] }) {
  if (!rows.length) return <div className="empty-chart">No report table data</div>;
  const columns = rows[0] || [];
  const body = rows.slice(1);
  return (
    <div className="table-wrap docx-table-wrap">
      <table className="docx-table">
        <thead>
          <tr>{columns.map((col, idx) => <th key={`${col}-${idx}`}>{col}</th>)}</tr>
        </thead>
        <tbody>
          {body.map((row, rowIdx) => (
            <tr key={rowIdx}>
              {columns.map((_, colIdx) => <td key={colIdx}>{row[colIdx] || ""}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ReportBlock({ block }) {
  if (!block) return null;
  if (block.type === "heading") {
    const Tag = block.level <= 2 ? "h2" : "h3";
    return <Tag className={`report-heading report-heading-${block.level}`}>{block.text}</Tag>;
  }
  if (block.type === "caption") return <p className="report-caption">{block.text}</p>;
  if (block.type === "note_label") return <p className="report-note-label">{block.text}</p>;
  if (block.type === "note") return <p className="report-note">{block.text}</p>;
  if (block.type === "table") return <DocxTable rows={block.rows || []} />;
  return <p className="report-paragraph">{block.text}</p>;
}

function CustomDispatchReportSection({ customResult, settings, setSettings, activeReport }) {
  const annualRows = annualGenerationMatrixRows(customResult);
  const monthlyRows = customReportMonthlyRows(customResult);
  const summaryRows = customReportSummaryRows(customResult);
  const capacityRows = customReportCapacityRows(customResult, settings);
  const cap = customResult?.capacity || {};
  const annualOption = {
    tooltip: { trigger: "axis" },
    legend: { top: 0 },
    grid: { left: 64, right: 60, top: 48, bottom: 48 },
    xAxis: { type: "category", data: annualRows.map((row) => `Y${row.year}`) },
    yAxis: [
      { type: "value", name: "GWh" },
      { type: "value", name: "%", splitLine: { show: false } },
    ],
    series: [
      { name: "PPA GWh", type: "bar", data: annualRows.map((row) => row.ppa_generation_gwh) },
      { name: "Spill GWh", type: "bar", data: annualRows.map((row) => row.spill_gwh) },
      { name: "Annual CUF", type: "line", yAxisIndex: 1, smooth: true, data: annualRows.map((row) => row.annual_cuf_percent) },
      { name: "Peak availability", type: "line", yAxisIndex: 1, smooth: true, data: annualRows.map((row) => row.min_monthly_peak_availability_percent) },
    ],
  };
  const monthlyOption = {
    tooltip: { trigger: "axis" },
    legend: { top: 0 },
    grid: { left: 64, right: 60, top: 48, bottom: 58 },
    xAxis: { type: "category", data: monthlyRows.map((row) => row.Month) },
    yAxis: [
      { type: "value", name: "MWh" },
      { type: "value", name: "%", splitLine: { show: false } },
    ],
    series: [
      { name: "Peak obligation", type: "bar", data: monthlyRows.map((row) => row["Peak obligation MWh"]) },
      { name: "Peak delivered", type: "bar", data: monthlyRows.map((row) => row["Peak delivered MWh"]) },
      { name: "Peak availability", type: "line", yAxisIndex: 1, smooth: true, data: monthlyRows.map((row) => row["Peak availability %"]) },
    ],
  };

  return (
    <section className="panel-grid">
      <CustomReportInputPanel settings={settings} setSettings={setSettings} />
      {!customResult ? (
        <article className="panel span-all">
          <header><h2>Custom Dispatch Report</h2><span>Run custom dispatch first</span></header>
          <div className="empty-chart">Open Custom Dispatch, enter the project size, and run dispatch. This report section will then populate with the client-ready EYA report outputs for that custom size.</div>
        </article>
      ) : (
        <>
          <article className="report-hero span-all custom-report-hero">
            <div>
              <span className="eyebrow">Custom dispatch report</span>
              <h1>{settings.reportProjectName}</h1>
              <p>{settings.reportClientName} | {settings.reportVersion} | {settings.reportDate}</p>
            </div>
            <div className="report-hero-meta">
              <strong>{num(cap.contracted_capacity_mw, 1)} MW contracted FDRE case</strong>
              <span>{num(cap.solar_ac_mw, 1)} MW solar | {num(cap.wind_mw, 1)} MW wind</span>
              <span>{num(cap.bess_power_mw, 1)} MW / {num(cap.bess_energy_mwh, 1)} MWh BESS</span>
              <span>Prepared by {settings.reportPreparedBy}; reviewed by {settings.reportReviewer}</span>
            </div>
          </article>
          <article className="panel span-all">
            <header><h2>1. Executive Summary</h2><span>Custom dispatch basis</span></header>
            <p className="report-paragraph">This client report is generated from the latest custom dispatch run and follows the Joulewise Hybrid EYA report structure. The model evaluates hourly renewable generation, BESS charge/discharge, peak-period supply, annual CUF, curtailment and shortfall for the entered solar, wind and BESS capacities.</p>
            <p className="report-paragraph">Methodology: {settings.reportMethodology}. The tender peak condition is tested for 08:00-10:00 and 18:00-20:00 unless edited in Project Configuration or Custom Dispatch. Annual CUF and monthly peak availability are reported even when a case does not meet the tender condition.</p>
            <DataTable rows={summaryRows} maxRows={10} />
            <div className="panel-actions left-actions">
              <button
                className="secondary"
                onClick={() => downloadJson("joulewise_custom_dispatch_report_package.json", {
                  report_inputs: {
                    client: settings.reportClientName,
                    project: settings.reportProjectName,
                    version: settings.reportVersion,
                    date: settings.reportDate,
                    prepared_by: settings.reportPreparedBy,
                    reviewer: settings.reportReviewer,
                    methodology: settings.reportMethodology,
                  },
                  capacity: capacityRows,
                  summary: summaryRows,
                  annual_matrix: annualRows,
                  monthly_peak_matrix: monthlyRows,
                  source_report: {
                    source_name: activeReport?.source_name,
                    block_count: activeReport?.block_count,
                    table_count: activeReport?.table_count,
                  },
                })}
              >
                <Download size={18} /> Download custom report package
              </button>
            </div>
          </article>
          <article className="panel span-all">
            <header><h2>2. Project Configuration</h2><span>Custom size entered by user</span></header>
            <DataTable rows={capacityRows} maxRows={10} />
          </article>
          <article className="panel span-all">
            <header><h2>3. Annual Generation, CUF And Availability Matrix</h2><span>Modeled operating years</span></header>
            <EChart option={annualOption} height={430} />
            <DataTable rows={annualRows} maxRows={30} />
          </article>
          <article className="panel span-all">
            <header><h2>4. Monthly Peak Energy Settlement</h2><span>First operating year</span></header>
            <EChart option={monthlyOption} height={400} />
            <DataTable rows={monthlyRows} maxRows={12} />
          </article>
          <DispatchTab result={customResult} embedded />
          <article className="panel span-all">
            <header><h2>6. Source Report Detail Preserved</h2><span>{activeReport?.source_name}</span></header>
            <p className="note">No source report detail is removed. The complete extracted R1 report text and all Word tables are preserved below as the report template/reference, while the sections above are regenerated from the custom dispatch result.</p>
          </article>
        </>
      )}
    </section>
  );
}

function JoulewiseReportTab({ report, customResult, settings, setSettings }) {
  const [fallbackReport, setFallbackReport] = useState(null);
  const [fallbackReportR1, setFallbackReportR1] = useState(null);
  const [reportError, setReportError] = useState("");

  useEffect(() => {
    if (report || fallbackReport) return undefined;
    let cancelled = false;
    fetch("/report_assets/joulewise_hybrid_eya_report.json")
      .then((res) => {
        if (!res.ok) throw new Error(`Report manifest unavailable (${res.status})`);
        return res.json();
      })
      .then((data) => {
        if (!cancelled) setFallbackReport(data);
      })
      .catch((err) => {
        if (!cancelled) setReportError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [report, fallbackReport]);

  useEffect(() => {
    if (fallbackReportR1) return undefined;
    let cancelled = false;
    fetch("/report_assets/joulewise_hybrid_eya_report_r1.json")
      .then((res) => {
        if (!res.ok) throw new Error(`R1 report manifest unavailable (${res.status})`);
        return res.json();
      })
      .then((data) => {
        if (!cancelled) setFallbackReportR1(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [fallbackReportR1]);

  const activeReport = fallbackReportR1 || report || fallbackReport;

  if (!activeReport) {
    return (
      <section className="panel-grid">
        <article className="panel span-all">
          <header><h2>Joulewise Hybrid EYA Report</h2><span>Word report ingestion</span></header>
          <div className="empty-chart">{reportError || "Loading report manifest..."}</div>
        </article>
      </section>
    );
  }

  const summaryTable = findReportTable(activeReport, "Table 13") || findReportTable(activeReport, "Hybrid EYA Results Summary");
  const bessTable = findReportTable(activeReport, "BESS SoH") || findReportTable(activeReport, "SoH and RTE");
  const monthlyP50 = findReportTable(activeReport, "P50 Monthly Energy Settlement");
  const uncertaintyTable = findReportTable(activeReport, "Uncertainty Values");
  const shortageTables = findReportTables(activeReport, "Monthly Shortage");
  const summaryRows = (summaryTable?.body || []).map((row) => ({
    item: row[1],
    p50: reportNumber(row[2]),
    p75: reportNumber(row[3]),
    p90: reportNumber(row[4]),
  }));
  const generationRows = summaryRows.filter((row) => row.item && row.item.includes("(GWh)") && !row.item.includes("Shortfall")).slice(0, 9);
  const keyRows = summaryRows.filter((row) => row.item && (
    row.item.includes("Solar")
    || row.item.includes("Wind")
    || row.item.includes("Hybrid Net Gen")
    || row.item.includes("Energy Sold under PPA")
    || row.item.includes("PPA Availability Shortfall")
  )).slice(0, 10);
  const bessRows = (bessTable?.body || []).map((row) => ({
    year: reportNumber(row[0]),
    usable: reportNumber(row[1]),
    soh: reportNumber(row[2]),
    rte: reportNumber(row[3]),
  })).filter((row) => row.year);
  const monthlyRows = (monthlyP50?.body || []).filter((row) => row[0] && !String(row[0]).toLowerCase().includes("total")).map((row) => ({
    month: row[0],
    re: reportNumber(row[1]),
    ppa: reportNumber(row[10]),
    peak: reportNumber(row[12]),
    peakAvail: reportNumber(row[13]),
  }));
  const uncertaintyRows = (uncertaintyTable?.body || []).map((row) => ({
    type: row[0],
    value: reportNumber(row[1]),
  })).filter((row) => row.type && row.value !== null);
  const shortageRows = shortageTables.map((table) => {
    const level = (table.caption || "").match(/P\\d+/)?.[0] || `Table ${table.caption || ""}`;
    const row = table.rows?.[1] || [];
    return { level, values: row.slice(1).map(reportNumber) };
  }).filter((row) => row.values.length);
  const months = (shortageTables[0]?.rows?.[0] || []).slice(1);

  const pLevelOption = {
    tooltip: { trigger: "axis" },
    legend: { top: 0 },
    grid: { left: 70, right: 24, top: 46, bottom: 84 },
    xAxis: { type: "category", data: generationRows.map((row) => row.item.replace(" at 33 kV", "").replace(" (GWh)", "")), axisLabel: { rotate: 25 } },
    yAxis: { type: "value", name: "GWh" },
    series: [
      { name: "P50", type: "bar", data: generationRows.map((row) => row.p50) },
      { name: "P75", type: "bar", data: generationRows.map((row) => row.p75) },
      { name: "P90", type: "bar", data: generationRows.map((row) => row.p90) },
    ],
  };
  const bessOption = {
    tooltip: { trigger: "axis" },
    legend: { top: 0 },
    grid: { left: 62, right: 58, top: 46, bottom: 44 },
    xAxis: { type: "category", data: bessRows.map((row) => `Y${row.year}`) },
    yAxis: [
      { type: "value", name: "MWh" },
      { type: "value", name: "%", min: 75, max: 105 },
    ],
    series: [
      { name: "DC usable", type: "line", smooth: true, data: bessRows.map((row) => row.usable) },
      { name: "SoH", type: "line", yAxisIndex: 1, smooth: true, data: bessRows.map((row) => row.soh) },
      { name: "RTE", type: "line", yAxisIndex: 1, smooth: true, data: bessRows.map((row) => row.rte) },
    ],
  };
  const monthlyOption = {
    tooltip: { trigger: "axis" },
    legend: { top: 0 },
    grid: { left: 62, right: 46, top: 46, bottom: 54 },
    xAxis: { type: "category", data: monthlyRows.map((row) => row.month) },
    yAxis: [
      { type: "value", name: "MWh" },
      { type: "value", name: "%", min: 85, max: 105 },
    ],
    series: [
      { name: "RE generation", type: "bar", data: monthlyRows.map((row) => row.re) },
      { name: "Net PPA supply", type: "bar", data: monthlyRows.map((row) => row.ppa) },
      { name: "Peak availability", type: "line", yAxisIndex: 1, smooth: true, data: monthlyRows.map((row) => row.peakAvail) },
    ],
  };
  const uncertaintyOption = {
    tooltip: { trigger: "axis" },
    grid: { left: 150, right: 24, top: 24, bottom: 36 },
    xAxis: { type: "value", name: "%" },
    yAxis: { type: "category", data: uncertaintyRows.map((row) => row.type) },
    series: [{ name: "Uncertainty", type: "bar", data: uncertaintyRows.map((row) => row.value) }],
  };
  const shortageOption = {
    tooltip: { trigger: "axis" },
    legend: { top: 0 },
    grid: { left: 62, right: 24, top: 46, bottom: 44 },
    xAxis: { type: "category", data: months },
    yAxis: { type: "value", name: "MWh" },
    series: shortageRows.map((row) => ({ name: row.level, type: "line", smooth: true, data: row.values })),
  };

  return (
    <section className="report-page">
      <article className="report-hero">
        <div>
          <span className="eyebrow">DOCX ingestion</span>
          <h1>{activeReport.title}</h1>
          <p>{activeReport.subtitle}</p>
        </div>
        <div className="report-hero-meta">
          <strong>{activeReport.source_name}</strong>
          <span>{activeReport.block_count} text/table blocks</span>
          <span>{activeReport.table_count} extracted tables</span>
        </div>
      </article>

      <section className="kpi-grid">
        <KpiCard icon={CloudSun} label="Solar" value="275 MWac" detail="409.1 MWp, DC:AC 1.49" />
        <KpiCard icon={Wind} label="Wind" value="44.1 MW" detail="14 x 3.15 MW Suzlon S144" />
        <KpiCard icon={BatteryCharging} label="BESS" value="200 MW / 400 MWh" detail="C-rate 0.50" />
        <KpiCard icon={ShieldCheck} label="PPA" value="200 MW" detail="NHPC FDRE configuration" />
      </section>

      <CustomDispatchReportSection customResult={customResult} settings={settings} setSettings={setSettings} activeReport={activeReport} />

      <section className="panel-grid">
        <article className="panel span-all">
          <header><h2>P-Level Energy Summary</h2><span>Generated from the report's hybrid EYA result table</span></header>
          {generationRows.length ? <EChart option={pLevelOption} height={430} /> : <div className="empty-chart">No P-level generation data found</div>}
        </article>
        <article className="panel span-2">
          <header><h2>BESS SoH / RTE</h2><span>20-year technical schedule</span></header>
          {bessRows.length ? <EChart option={bessOption} height={330} /> : <div className="empty-chart">No BESS schedule found</div>}
        </article>
        <article className="panel">
          <header><h2>Key P-Level Values</h2><span>P50 / P75 / P90</span></header>
          <DataTable rows={keyRows.map((row) => ({ Metric: row.item, P50: row.p50, P75: row.p75, P90: row.p90 }))} maxRows={8} />
        </article>
        <article className="panel span-2">
          <header><h2>P50 Monthly Settlement</h2><span>RE generation, PPA supply and peak availability</span></header>
          {monthlyRows.length ? <EChart option={monthlyOption} height={360} /> : <div className="empty-chart">No monthly settlement found</div>}
        </article>
        <article className="panel">
          <header><h2>Wind Uncertainty</h2><span>AEP uncertainty components</span></header>
          {uncertaintyRows.length ? <EChart option={uncertaintyOption} height={360} /> : <div className="empty-chart">No uncertainty table found</div>}
        </article>
        <article className="panel span-all">
          <header><h2>Monthly Shortage Curves</h2><span>20-year average shortage across P-levels</span></header>
          {shortageRows.length ? <EChart option={shortageOption} height={360} /> : <div className="empty-chart">No shortage tables found</div>}
        </article>
        <article className="panel span-all">
          <header><h2>Complete Report Text & Tables</h2><span>Extracted from the uploaded Joulewise DOCX</span></header>
          <p className="note">The source DOCX contains text and Word tables, with no embedded chart/image parts. The charts above are generated from the extracted report tables; the full extracted content is preserved below.</p>
          <div className="report-reader">
            {(activeReport.blocks || []).map((block, idx) => (
              <div key={idx} className={`report-block report-block-${block.type}`}>
                <ReportBlock block={block} />
              </div>
            ))}
          </div>
        </article>
      </section>
    </section>
  );
}

function ExportsTab({ optimizedResult, customResult, project, settings }) {
  const [exporting, setExporting] = useState("");
  const [exportError, setExportError] = useState("");

  async function downloadFullDispatch(exportProject, name) {
    if (!exportProject) return;
    setExportError("");
    setExporting(name);
    try {
      await downloadApiFile("/api/export/full-dispatch", {
        project: exportProject,
        years_mode: "exact",
        use_wind_profile: settings.windProfile,
        wind_p_level: settings.windLevel,
      }, name);
    } catch (err) {
      setExportError(err.message);
    } finally {
      setExporting("");
    }
  }

  return (
    <section className="panel-grid">
      <article className="panel">
        <header><h2>Project JSON</h2><span>Configuration handoff</span></header>
        <button className="secondary full" onClick={() => downloadJson("fdre_sidebar_project.json", project)}><Download size={18} /> Download sidebar project</button>
        <button className="secondary full" onClick={() => downloadJson("fdre_optimized_project.json", optimizedResult?.project || {})}><Download size={18} /> Download optimized project</button>
      </article>
      <article className="panel">
        <header><h2>25-Year Hourly Dispatch</h2><span>Exact PPA audit export</span></header>
        <button
          className="primary full"
          disabled={!optimizedResult?.project || Boolean(exporting)}
          onClick={() => downloadFullDispatch(optimizedResult?.project, "fdre_optimized_25yr_dispatch.zip")}
        >
          {exporting === "fdre_optimized_25yr_dispatch.zip" ? <Loader2 className="spin" size={18} /> : <Download size={18} />} Download optimized ZIP
        </button>
        <button
          className="secondary full"
          disabled={!customResult?.project || Boolean(exporting)}
          onClick={() => downloadFullDispatch(customResult?.project, "fdre_custom_25yr_dispatch.zip")}
        >
          {exporting === "fdre_custom_25yr_dispatch.zip" ? <Loader2 className="spin" size={18} /> : <Download size={18} />} Download custom ZIP
        </button>
        {exportError && <div className="alert slim-alert">{exportError}</div>}
        <p className="note">The ZIP contains hourly, monthly and yearly CSV files for all 25 contract years, using 8760 modeled hours per year.</p>
      </article>
      <article className="panel">
        <header><h2>Annual Generation Matrix</h2><span>Generation, CUF and availability</span></header>
        <button
          className="secondary full"
          disabled={!optimizedResult}
          onClick={() => downloadCsv("fdre_optimized_annual_generation_cuf_availability.csv", annualGenerationMatrixRows(optimizedResult))}
        >
          <Download size={18} /> Download optimized annual matrix
        </button>
        <button
          className="secondary full"
          disabled={!customResult}
          onClick={() => downloadCsv("fdre_custom_annual_generation_cuf_availability.csv", annualGenerationMatrixRows(customResult))}
        >
          <Download size={18} /> Download custom annual matrix
        </button>
      </article>
      <article className="panel">
        <header><h2>Finance Model Sheet</h2><span>Calculation logic</span></header>
        <button
          className="secondary full"
          onClick={() => downloadCsv("fdre_finance_model_explanation.csv", financeModelExplanationRows(settings))}
        >
          <Download size={18} /> Download finance explanation
        </button>
        <p className="note">This sheet explains revenue, capex, opex, working capital, tax, debt sculpting and tariff solve logic.</p>
      </article>
      <article className="panel span-2">
        <header><h2>Export scope</h2><span>React demo parity</span></header>
        <ul className="checks">
          <li><CheckCircle2 /> Optimized and custom project JSON exports</li>
          <li><CheckCircle2 /> Finance, compliance, monthly and dispatch tables visible in browser</li>
          <li><CheckCircle2 /> Full 25-year hourly PPA dispatch ZIP from the React backend</li>
          <li><CheckCircle2 /> Annual generation, CUF and availability matrix CSV</li>
          <li><CheckCircle2 /> Finance model explanation CSV</li>
        </ul>
        <DataTable rows={[
          { Artifact: "Optimized result", Status: optimizedResult ? "Available" : "Run optimizer" },
          { Artifact: "Custom/sidebar result", Status: customResult ? "Available" : "Evaluate custom case" },
          { Artifact: "25-year hourly dispatch", Status: optimizedResult || customResult ? "Available as ZIP" : "Run optimizer or custom case" },
          { Artifact: "EYA report", Status: "Visible summary, printable report endpoint pending" },
        ]} />
      </article>
    </section>
  );
}

function OptimizationTab({ optimizedResult, onOptimize, loading }) {
  const variables = optimizedResult?.optimizer?.variables || {};
  const optimizerBounds = optimizedResult?.optimizer?.bounds || null;
  const status = optimizedResult?.status || {};
  const totals = optimizedResult?.operating?.totals || {};
  const cap = optimizedResult?.capacity || {};
  const bidMw = Number(variables.contracted_capacity_mw ?? cap.contracted_capacity_mw ?? 0);
  const bessPower = Number(variables.bess_power_mw ?? cap.bess_power_mw ?? 0);
  const bessEnergy = Number(variables.bess_energy_mwh ?? cap.bess_energy_mwh ?? 0);
  const bessUsableY1 = Number(cap.bess_usable_poi_mwh_y1 ?? 0);
  const bessUsableFinal = Number(cap.bess_usable_poi_mwh_final ?? 0);
  const bessUsableMin = Number(cap.bess_usable_poi_mwh_min ?? bessUsableFinal);
  const fixedBessDuration = optimizedResult?.optimizer?.fixed_bess_duration_hours;
  const bessDurationNameplate = Number(cap.bess_nameplate_duration_hours ?? (bessPower > 0 ? bessEnergy / bessPower : 0));
  const bessDurationY1 = Number(cap.bess_usable_duration_hours_y1 ?? (bessPower > 0 ? bessUsableY1 / bessPower : 0));
  const bessDurationFinal = Number(cap.bess_usable_duration_hours_final ?? (bessPower > 0 ? bessUsableFinal / bessPower : 0));
  const tender = optimizedResult?.project?.tender || {};
  const morningPeakHours = tender.fixed_morning_peak_hours || [];
  const eveningPeakHours = tender.fixed_evening_peak_hours || [];
  const morningWindow = tender.morning_window || [5, 10];
  const eveningWindow = tender.evening_window || [18, 23];
  const morningPeakCount = morningPeakHours.length || 2;
  const eveningPeakCount = eveningPeakHours.length || 2;
  const dailyPeakHours = morningPeakCount + eveningPeakCount;
  const longestSplitWindowHours = Math.max(morningPeakCount, eveningPeakCount);
  const peakPowerFloor = bidMw * 0.9;
  const splitWindowEnergyFloor = peakPowerFloor * longestSplitWindowHours;
  const dailyPeakEnergyObligation = peakPowerFloor * dailyPeakHours;
  const totalGeneratedForSale = Number(totals.ppa_gwh || 0) + Number(totals.merchant_gwh || 0) + Number(totals.spill_gwh || 0);
  const spillShare = totalGeneratedForSale > 0 ? Number(totals.spill_gwh || 0) / totalGeneratedForSale : 0;
  const annualCufFloor = Number(totals.annual_cuf_floor ?? 0);
  const annualCufCeiling = Number(totals.annual_cuf_ceiling ?? 0);
  const maxAnnualCuf = Number(totals.max_annual_cuf ?? 0);
  const maxCufCapUtilization = Number(totals.max_cuf_cap_utilization ?? 0);
  const socReserveFraction = Number(optimizedResult?.project?.simulation?.nonpeak_discharge_soc_reserve_fraction ?? 1);
  const isFeasible = Boolean(optimizedResult?.optimizer?.success) && status.reason === "ok" && optimizedResult?.tariff_label !== "Infeasible";
  return (
    <section className="panel-grid">
      <article className="panel">
        <header><h2>Optimization</h2><span>Run capacity optimizer</span></header>
        <p className="note">The optimizer uses a HiGHS LP seed followed by nonlinear hourly dispatch and project-finance evaluation.</p>
        <div className="panel-actions left-actions">
          <button className="primary" onClick={onOptimize} disabled={Boolean(loading)}>
            {loading ? <Loader2 className="spin" size={18} /> : <Zap size={18} />} Run optimization
          </button>
        </div>
      </article>
      <article className="panel span-2">
        <header>
          <h2>{isFeasible || !optimizedResult ? "Optimized capacity outputs" : "Best attempted capacity output"}</h2>
          <span>{isFeasible || !optimizedResult ? "Solar, wind and BESS sizing" : "No feasible tariff under selected hard constraints"}</span>
        </header>
        <div className="optimizer-vars">
          <div><span>Solar MW</span><strong>{num(variables.solar_ac_mw ?? optimizedResult?.capacity?.solar_ac_mw, 1)}</strong></div>
          <div><span>Wind MW</span><strong>{num(variables.wind_mw ?? optimizedResult?.capacity?.wind_mw, 1)}</strong></div>
          <div><span>BESS MW</span><strong>{num(variables.bess_power_mw ?? optimizedResult?.capacity?.bess_power_mw, 1)}</strong></div>
          <div><span>BESS MWh</span><strong>{num(variables.bess_energy_mwh ?? optimizedResult?.capacity?.bess_energy_mwh, 1)}</strong></div>
          <div><span>Selected bid capacity MW</span><strong>{num(variables.contracted_capacity_mw ?? optimizedResult?.capacity?.contracted_capacity_mw, 1)}</strong></div>
          <div><span>Tariff</span><strong>{optimizedResult?.tariff_label || "Run"}</strong></div>
        </div>
        {optimizedResult && !isFeasible && (
          <div className="alert slim-alert">
            Infeasible because {status.reason || "hard constraints are not met"}. Minimum peak availability is {pct(totals.min_peak_availability, 1)} and annual CUF floor check reaches {pct(totals.min_annual_cuf, 1)}.
          </div>
        )}
        {optimizedResult && isFeasible && spillShare > 0.05 && (
          <div className="alert slim-alert">
            High spill warning: {num(totals.spill_gwh || 0, 1)} GWh is being curtailed ({pct(spillShare, 1)} of modeled RE energy). This usually means the fixed contracted capacity or hard compliance settings are forcing overbuild; reduce contracted capacity or widen lower-spill technology bounds before using this as the bid case.
          </div>
        )}
      </article>
      {optimizedResult && (
        <article className="panel span-all">
          <header><h2>Sizing Diagnostics</h2><span>Why the selected portfolio looks the way it does</span></header>
          <DataTable rows={[
            { Metric: "Minimum peak availability", Value: pct(totals.min_peak_availability, 2), Interpretation: "Must be at least 90.0% for hard compliance" },
            { Metric: "Annual CUF band", Value: `${pct(totals.min_annual_cuf, 2)} min / ${pct(maxAnnualCuf, 2)} max`, Interpretation: `Tender band is ${pct(annualCufFloor, 2)} to ${pct(annualCufCeiling, 2)} of declared CUF; +10% band is enforced as annual PPA cap` },
            { Metric: "Annual PPA cap utilization", Value: pct(maxCufCapUtilization, 1), Interpretation: "Share of the +10% CUF offtake ceiling used in the tightest modeled year" },
            { Metric: "Spill energy", Value: `${num(totals.spill_gwh || 0, 1)} GWh`, Interpretation: `${pct(spillShare, 1)} of modeled RE energy after PPA/merchant use` },
            { Metric: "BESS peak-power floor", Value: `${num(peakPowerFloor, 1)} MW`, Interpretation: `90% x ${num(bidMw, 1)} MW selected bid capacity` },
            { Metric: "Peak schedule", Value: `${num(morningPeakCount, 0)}h morning + ${num(eveningPeakCount, 0)}h evening`, Interpretation: `${num(morningWindow[0], 0)}:00-${num(morningWindow[1], 0)}:00 and ${num(eveningWindow[0], 0)}:00-${num(eveningWindow[1], 0)}:00 buyer windows` },
            { Metric: "Per-window energy floor", Value: `${num(splitWindowEnergyFloor, 1)} MWh`, Interpretation: `Longest split window only; not a continuous ${num(dailyPeakHours, 0)}h block` },
            { Metric: "Daily peak energy obligation", Value: `${num(dailyPeakEnergyObligation, 1)} MWh/day`, Interpretation: `Total scheduled peak energy across both daily windows before RE contribution` },
            { Metric: "Installed BESS nameplate", Value: `${num(bessEnergy, 1)} MWh`, Interpretation: "Capex is applied to installed battery energy" },
            { Metric: "Usable BESS at PoI, year 1", Value: `${num(bessUsableY1, 1)} MWh`, Interpretation: "Dispatch reservoir after usable-energy and availability assumptions" },
            { Metric: `Usable BESS at PoI, year ${tender.ppa_years || 25}`, Value: `${num(bessUsableFinal, 1)} MWh`, Interpretation: `End-of-PPA SoH case; minimum modeled usable is ${num(bessUsableMin, 1)} MWh` },
            { Metric: "Non-peak SOC reserve", Value: pct(socReserveFraction, 0), Interpretation: "Only SOC above this reliability buffer can be used for non-peak PPA top-up; the buffer protects monthly peak availability" },
            { Metric: "BESS duration search mode", Value: fixedBessDuration ? `${num(fixedBessDuration, 1)}h fixed` : "Open duration", Interpretation: fixedBessDuration ? "Optimizer links BESS MWh directly to BESS MW for every candidate" : "Optimizer can choose BESS MW and BESS MWh independently within bounds" },
            { Metric: "Selected BESS duration", Value: bessPower > 0 ? `${num(bessDurationNameplate, 2)}h nameplate / ${num(bessDurationY1, 2)}h Y1 usable / ${num(bessDurationFinal, 2)}h final usable` : "N/A", Interpretation: "The optimizer is not forcing a 4h continuous block; it tests split-window dispatch across the PPA term" },
          ]} />
          <p className="note">High spill means the candidate is using extra RE to satisfy firm supply while annual PPA energy is capped by CUF rules. The tender peak obligation is split: two hours in the morning window and two hours in the evening window. BESS sizing is tested against split-window dispatch with recharge possible between windows, while still respecting RTE, state-of-health degradation, annual solar degradation, monthly peak compliance and the SOC reserve needed for the next peak block.</p>
        </article>
      )}
      {optimizedResult && !isFeasible && (
        <article className="panel span-all">
          <header><h2>Why Tariff Is Infeasible</h2><span>Hard tender compliance diagnosis</span></header>
          <DataTable rows={[
            { Check: "Monthly peak availability", Required: ">= 90.0%", Actual: pct(totals.min_peak_availability, 1), Status: status.peak_ok ? "Pass" : "Fail" },
            { Check: "Annual CUF lower band", Required: `>= ${pct(annualCufFloor, 1)}`, Actual: pct(totals.min_annual_cuf, 1), Status: status.annual_cuf_ok ? "Pass" : "Fail" },
            { Check: "Annual CUF upper band", Required: `<= ${pct(annualCufCeiling, 1)}`, Actual: pct(totals.max_annual_cuf, 1), Status: status.annual_cuf_upper_ok === false ? "Fail" : "Pass" },
            { Check: "Modeled penalty energy", Required: "0 GWh", Actual: `${num(totals.penalty_gwh, 1)} GWh`, Status: totals.penalty_gwh > 0 ? "Fail" : "Pass" },
          ]} />
          <p className="note">The optimizer can return the best attempted candidate when no candidate inside the selected bounds clears hard compliance. Widen Solar/Wind/BESS bounds, allow BESS duration, reduce contracted capacity, or turn off hard compliance to price penalties.</p>
        </article>
      )}
      {optimizedResult && optimizerBounds && (
        <article className="panel span-all">
          <header><h2>Optimizer Bounds Used</h2><span>Exact min/max values received by the backend</span></header>
          <DataTable rows={boundsRows(optimizerBounds)} />
        </article>
      )}
      <article className="panel span-all">
        <header><h2>Next Step</h2><span>Post-optimization assessment</span></header>
        <p className="note">{isFeasible || !optimizedResult ? "After sizing is solved, open Optimized EYA to review scaled energy yield, hourly dispatch, BESS SOC and tender compliance for the optimized portfolio." : "Adjust the search bounds or compliance assumptions, then run optimization again before using Optimized EYA as the client-facing bid case."}</p>
      </article>
    </section>
  );
}

function ValidationRowTable({ rows = [], maxRows = 14 }) {
  const mapped = rows.map((row) => ({
    Case: row.label,
    Category: row.category,
    Tariff: row.tariff_rs_per_kwh == null ? "Infeasible" : `Rs ${num(row.tariff_rs_per_kwh, 2)}/kWh`,
    "Delta tariff": row.delta_tariff_rs_per_kwh == null ? "N/A" : `${row.delta_tariff_rs_per_kwh >= 0 ? "+" : ""}${num(row.delta_tariff_rs_per_kwh, 3)}`,
    Solar: `${num(row.solar_mw, 1)} MW`,
    Wind: `${num(row.wind_mw, 1)} MW`,
    "BESS MW": `${num(row.bess_mw, 1)} MW`,
    "BESS MWh": `${num(row.bess_mwh, 1)} MWh`,
    "Peak avail.": pct(row.min_peak_availability, 2),
    "Annual CUF min": pct(row.annual_cuf, 2),
    "Annual CUF max": pct(row.max_annual_cuf, 2),
    "CUF cap used": pct(row.max_cuf_cap_utilization, 1),
    "Peak gap": row.peak_gap_pct_points == null ? "N/A" : `${num(row.peak_gap_pct_points, 2)} pp`,
    "CUF gap": row.cuf_gap_pct_points == null ? "N/A" : `${num(row.cuf_gap_pct_points, 2)} pp`,
    "Upper excess": row.cuf_upper_excess_pct_points == null ? "N/A" : `${num(row.cuf_upper_excess_pct_points, 2)} pp`,
    "Spill": `${num(row.spill_gwh, 1)} GWh`,
    "Project cost": row.project_cost_cr == null ? "N/A" : `Rs ${num(row.project_cost_cr, 1)} cr`,
    "Binding failure": row.binding_failure || "None",
    Status: row.feasible ? "Pass" : row.reason,
  }));
  return <DataTable rows={mapped} maxRows={maxRows} />;
}

function OptimizerValidationTab({ optimizedResult, validationResult, validationLoading, onRunValidation }) {
  if (!optimizedResult) {
    return (
      <section className="panel-grid">
        <article className="panel span-all">
          <header><h2>Optimizer Validation</h2><span>Run optimization first</span></header>
          <div className="empty-chart">Run the optimizer once. This tab then independently checks whether the selected sizing is close to the best nearby compliant solution.</div>
        </article>
      </section>
    );
  }

  const winner = validationResult?.winner;
  const exact = validationResult?.full_25_year;
  const confidence = validationResult?.confidence;
  const nearMissSummary = validationResult?.near_miss_summary || {};
  const heatmap = validationResult?.heatmap || [];
  const solarFactors = [...new Set(heatmap.map((d) => `${Math.round(Number(d.solar_factor) * 100)}%`))];
  const bessFactors = [...new Set(heatmap.map((d) => `${Math.round(Number(d.bess_energy_factor) * 100)}%`))];
  const heatmapOption = {
    tooltip: {
      position: "top",
      formatter: (params) => {
        const row = heatmap[params.data[3]];
        if (!row) return "";
        return `${row.label}<br/>${row.tariff_rs_per_kwh == null ? "Infeasible" : `Rs ${num(row.tariff_rs_per_kwh, 2)}/kWh`}<br/>${row.reason}`;
      },
    },
    grid: { left: 70, right: 24, top: 36, bottom: 52 },
    xAxis: { type: "category", name: "Solar factor", data: solarFactors, splitArea: { show: true } },
    yAxis: { type: "category", name: "BESS MWh factor", data: bessFactors, splitArea: { show: true } },
    visualMap: {
      min: Math.min(...heatmap.map((d) => Number(d.tariff_rs_per_kwh || 0)).filter((v) => v > 0), 0),
      max: Math.max(...heatmap.map((d) => Number(d.tariff_rs_per_kwh || 0)), 1),
      calculable: true,
      orient: "horizontal",
      left: "center",
      bottom: 4,
      inRange: { color: ["#161616", "#2f5f7d", "#d4ff3f"] },
    },
    series: [{
      name: "Tariff",
      type: "heatmap",
      data: heatmap.map((row, idx) => [
        solarFactors.indexOf(`${Math.round(Number(row.solar_factor) * 100)}%`),
        bessFactors.indexOf(`${Math.round(Number(row.bess_energy_factor) * 100)}%`),
        row.tariff_rs_per_kwh == null ? null : Number(row.tariff_rs_per_kwh),
        idx,
      ]),
      label: {
        show: true,
        formatter: (params) => params.data[2] == null ? "Fail" : num(params.data[2], 2),
      },
      emphasis: { itemStyle: { shadowBlur: 10, shadowColor: "rgba(0, 0, 0, 0.25)" } },
    }],
  };

  const confidenceIcon = confidence?.score === "Strong" ? ShieldCheck : confidence?.score === "Moderate" ? AlertTriangle : AlertTriangle;
  return (
    <section className="panel-grid">
      <article className="panel span-all">
        <header><h2>Optimizer Validation</h2><span>Independent checks around the selected portfolio</span></header>
        <p className="note">This page checks whether the optimizer winner is robust by perturbing the selected capacity, testing a nearby grid, confirming the winner on the full 25-year PPA term, and listing cheaper or failing near-misses.</p>
        <div className="panel-actions left-actions">
          <button className="primary" onClick={onRunValidation} disabled={Boolean(validationLoading)}>
            {validationLoading ? <Loader2 className="spin" size={18} /> : <ShieldCheck size={18} />} Run optimizer validation
          </button>
        </div>
      </article>
      {!validationResult && (
        <article className="panel span-all">
          <header><h2>Validation Checklist</h2><span>What will run</span></header>
          <DataTable rows={[
            { Check: "Winner summary", Output: "Selected solar, wind, BESS and tariff" },
            { Check: "Bounds hit test", Output: "Whether any variable is at min/max" },
            { Check: "Local perturbation matrix", Output: "+/-5% and +/-10% tariff/compliance results" },
            { Check: "Grid search heatmap", Output: "Nearby solar vs BESS MWh alternatives" },
            { Check: "Full 25-year confirmation", Output: "Tariff, IRR, DSCR and compliance" },
            { Check: "Top 10 feasible alternatives", Output: "Sorted by tariff" },
            { Check: "Top infeasible near-misses", Output: "Failure reason and penalty indicators" },
            { Check: "Confidence score", Output: "Strong / Moderate / Weak" },
          ]} />
        </article>
      )}
      {validationResult && (
        <>
          <article className="panel span-all">
            <header><h2>Confidence Score</h2><span>{validationResult.evaluated_candidates} nearby candidates evaluated</span></header>
            <div className="statement-kpis">
              <KpiCard icon={confidenceIcon} label="Confidence" value={confidence?.score || "N/A"} detail={confidence?.rationale || ""} tone={confidence?.score === "Strong" ? "good" : "warning"} />
              <KpiCard icon={CircleDollarSign} label="Winner tariff" value={winner?.tariff_rs_per_kwh == null ? "Infeasible" : `Rs ${num(winner.tariff_rs_per_kwh, 2)}/kWh`} detail="representative-year validation" />
              <KpiCard icon={ShieldCheck} label="Full 25-year tariff" value={exact?.tariff_rs_per_kwh == null ? "Infeasible" : `Rs ${num(exact.tariff_rs_per_kwh, 2)}/kWh`} detail={`Peak ${pct(exact?.min_peak_availability, 2)}`} />
              <KpiCard icon={Activity} label="Cheaper cases" value={num(confidence?.cheaper_feasible_count || 0, 0)} detail="nearby feasible alternatives below winner tariff" />
            </div>
            <p className="note">{validationResult.methodology}</p>
          </article>
          <article className="panel span-all">
            <header><h2>Validation Checklist</h2><span>Check and output</span></header>
            <DataTable rows={validationResult.validation_checks || []} />
          </article>
          <article className="panel span-all">
            <header><h2>Winner Summary</h2><span>Selected solar, wind, BESS and tariff</span></header>
            <ValidationRowTable rows={[winner]} />
          </article>
          <article className="panel span-all">
            <header><h2>Bounds Hit Test</h2><span>Min/max pressure on optimizer variables</span></header>
            <DataTable rows={validationResult.bounds_hit || []} />
          </article>
          <article className="panel span-all">
            <header><h2>Local Perturbation Matrix</h2><span>+/-5% and +/-10% one-variable checks</span></header>
            <ValidationRowTable rows={validationResult.local_perturbations || []} maxRows={24} />
          </article>
          <article className="panel span-all">
            <header><h2>Grid Search Heatmap</h2><span>Nearby solar vs BESS MWh alternatives</span></header>
            {heatmap.length ? <EChart option={heatmapOption} height={420} /> : <div className="empty-chart">No heatmap data available</div>}
          </article>
          <article className="panel span-all">
            <header><h2>Full 25-Year Confirmation</h2><span>Exact PPA dispatch and finance re-run</span></header>
            <ValidationRowTable rows={[exact]} />
          </article>
          <article className="panel span-all">
            <header><h2>Near-Miss Cases</h2><span>Why cheaper or leaner designs were rejected</span></header>
            <div className="statement-kpis">
              <KpiCard icon={AlertTriangle} label="Failed cases tested" value={num(nearMissSummary.infeasible_count || 0, 0)} detail="nearby candidates that did not clear hard constraints" tone="warning" />
              <KpiCard icon={ShieldCheck} label="Closest near-miss" value={nearMissSummary.closest_case || "None"} detail={`${nearMissSummary.closest_failure || "No failure"}; peak gap ${nearMissSummary.closest_peak_gap_pct_points == null ? "N/A" : `${num(nearMissSummary.closest_peak_gap_pct_points, 2)} pp`}`} />
              <KpiCard icon={CircleDollarSign} label="Lower-cost failures" value={num(nearMissSummary.lower_cost_failed_count || 0, 0)} detail="failed candidates with lower project cost than winner" />
              <KpiCard icon={Activity} label="Lowest-cost failed case" value={nearMissSummary.lowest_cost_failed_case || "None"} detail="use gap columns to see why it failed" />
            </div>
          </article>
          <article className="panel span-all">
            <header><h2>Top 10 Feasible Alternatives</h2><span>Sorted by tariff</span></header>
            <ValidationRowTable rows={validationResult.top_feasible || []} maxRows={10} />
          </article>
          <article className="panel span-all">
            <header><h2>Closest Infeasible Near-Misses</h2><span>Smallest peak/CUF/penalty gap first</span></header>
            <ValidationRowTable rows={validationResult.near_misses || []} maxRows={10} />
          </article>
          <article className="panel span-all">
            <header><h2>Lower-Cost Failed Cases</h2><span>Cheaper portfolios that fail tender compliance</span></header>
            <ValidationRowTable rows={validationResult.cheap_near_misses || []} maxRows={10} />
            <p className="note">These cases are important because they show why a lower-cost portfolio is not automatically a better bid: the table exposes the binding failure, peak/CUF gap and penalty energy.</p>
          </article>
        </>
      )}
    </section>
  );
}

function ResultsTab({ optimizedResult, customResult, settings, setSettings, onEvaluate, loading }) {
  return (
    <>
      <ResultHeader
        result={optimizedResult}
        title="Results"
        subtitle="Optimized result is the client-facing bid case. The current/manual case can be evaluated below for comparison."
        loading={loading}
        statusLabel="Optimized output"
      />
      <section className="panel-grid">
        <CustomInputsPanel settings={settings} setSettings={setSettings} onEvaluate={onEvaluate} loading={loading} />
        {customResult && (
          <article className="panel span-all">
            <header><h2>Custom case output</h2><span>Can be infeasible under hard constraints</span></header>
            <ResultHeader result={customResult} title="Custom Case Result" subtitle="Manual capacity and tender inputs." loading={loading} statusLabel="Custom output" />
          </article>
        )}
      </section>
    </>
  );
}

function ReportsTab({ defaults, optimizedResult, customResult, project, settings }) {
  return (
    <section className="workflow-stack">
      <ExportsTab optimizedResult={optimizedResult} customResult={customResult} project={project} settings={settings} />
    </section>
  );
}

function fdreSummary(settings, result, source) {
  const cap = result?.capacity || {};
  const fin = result?.finance || {};
  const totals = result?.operating?.totals || {};
  const num = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));
  return {
    source,
    solarMw: num(cap.solar_ac_mw),
    windMw: num(cap.wind_mw),
    bessMw: num(cap.bess_power_mw),
    bessMwh: num(cap.bess_energy_mwh),
    capexCr: num(fin.total_project_cost_cr),
    tariff: num(result?.tariff),
    equityIrr: num(fin.equity_irr),
    projectIrr: num(fin.project_irr),
    minDscr: num(fin.min_dscr),
    contractedMw: num(settings.contractedCapacity),
    minPeakAvailability: num(totals.min_peak_availability),
    penaltyGwh: num(totals.penalty_gwh),
  };
}

function Restricted({ label, contacts = [] }) {
  return (
    <section className="restricted">
      <Lock size={28} />
      <span className="rtc-index">RESTRICTED</span>
      <h2>{label}</h2>
      <p>Your account does not have access to this tab. <strong>Contact Administrator</strong> to have it enabled.</p>
      {contacts.length > 0 && (
        <ul>
          {contacts.map((c) => (
            <li key={c.email}><a href={`mailto:${c.email}?subject=${encodeURIComponent(`FDRE access: ${label}`)}`}>{c.name || c.email}</a>{c.name && <small>{c.email}</small>}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default function App({ user = null, initialScenario = null }) {
  const allowed = useMemo(() => new Set(user?.allowedTabs ?? ALL_TAB_IDS), [user]);
  const needsEngine = usesEngine([...allowed]);
  const firstAllowed = ALL_TAB_IDS.find((id) => allowed.has(id)) || "rtc";
  const [defaults, setDefaults] = useState(null);
  const [optimizedResult, setOptimizedResult] = useState(null);
  const [customResult, setCustomResult] = useState(null);
  const [dispatchResult, setDispatchResult] = useState(null);
  const [financeResult, setFinanceResult] = useState(null);
  const [scenarioInputs, setScenarioInputs] = useState(() => defaultScenarioInputs());
  const [scenarioResult, setScenarioResult] = useState(null);
  const [scenarioLoading, setScenarioLoading] = useState("");
  const [validationResult, setValidationResult] = useState(null);
  const [validationLoading, setValidationLoading] = useState("");
  const [pvsystReports, setPvsystReports] = useState([]);
  const [activeTab, setActiveTab] = useState(() => {
    if (initialScenario?.scenario?.module === "fdre") return "results";
    if (initialScenario?.scenario?.module === "rtc") return "rtc";
    if (initialScenario?.scenario?.module === "bess") return "bessTender";
    return allowed.has("rtc") ? "rtc" : firstAllowed;
  });
  const [fdreLinked, setFdreLinked] = useState(null);
  // usage log: active time and which tabs are opened
  useEffect(() => { startActivityTracker(); }, []);
  useEffect(() => { if (allowed.has(activeTab)) trackEvent("tab", { tab: activeTab }); }, [activeTab, allowed]);
  const [showSave, setShowSave] = useState(false);
  const [notice, setNotice] = useState("");
  // Long engine runs finish in the background: only jump to their result tab if the user is
  // still where the run started (or already on that tab); otherwise leave them where they are.
  const activeTabRef = useRef(activeTab);
  useEffect(() => { activeTabRef.current = activeTab; }, [activeTab]);
  const TAB_NAMES = { optimization: "Optimization", results: "Results", customDispatch: "Custom Dispatch", finance: "Financial Inputs", validation: "Optimizer Validation" };
  const showResult = (startTab, target, what) => {
    if (activeTabRef.current === startTab || activeTabRef.current === target) setActiveTab(target);
    else setNotice(`${what} finished. Open ${TAB_NAMES[target] || target} to see it.`);
  };
  const [loading, setLoading] = useState("Booting model");
  const [error, setError] = useState("");
  const [settings, setSettings] = useState({
    yearsMode: "fast",
    windProfile: true,
    windLevel: "P50",
    solarLevel: "P50",
    tenderProcurementMw: 1200,
    contractedCapacity: 200,
    declaredCuf: 40,
    dispatchMinCuf: 40,
    dispatchPeakAvailability: 90,
    dispatchMorningPeakStart: 8,
    dispatchMorningPeakEnd: 10,
    dispatchEveningPeakStart: 18,
    dispatchEveningPeakEnd: 20,
    hardCompliance: true,
    externalSupport: false,
    enableSolar: true,
    enableWind: true,
    enableBess: true,
    forceTwoHourBess: false,
    bessRtePercent: 86.68,
    bessDodPercent: 94.6,
    bessAvailabilityPercent: 100,
    solarAcMw: 300,
    windMw: 31.5,
    bessPowerMw: 185,
    bessEnergyMwh: 740,
    solarMinMw: 225,
    solarMaxMw: 450,
    windMinMw: 15.75,
    windMaxMw: 63,
    bessPowerMinMw: 0,
    bessPowerMaxMw: 277.5,
    bessEnergyMinMwh: 0,
    bessEnergyMaxMwh: 1110,
    debtFraction: 75,
    interestRate: 8.75,
    targetEquityIrr: 14,
    minDscr: 1.1,
    repaymentStyle: "sculpted",
    sculptTargetDscr: 1.1,
    sizeDebtByDscr: true,
    solarCapexCrPerMw: 3.10,
    windCapexCrPerMw: 6.50,
    bessEnergyCapexCrPerMwh: 1.10,
    bessPcsCapexCrPerMw: 0.30,
    enableBessAugmentation: false,
    bessAugmentationStartYear: 6,
    bessAugmentationAnnualPct: 3,
    bessAugmentationCostDeclinePct: 6,
    bessAugmentationFloorCostCrPerMwh: 0.45,
    landSolarCrPerMw: 0.45,
    landWindCrPerMw: 0.08,
    landBessCrPerMwh: 0.02,
    transmissionCrPerMw: 1.0,
    ownerCostsCrPerMw: 0.12,
    adminOpexCrYear: 5.0,
    adminOpexLakhPerMwYear: 0.75,
    transmissionOpexLakhPerMwYear: 2.0,
    transmissionLossPercent: 0.5,
    receivableDays: 60,
    workingCapitalInterestRate: 9.5,
    reportClientName: "Client / Buying Entity",
    reportProjectName: "Hybrid EYA Report - Custom FDRE Dispatch Case",
    reportVersion: "R1",
    reportDate: "2026-07-12",
    reportPreparedBy: "Joulewise Advisory Private Limited",
    reportReviewer: "Reviewer",
    reportMethodology: "Hourly FDRE dispatch engine using uploaded/normalized solar and wind yield, BESS RTE/DoD/SoH, monthly peak availability and annual CUF tests.",
    reportDcAcRatio: 1.49,
    reportSolarSite1Name: "Site 1 - Bikaner, Rajasthan",
    reportSolarSite1Mw: 240,
    reportSolarSite2Name: "Site 2 - Bikaner, Rajasthan",
    reportSolarSite2Mw: 60,
    reportWindSite: "Barmer region, Rajasthan",
    reportWindDetails: "3.15 MW WTG basis",
    reportBessSite: "Bikaner / project PoI",
    technologyOption: "Hybrid",
  });

  const sidebarProject = useMemo(() => {
    if (!defaults?.project) return null;
    return cloneProjectWith(defaults.project, settings);
  }, [defaults, settings]);

  async function optimize(project = sidebarProject, navigate = true) {
    const startTab = activeTabRef.current;
    if (!project || !defaults?.project) return;
    setError("");
    const bounds = optimizerBoundsFromSettings(settings);
    try {
      validateOptimizerBounds(bounds);
    } catch (err) {
      setError(err.message);
      return;
    }
    setLoading("Optimizing capacity with HiGHS seed");
    try {
      const optimizerProject = cloneProjectWith(defaults.project, settings, { capacity: false, tender: true, finance: true });
      const optimized = await api("/api/optimize", {
        project: optimizerProject,
        years_mode: settings.yearsMode,
        use_wind_profile: settings.windProfile,
        wind_p_level: settings.windLevel,
        effort: "fast",
        bounds,
        fixed_bess_duration_hours: settings.forceTwoHourBess ? 2 : null,
      });
      setOptimizedResult(optimized);
      setFinanceResult(null);
      setScenarioResult(null);
      setValidationResult(null);
      setScenarioInputs(defaultScenarioInputs(settings));
      if (navigate) showResult(startTab, "optimization", "FDRE optimization");
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading("");
    }
  }

  async function evaluateCustom() {
    const startTab = activeTabRef.current;
    if (!sidebarProject) return;
    setError("");
    setLoading("Evaluating sidebar custom case");
    try {
      const evaluated = await api("/api/evaluate", {
        project: sidebarProject,
        years_mode: settings.yearsMode,
        use_wind_profile: settings.windProfile,
        wind_p_level: settings.windLevel,
      });
      setCustomResult(evaluated);
      showResult(startTab, "results", "Evaluation");
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading("");
    }
  }

  async function runCustomDispatch() {
    const startTab = activeTabRef.current;
    if (!defaults?.project) return;
    setError("");
    setLoading("Running custom dispatch");
    try {
      const dispatchProject = cloneProjectWith(
        defaults.project,
        { ...settings, hardCompliance: true, externalSupport: false, useCustomDispatchRules: true },
        { capacity: true, tender: true, finance: false },
      );
      const evaluated = await api("/api/evaluate", {
        project: dispatchProject,
        years_mode: settings.yearsMode,
        use_wind_profile: settings.windProfile,
        wind_p_level: settings.windLevel,
      });
      setDispatchResult(evaluated);
      setCustomResult(evaluated);
      showResult(startTab, "customDispatch", "Custom dispatch");
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading("");
    }
  }

  async function financeRerun() {
    const startTab = activeTabRef.current;
    if (!optimizedResult?.project) return;
    setError("");
    setLoading("Recalculating finance on fixed optimized sizing");
    try {
      const fixedProject = cloneProjectWith(optimizedResult.project, financeOnlyUpdates(settings), { capacity: false, tender: true, finance: true });
      const rerun = await api("/api/evaluate", {
        project: fixedProject,
        years_mode: settings.yearsMode,
        use_wind_profile: settings.windProfile,
        wind_p_level: settings.windLevel,
      });
      setFinanceResult(rerun);
      showResult(startTab, "finance", "Finance re-run");
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading("");
    }
  }

  async function runScenario(nextInputs = scenarioInputs, { quiet = false } = {}) {
    if (!optimizedResult?.project) return;
    if (!quiet) setError("");
    setScenarioLoading("Recalculating scenario finance");
    try {
      const scenarioProject = cloneProjectWith(
        optimizedResult.project,
        financeOnlyUpdates({ ...settings, ...nextInputs }),
        { capacity: false, tender: true, finance: true },
      );
      const rerun = await api("/api/evaluate", {
        project: scenarioProject,
        years_mode: settings.yearsMode,
        use_wind_profile: settings.windProfile,
        wind_p_level: settings.windLevel,
      });
      setScenarioResult(rerun);
    } catch (err) {
      setError(err.message);
    } finally {
      setScenarioLoading("");
    }
  }

  function resetScenario() {
    const next = defaultScenarioInputs(settings);
    setScenarioInputs(next);
    setScenarioResult(null);
  }

  async function runValidation() {
    const startTab = activeTabRef.current;
    if (!optimizedResult?.project) return;
    setError("");
    setValidationLoading("Validating optimizer result");
    try {
      const validation = await api("/api/optimizer/validate", {
        project: optimizedResult.project,
        years_mode: settings.yearsMode,
        use_wind_profile: settings.windProfile,
        wind_p_level: settings.windLevel,
        bounds: optimizedResult.optimizer?.bounds || optimizerBoundsFromSettings(settings),
        fixed_bess_duration_hours: optimizedResult.optimizer?.fixed_bess_duration_hours || (settings.forceTwoHourBess ? 2 : null),
      });
      setValidationResult(validation);
      showResult(startTab, "validation", "Optimizer validation");
    } catch (err) {
      setError(err.message);
    } finally {
      setValidationLoading("");
    }
  }

  useEffect(() => {
    if (initialScenario?.scenario?.module !== "fdre") return;
    const { scenario, current } = initialScenario;
    const inputs = current.inputs || {};
    const results = current.results || {};
    if (inputs.settings) setSettings((s) => ({ ...s, ...inputs.settings }));
    if (inputs.scenarioInputs) setScenarioInputs(inputs.scenarioInputs);
    setOptimizedResult(results.optimizedResult || null);
    setCustomResult(results.customResult || null);
    setFinanceResult(results.financeResult || null);
    setDispatchResult(results.dispatchResult || null);
    setFdreLinked({ id: scenario.id, name: scenario.name, version: current.version });
    setActiveTab(results.optimizedResult ? "optimization" : "results");
    setNotice(`Opened “${scenario.name}” version ${current.version}.`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    async function boot() {
      if (!needsEngine) {
        setLoading("");
        return;
      }
      try {
        const data = await api("/api/defaults");
        setDefaults(data);
        setLoading("");
      } catch (err) {
        setError(err.message);
        setLoading("");
      }
    }
    boot();
  }, []);

  useEffect(() => {
    if (activeTab !== "sensitivity" || !optimizedResult?.project) return undefined;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setScenarioLoading("Recalculating scenario finance");
      try {
        const scenarioProject = cloneProjectWith(
          optimizedResult.project,
          financeOnlyUpdates({ ...settings, ...scenarioInputs }),
          { capacity: false, tender: true, finance: true },
        );
        const rerun = await api("/api/evaluate", {
          project: scenarioProject,
          years_mode: settings.yearsMode,
          use_wind_profile: settings.windProfile,
          wind_p_level: settings.windLevel,
        });
        if (!cancelled) setScenarioResult(rerun);
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setScenarioLoading("");
      }
    }, 500);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activeTab, optimizedResult, scenarioInputs, settings, settings.yearsMode, settings.windProfile, settings.windLevel]);

  const resultForTabs = optimizedResult || customResult;
  const tabs = [
    ["rtc", Clock3, "Round the Clock"],
    ["bessTender", BatteryCharging, "BESS Tender", "New"],
    ["tender", FileText, "Tender Upload"],
    ["project", Settings2, "Project Configuration"],
    ["yield", BarChart3, "Yield Assessment"],
    ["joulewiseReport", FileText, "Joulewise EYA Report"],
    ["finance", CircleDollarSign, "Financial Inputs"],
    ["statements", Table2, "Financial Statements"],
    ["sensitivity", SlidersHorizontal, "Sensitivity & Scenarios"],
    ["customDispatch", Activity, "Custom Dispatch"],
    ["optimization", Zap, "Optimization"],
    ["validation", ShieldCheck, "Optimizer Validation"],
    ["optimizedEya", ShieldCheck, "Optimized EYA"],
    ["results", LayoutDashboard, "Results"],
    ["reports", Database, "Reports"],
  ];
  const canView = allowed.has(activeTab);

  return (
    <div className="app-shell">
      <Sidebar
        tabs={tabs}
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        user={user}
        onSave={() => setShowSave(true)}
        canSave={Boolean(optimizedResult || customResult)}
        linked={fdreLinked}
        allowed={allowed}
      />
      <main>
        {notice && canView && activeTab !== "rtc" && activeTab !== "bessTender" && <div className="loading">{notice}</div>}
        {error && canView && activeTab !== "rtc" && activeTab !== "bessTender" && <div className="alert">{error}</div>}
        {loading && canView && activeTab !== "rtc" && activeTab !== "bessTender" && <div className="loading"><Loader2 className="spin" size={18} /> {loading}</div>}

        {!canView && <Restricted label={tabs.find((t) => t[0] === activeTab)?.[2] || "This tab"} contacts={user?.adminContacts} />}
        {canView && activeTab === "bessTender" && <BessTab initialScenario={initialScenario?.scenario?.module === "bess" ? initialScenario : null} />}
        {canView && activeTab === "rtc" && <RtcTab user={user} initialScenario={initialScenario?.scenario?.module === "rtc" ? initialScenario : null} />}
        {canView && activeTab === "tender" && <TenderUploadTab settings={settings} setSettings={setSettings} />}
        {canView && activeTab === "project" && <ProjectConfigurationTab settings={settings} setSettings={setSettings} result={null} defaults={defaults} project={sidebarProject} />}
        {canView && activeTab === "yield" && <YieldAssessmentTab defaults={defaults} settings={settings} pvsystReports={pvsystReports} setPvsystReports={setPvsystReports} optimizedResult={optimizedResult} />}
        {canView && activeTab === "joulewiseReport" && <JoulewiseReportTab report={defaults?.joulewise_report} customResult={customResult} settings={settings} setSettings={setSettings} />}
        {canView && activeTab === "finance" && <FinanceTab optimizedResult={optimizedResult} financeResult={financeResult} settings={settings} setSettings={setSettings} onFinanceRerun={financeRerun} loading={loading} />}
        {canView && activeTab === "statements" && <FinancialStatementsTab optimizedResult={optimizedResult} financeResult={financeResult} />}
        {canView && activeTab === "sensitivity" && <SensitivityScenariosTab optimizedResult={optimizedResult} scenarioInputs={scenarioInputs} setScenarioInputs={setScenarioInputs} scenarioResult={scenarioResult} scenarioLoading={scenarioLoading} onRunScenario={() => runScenario()} onResetScenario={resetScenario} />}
        {canView && activeTab === "customDispatch" && <CustomDispatchTab settings={settings} setSettings={setSettings} result={dispatchResult} onRunDispatch={runCustomDispatch} loading={loading} />}
        {canView && activeTab === "optimization" && <OptimizationTab optimizedResult={optimizedResult} onOptimize={() => optimize()} loading={loading} />}
        {canView && activeTab === "validation" && <OptimizerValidationTab optimizedResult={optimizedResult} validationResult={validationResult} validationLoading={validationLoading} onRunValidation={runValidation} />}
        {canView && activeTab === "optimizedEya" && <OptimizedEyaTab optimizedResult={optimizedResult} defaults={defaults} />}
        {canView && activeTab === "results" && <ResultsTab optimizedResult={optimizedResult} customResult={customResult} settings={settings} setSettings={setSettings} onEvaluate={evaluateCustom} loading={loading} />}
        {canView && activeTab === "reports" && <ReportsTab defaults={defaults} optimizedResult={optimizedResult} customResult={customResult} project={sidebarProject} settings={settings} />}
      </main>
      {showSave && (
        <SaveDialog
          module="fdre"
          linked={fdreLinked}
          defaultName={`FDRE ${num(settings.contractedCapacity, 0)} MW · ${new Date().toISOString().slice(0, 10)}`}
          build={() => {
            const result = optimizedResult || customResult;
            return {
              inputs: { settings, scenarioInputs },
              results: { optimizedResult, customResult, financeResult, dispatchResult },
              summary: fdreSummary(settings, result, optimizedResult ? "optimized" : "custom"),
            };
          }}
          onSaved={(linked) => {
            setFdreLinked(linked);
            setShowSave(false);
            setNotice(`Saved “${linked.name}” version ${linked.version}.`);
          }}
          onClose={() => setShowSave(false)}
        />
      )}
    </div>
  );
}
