import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { handler, HttpError, requireUser } from "@/lib/auth";
import { getScenario } from "@/lib/scenarios";
import { fieldsFor, MODULE_LABEL } from "@/lib/summaryFields";

import { logEvent } from "@/lib/activity";

export const dynamic = "force-dynamic";

const RTC_LINES = [
  ["Demand (MU)", "demandMu"], ["Delivered (MU)", "deliveredMu"], ["DFR", "dfr", "pct"], ["Surplus sold (MU)", "excessMu"], ["Curtailed (MU)", "curtailMu"],
  ["Shortfall vs target (MU)", "shortfallMu"], ["Tariff (Rs/kWh)", "tariff"], ["Energy revenue", "energyRevenue"],
  ["Surplus revenue", "surplusRevenue"], ["Shortfall penalty", "penalty"], ["Total revenue", "revenue"], ["O&M", "om"],
  ["Insurance", "insurance"], ["Other fixed", "other"], ["EBITDA", "ebitda"], ["Book depreciation", "bookDep"],
  ["Interest", "interest"], ["Profit before tax", "pbt"], ["Tax depreciation", "taxDep"], ["Tax", "tax"],
  ["Profit after tax", "pat"], ["Working capital change", "dWc"], ["BESS augmentation", "augCapex"], ["CFADS", "cfads"],
  ["Opening debt", "openingDebt"], ["Principal", "principal"], ["Closing debt", "closingDebt"], ["Debt service", "debtService"],
  ["DSCR", "dscr"], ["Free cash to equity", "fcfe"], ["Cumulative equity cash", "cumEquity"], ["Project cash flow", "projectCf"],
];

function sheetName(wb, base) {
  let name = base.replace(/[\\/?*[\]:]/g, " ").slice(0, 28) || "Scenario";
  let n = 2;
  while (wb.getWorksheet(name)) name = `${name.slice(0, 25)} ${n++}`;
  return name;
}

function styleHeader(row) {
  row.font = { bold: true, color: { argb: "FFFFFFFF" } };
  row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF111111" } };
}

export const GET = handler(async (req) => {
  const user = await requireUser();
  const sp = new URL(req.url).searchParams;
  const ids = (sp.get("ids") || "").split(",").filter(Boolean).slice(0, 20);
  if (!ids.length) throw new HttpError(400, "ids are required.");
  const items = [];
  for (const id of ids) items.push(await getScenario(id, ids.length === 1 ? sp.get("version") : null));
  await logEvent({ user, kind: "export", detail: { what: "scenarios.xlsx", scenarios: items.map((i) => i.scenario.name) }, req });

  const wb = new ExcelJS.Workbook();
  wb.creator = "FDRE";
  wb.created = new Date();

  const fields = fieldsFor(items.map((i) => i.current.summary));
  const cmp = wb.addWorksheet("Comparison");
  // Joulewise logo above the table (light version for white spreadsheet backgrounds)
  const logoPath = path.join(process.cwd(), "public", "brand", "joulewise-logo.png");
  let headerRow = 1;
  if (fs.existsSync(logoPath)) {
    headerRow = 4;
    const logo = wb.addImage({ buffer: fs.readFileSync(logoPath), extension: "png" });
    cmp.addRow([]); cmp.addRow([]); cmp.addRow([]);
    cmp.getRow(1).height = 24; cmp.getRow(2).height = 24;
    cmp.addImage(logo, { tl: { col: 0, row: 0 }, ext: { width: 196, height: 46 } });
  }
  styleHeader(cmp.addRow(["Metric", "Unit", ...items.map((i) => `${i.scenario.name} (v${i.current.version})`)]));
  cmp.addRow(["Module", "", ...items.map((i) => MODULE_LABEL[i.scenario.module] || i.scenario.module)]);
  cmp.addRow(["Saved", "", ...items.map((i) => new Date(i.current.created_at).toISOString().slice(0, 16).replace("T", " "))]);
  for (const f of fields) {
    const row = cmp.addRow([f.label, f.unit, ...items.map((i) => {
      const v = i.current.summary?.[f.key];
      return Number.isFinite(Number(v)) ? Number(v) : null;
    })]);
    row.eachCell((cell, col) => { if (col > 2) cell.numFmt = f.pct ? "0.00%" : f.digits ? `#,##0.${"0".repeat(f.digits)}` : "#,##0"; });
  }
  cmp.getColumn(1).width = 26;
  cmp.getColumn(2).width = 10;
  items.forEach((_, k) => { cmp.getColumn(k + 3).width = 22; });
  cmp.views = [{ state: "frozen", xSplit: 2, ySplit: headerRow }];

  for (const { scenario, current } of items) {
    const ws = wb.addWorksheet(sheetName(wb, scenario.name));
    ws.addRow([scenario.name]).font = { bold: true, size: 14 };
    ws.addRow([`${MODULE_LABEL[scenario.module] || scenario.module} · version ${current.version} · ${current.note || ""}`]);
    ws.addRow([]);
    if (scenario.module === "rtc") {
      const rows = current.results?.finance?.rows || [];
      styleHeader(ws.addRow(["Line item", ...rows.map((r) => `Y${r.year}`)]));
      for (const [label, key, fmt] of RTC_LINES) {
        const row = ws.addRow([label, ...rows.map((r) => (r[key] === null || r[key] === undefined ? null : Number(r[key])))]);
        row.eachCell((cell, col) => { if (col > 1) cell.numFmt = fmt === "pct" ? "0.0%" : "#,##0.00"; });
      }
    } else {
      const table = current.results?.optimizedResult?.finance?.table || current.results?.customResult?.finance?.table || [];
      if (table.length) {
        const cols = Object.keys(table[0]);
        styleHeader(ws.addRow(cols));
        table.forEach((r) => ws.addRow(cols.map((c) => r[c])));
      } else ws.addRow(["No financial table saved with this scenario."]);
    }
    ws.getColumn(1).width = 28;
    ws.views = [{ state: "frozen", xSplit: 1, ySplit: 4 }];
  }

  const buf = await wb.xlsx.writeBuffer();
  const name = items.length === 1 ? items[0].scenario.name : "scenario_comparison";
  return new Response(buf, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${name.replace(/[^\w.-]+/g, "_")}.xlsx"`,
    },
  });
});
