// Fields shown when listing, comparing and exporting saved scenarios. Shared by client and server.
export const SUMMARY_FIELDS = [
  { key: "solarMw", label: "Solar", unit: "MW", digits: 0 },
  { key: "windMw", label: "Wind", unit: "MW", digits: 0 },
  { key: "bessMw", label: "BESS power", unit: "MW", digits: 0 },
  { key: "bessMwh", label: "BESS energy", unit: "MWh", digits: 0 },
  { key: "capexCr", label: "Project cost", unit: "₹ cr", digits: 0 },
  { key: "tariff", label: "Tariff", unit: "₹/kWh", digits: 3 },
  { key: "lcoe", label: "LCOE", unit: "₹/kWh", digits: 3 },
  { key: "equityIrr", label: "Equity IRR", unit: "%", pct: true, digits: 2 },
  { key: "projectIrr", label: "Project IRR", unit: "%", pct: true, digits: 2 },
  { key: "minDscr", label: "Min DSCR", unit: "x", digits: 2 },
  { key: "payback", label: "Equity payback", unit: "year", digits: 0 },
  { key: "annualEnergyMu", label: "Energy requirement", unit: "MU", digits: 0 },
  { key: "plantCapacityMw", label: "Plant capacity", unit: "MW", digits: 0 },
  { key: "contractedMw", label: "Contracted capacity", unit: "MW", digits: 0 },
  { key: "dfrTarget", label: "DFR target", unit: "%", pct: true, digits: 1 },
  { key: "dfr", label: "DFR year 1", unit: "%", pct: true, digits: 2 },
  { key: "minLifetimeDfr", label: "Lowest lifetime DFR", unit: "%", pct: true, digits: 2 },
  { key: "deliveredMu", label: "Delivered year 1", unit: "MU", digits: 1 },
  { key: "curtailMu", label: "Curtailed year 1", unit: "MU", digits: 1 },
  { key: "minPeakAvailability", label: "Min peak availability", unit: "%", pct: true, digits: 1 },
  { key: "penaltyGwh", label: "Penalty energy", unit: "GWh", digits: 2 },
];

export const MODULE_LABEL = { rtc: "Round the Clock", fdre: "FDRE" };

export function formatField(field, value) {
  if (value === null || value === undefined || value === "" || !Number.isFinite(Number(value))) return "–";
  const v = field.pct ? Number(value) * 100 : Number(value);
  const s = new Intl.NumberFormat("en-IN", { minimumFractionDigits: field.digits, maximumFractionDigits: field.digits }).format(v);
  return field.pct ? `${s}%` : s;
}

/** Only fields that at least one of the given summaries has. */
export function fieldsFor(summaries) {
  return SUMMARY_FIELDS.filter((f) => summaries.some((s) => s && s[f.key] !== undefined && s[f.key] !== null));
}
