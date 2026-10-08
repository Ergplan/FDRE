import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { currentUserWithAccess, handler, HttpError } from "@/lib/auth";
import { requireTenderAccess } from "@/lib/tenders";
import { logEvent } from "@/lib/activity";

export const dynamic = "force-dynamic";

// Tender to Bid: the bid's financial model as an Excel workbook. The browser computes the model
// (web/src/rtc/engine.js) and sends it here with the inputs, the tender conditions and the plant;
// this route only lays it out: cover page, tender conditions, inputs, plant and capex, revenue
// and costs by stream, and the full year-by-year financial model.

const FMT = { cr: "#,##0.00", mu: "#,##0", tariff: "0.000", pct: "0.00%", x: "0.00", mw: "#,##0", int: "0", text: "@" };
const INK = "FF111111";
const ACCENT = "FFD4FF3F";

const str = (v, n = 400) => String(v ?? "").slice(0, n);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function header(row) {
  row.font = { bold: true, color: { argb: "FFFFFFFF" } };
  row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: INK } };
  row.alignment = { vertical: "middle" };
}

function band(row, text) {
  row.getCell(1).value = text;
  row.font = { bold: true, color: { argb: INK } };
  row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: ACCENT } };
}

function addLogo(wb, ws) {
  const logoPath = path.join(process.cwd(), "public", "brand", "joulewise-logo.png");
  if (!fs.existsSync(logoPath)) return 0;
  const logo = wb.addImage({ buffer: fs.readFileSync(logoPath), extension: "png" });
  ws.addRow([]); ws.addRow([]); ws.addRow([]);
  ws.getRow(1).height = 24; ws.getRow(2).height = 24;
  ws.addImage(logo, { tl: { col: 0, row: 0 }, ext: { width: 196, height: 46 } });
  return 3;
}

/** label / value rows; value may be a number with a format key, or text. */
function pairs(ws, items) {
  for (const item of items || []) {
    const [label, value, fmt, note] = item;
    const row = ws.addRow([str(label, 120), typeof value === "number" ? value : str(value), str(note, 300)]);
    if (typeof value === "number") row.getCell(2).numFmt = FMT[fmt] || FMT.cr;
    row.getCell(2).alignment = { horizontal: "right" };
  }
}

export const POST = handler(async (req) => {
  const user = await currentUserWithAccess();
  requireTenderAccess(user);
  const body = await req.json();
  const rows = Array.isArray(body?.rows) ? body.rows.slice(0, 60) : [];
  if (!rows.length) throw new HttpError(400, "The financial model has no years.");
  const years = rows.map((r) => r.year);

  const wb = new ExcelJS.Workbook();
  wb.creator = "FDRE · Tender to Bid";
  wb.created = new Date();

  // ---- cover page: what is bid, the key results and the key inputs
  const cover = wb.addWorksheet("Cover", { properties: { tabColor: { argb: ACCENT } } });
  addLogo(wb, cover);
  cover.addRow([str(body.title, 200) || "Bid financial model"]).font = { bold: true, size: 16 };
  cover.addRow([str(body.subtitle, 300)]).font = { color: { argb: "FF555555" } };
  cover.addRow([`Prepared ${new Date().toISOString().slice(0, 10)} by ${user.name || user.email} · Tender to Bid (FDRE)`]).font = { italic: true, color: { argb: "FF777777" } };
  cover.addRow([]);
  band(cover.addRow([]), "Key results");
  pairs(cover, body.cover?.outputs);
  cover.addRow([]);
  band(cover.addRow([]), "Plant");
  pairs(cover, body.cover?.plant);
  cover.addRow([]);
  band(cover.addRow([]), "Key inputs");
  pairs(cover, body.cover?.inputs);
  cover.addRow([]);
  band(cover.addRow([]), "Tender");
  pairs(cover, body.cover?.tender);
  cover.addRow([]);
  for (const note of body.cover?.notes || []) cover.addRow([str(note, 400)]).font = { italic: true, color: { argb: "FF555555" } };
  cover.getColumn(1).width = 42;
  cover.getColumn(2).width = 22;
  cover.getColumn(3).width = 70;

  // ---- tender conditions against the plant and the bid
  const cond = wb.addWorksheet("Tender conditions");
  header(cond.addRow(["Condition", "Tender says", "Page", "Quote", "Plant and bid", "Status"]));
  for (const c of body.conditions || []) {
    const row = cond.addRow([str(c.condition, 120), str(c.tender), num(c.page), str(c.quote, 600), str(c.result), str(c.status, 20)]);
    const color = c.status === "Met" ? "FF1E7B34" : c.status === "Not met" ? "FFB3261E" : "FF666666";
    row.getCell(6).font = { bold: true, color: { argb: color } };
    row.alignment = { vertical: "top", wrapText: true };
  }
  [30, 40, 7, 60, 44, 12].forEach((w, i) => { cond.getColumn(i + 1).width = w; });
  cond.views = [{ state: "frozen", ySplit: 1 }];

  // ---- every input, with where it came from
  const inp = wb.addWorksheet("Inputs");
  header(inp.addRow(["Group", "Input", "Value", "Unit", "Source"]));
  for (const i of body.inputs || []) {
    const row = inp.addRow([str(i.group, 60), str(i.input, 120), typeof i.value === "number" ? i.value : str(i.value), str(i.unit, 40), str(i.source, 120)]);
    if (typeof i.value === "number") row.getCell(3).numFmt = i.unit === "%" ? FMT.pct : "#,##0.####";
    if (/benchmark/i.test(i.source || "")) row.getCell(5).font = { color: { argb: "FFB26A00" } };
  }
  [18, 40, 16, 16, 46].forEach((w, i) => { inp.getColumn(i + 1).width = w; });
  inp.views = [{ state: "frozen", ySplit: 1 }];

  // ---- plant and capex
  const plant = wb.addWorksheet("Plant and capex");
  header(plant.addRow(["Item", "Value", "Note"]));
  pairs(plant, body.plant);
  plant.addRow([]);
  header(plant.addRow(["Capex", "₹ crore", "Note"]));
  pairs(plant, body.capex);
  plant.getColumn(1).width = 40; plant.getColumn(2).width = 18; plant.getColumn(3).width = 50;

  // ---- year-by-year sheets: revenue and costs by stream, and the full model
  const yearSheet = (name, sections, withTotal) => {
    const ws = wb.addWorksheet(name);
    header(ws.addRow(["₹ crore unless stated", "Unit", ...(withTotal ? ["Total"] : []), ...years.map((y) => `Year ${y}`)]));
    for (const section of sections || []) {
      band(ws.addRow([]), str(section.title, 80));
      for (const [label, key, fmt, unit, total] of section.lines || []) {
        const values = rows.map((r) => num(r[key]));
        if (values.every((v) => v === null)) continue;
        const sum = values.reduce((a, v) => a + (v || 0), 0);
        const row = ws.addRow([str(label, 120), str(unit || (fmt === "cr" ? "₹ cr" : ""), 20), ...(withTotal ? [total === false ? null : sum] : []), ...values]);
        row.eachCell((cell, col) => { if (col > 2) cell.numFmt = FMT[fmt] || FMT.cr; });
        if (/^(Total|EBITDA|Profit after tax|CFADS|Free cash to equity)/.test(label)) row.font = { bold: true };
      }
    }
    ws.getColumn(1).width = 38;
    ws.getColumn(2).width = 9;
    for (let c = 3; c <= years.length + (withTotal ? 3 : 2); c += 1) ws.getColumn(c).width = 12;
    ws.views = [{ state: "frozen", xSplit: withTotal ? 3 : 2, ySplit: 1 }];
    return ws;
  };
  yearSheet("Revenue and costs", body.streams, true);
  const model = yearSheet("Financial model", body.statements, true);

  // equity and project cash flows with year 0 (the capex), as used for the IRRs
  model.addRow([]);
  band(model.addRow([]), "Returns (year 0 is the investment)");
  header(model.addRow(["Cash flow", "Unit", "Year 0", ...years.map((y) => `Year ${y}`)]));
  for (const [label, flows] of [["Equity cash flow", body.flows?.equity], ["Project cash flow", body.flows?.project]]) {
    if (!Array.isArray(flows)) continue;
    const row = model.addRow([label, "₹ cr", ...flows.slice(0, years.length + 1).map(num)]);
    row.eachCell((cell, col) => { if (col > 2) cell.numFmt = FMT.cr; });
  }
  pairs(model, (body.cover?.outputs || []).filter(([label]) => /IRR|DSCR|NPV|payback/i.test(label)));

  await logEvent({ user, kind: "export", detail: { what: "bid-financial-model.xlsx", tender: str(body.tenderNumber, 80) }, req });
  const buffer = await wb.xlsx.writeBuffer();
  const file = `${str(body.fileName, 80).replace(/[^\w.-]+/g, "_") || "bid_financial_model"}.xlsx`;
  return new Response(buffer, {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="${file}"`,
    },
  });
});
