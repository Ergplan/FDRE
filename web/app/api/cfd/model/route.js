import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { currentUserWithAccess, handler, HttpError } from "@/lib/auth";
import { logEvent } from "@/lib/activity";

export const dynamic = "force-dynamic";

// CfD bid: the SECI CfD-I bid model as an Excel workbook. The browser computes the model
// (web/src/cfd/model.js) and sends it here; this route lays it out: cover page, the tender terms
// with their quotes, every input, operations by Contract Year and the financial model.

const FMT = { cr: "#,##0.00", mwh: "#,##0", tariff: "0.00", tariff4: "0.0000", pct: "0.00%", x: "0.00", mw: "#,##0", int: "0" };
const INK = "FF111111";
const ACCENT = "FFD4FF3F";
const str = (v, n = 600) => String(v ?? "").slice(0, n);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function header(row) {
  row.font = { bold: true, color: { argb: "FFFFFFFF" } };
  row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: INK } };
}
function band(row, text) {
  row.getCell(1).value = text;
  row.font = { bold: true, color: { argb: INK } };
  row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: ACCENT } };
}

export const POST = handler(async (req) => {
  const user = await currentUserWithAccess();
  if (!user) throw new HttpError(401, "Sign in required.");
  if (user.role !== "admin" && !user.allowedTabs?.includes("cfd")) throw new HttpError(403, "No access to the CfD bid tab.");
  const body = await req.json();
  const rows = Array.isArray(body?.rows) ? body.rows.slice(0, 60) : [];
  if (!rows.length) throw new HttpError(400, "The financial model has no periods.");

  const wb = new ExcelJS.Workbook();
  wb.creator = "FDRE · CfD bid";
  wb.created = new Date();

  // ---- cover
  const cover = wb.addWorksheet("Cover", { properties: { tabColor: { argb: ACCENT } } });
  const logoPath = path.join(process.cwd(), "public", "brand", "joulewise-logo.png");
  if (fs.existsSync(logoPath)) {
    const logo = wb.addImage({ buffer: fs.readFileSync(logoPath), extension: "png" });
    cover.addRow([]); cover.addRow([]); cover.addRow([]);
    cover.getRow(1).height = 24; cover.getRow(2).height = 24;
    cover.addImage(logo, { tl: { col: 0, row: 0 }, ext: { width: 196, height: 46 } });
  }
  cover.addRow([str(body.title, 200)]).font = { bold: true, size: 16 };
  cover.addRow([str(body.subtitle, 300)]).font = { color: { argb: "FF555555" } };
  cover.addRow([`Prepared ${new Date().toISOString().slice(0, 10)} by ${user.name || user.email} · CfD bid (FDRE)`]).font = { italic: true, color: { argb: "FF777777" } };
  cover.addRow([]);
  band(cover.addRow([]), "Bid and returns");
  for (const [label, value, fmt] of body.cover || []) {
    const row = cover.addRow([str(label, 120), typeof value === "number" ? value : str(value)]);
    if (typeof value === "number") row.getCell(2).numFmt = FMT[fmt] || FMT.cr;
    row.getCell(2).alignment = { horizontal: "right" };
  }
  cover.addRow([]);
  cover.addRow(["Tender terms are from the SECI CfD-I RfS, CfD Agreement and Amendments 02 and 03, each with its page and quote (sheet Tender terms). Market prices: IEX DAM/GDAM/RTM, Sep 2025 – Sep 2026."]).font = { italic: true, color: { argb: "FF555555" } };
  cover.getColumn(1).width = 60;
  cover.getColumn(2).width = 22;

  // ---- tender terms
  const terms = wb.addWorksheet("Tender terms");
  header(terms.addRow(["Group", "Term", "What it says", "Document", "Clause", "Page", "Quote", "Status"]));
  for (const t of body.terms || []) {
    const row = terms.addRow([str(t.group, 60), str(t.term, 80), str(t.says, 300), str(t.doc, 20), str(t.clause, 60), num(t.page), str(t.quote, 900), str(t.status, 20)]);
    row.alignment = { vertical: "top", wrapText: true };
  }
  [18, 26, 44, 9, 20, 6, 70, 10].forEach((w, i) => { terms.getColumn(i + 1).width = w; });
  terms.views = [{ state: "frozen", ySplit: 1 }];

  // ---- inputs
  const inp = wb.addWorksheet("Inputs");
  header(inp.addRow(["Group", "Input", "Value", "Unit", "Source"]));
  for (const i of body.inputs || []) {
    const row = inp.addRow([str(i.group, 30), str(i.input, 90), typeof i.value === "number" ? i.value : str(i.value), str(i.unit, 40), str(i.source, 40)]);
    if (typeof i.value === "number") row.getCell(3).numFmt = i.unit === "%" ? FMT.pct : "#,##0.####";
    if (/benchmark/i.test(i.source || "")) row.getCell(5).font = { color: { argb: "FFB26A00" } };
  }
  [12, 44, 16, 26, 22].forEach((w, i) => { inp.getColumn(i + 1).width = w; });
  inp.views = [{ state: "frozen", ySplit: 1 }];

  // ---- operations by Contract Year
  const ops = wb.addWorksheet("Operations");
  const opsCols = [
    ["Contract Year", "cy", "int"], ["Starts", "start"], ["Days", "days", "int"], ["Required MWh", "requiredMwh", "mwh"], ["Supplied MWh", "deliveredMwh", "mwh"],
    ["Own RE share", "shareOwn", "pct"], ["Green market share", "shareMarket", "pct"], ["Group RE share", "shareGroup", "pct"],
    ["Charged from own RE MWh", "chargeOwnMwh", "mwh"], ["Charged from green market MWh", "chargeMarketMwh", "mwh"], ["Charged from group RE MWh", "chargeGroupMwh", "mwh"],
    ["Charging cost ₹ cr", "chargingCostCr", "cr"], ["Surplus RE sold MWh", "merchantMwh", "mwh"], ["Surplus revenue ₹ cr", "merchantRevCr", "cr"], ["Curtailed MWh", "curtailedMwh", "mwh"],
    ["Days short of charging", "shortDays", "int"], ["Weeks penalised", "penaltyWeeks", "int"], ["Average MCP in your hours ₹/kWh", "avgMcp", "tariff"],
  ];
  header(ops.addRow(opsCols.map(([l]) => l)));
  for (const o of body.operations || []) {
    const row = ops.addRow(opsCols.map(([, k]) => (typeof o[k] === "number" ? o[k] : str(o[k], 40))));
    opsCols.forEach(([, , fmt], i) => { if (fmt) row.getCell(i + 1).numFmt = FMT[fmt]; });
  }
  opsCols.forEach((_, i) => { ops.getColumn(i + 1).width = i === 1 ? 14 : 16; });
  ops.views = [{ state: "frozen", xSplit: 1, ySplit: 1 }];

  // ---- financial model
  const model = wb.addWorksheet("Financial model");
  header(model.addRow(["₹ crore", "Total", ...rows.map((r) => str(r.period, 30))]));
  for (const line of body.lines || []) {
    const values = rows.map((r) => num(r[line.key]));
    if (values.every((v) => v === null)) continue;
    const total = line.fmt === "x" ? null : values.reduce((a, v) => a + (v || 0), 0);
    const row = model.addRow([str(line.label, 80), total, ...values]);
    row.eachCell((cell, col) => { if (col > 1) cell.numFmt = FMT[line.fmt] || FMT.cr; });
    if (/^(Total|EBITDA|Profit after tax|CFADS|Free cash)/.test(line.label)) row.font = { bold: true };
  }
  model.getColumn(1).width = 40;
  for (let c = 2; c <= rows.length + 2; c += 1) model.getColumn(c).width = 12;
  model.views = [{ state: "frozen", xSplit: 2, ySplit: 1 }];

  await logEvent({ user, kind: "export", detail: { what: "cfd-bid-model.xlsx" }, req });
  const buffer = await wb.xlsx.writeBuffer();
  const file = `${str(body.fileName, 80).replace(/[^\w.-]+/g, "_") || "cfd_bid_model"}.xlsx`;
  return new Response(buffer, {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="${file}"`,
    },
  });
});
