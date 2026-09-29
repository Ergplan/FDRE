// Convert the busiest worksheet of an .xlsx workbook to CSV text (server / Node only).
import ExcelJS from "exceljs";

const pad = (n) => String(n).padStart(2, "0");

function cellText(v) {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) {
    // time-only cells come back on Excel's 1899-12-30 epoch
    if (v.getUTCFullYear() <= 1900) return `${pad(v.getUTCHours())}:${pad(v.getUTCMinutes())}`;
    const date = `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`;
    return v.getUTCHours() || v.getUTCMinutes() ? `${date} ${pad(v.getUTCHours())}:${pad(v.getUTCMinutes())}` : date;
  }
  if (typeof v === "object") {
    if ("result" in v) return cellText(v.result); // formula
    if ("richText" in v) return v.richText.map((r) => r.text).join("");
    if ("text" in v) return String(v.text);
    return "";
  }
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function xlsxToCsv(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  let sheet = null;
  wb.eachSheet((ws) => { if (!sheet || ws.actualRowCount > sheet.actualRowCount) sheet = ws; });
  if (!sheet) throw new Error("The workbook has no worksheets.");
  const lines = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const vals = [];
    for (let c = 1; c <= row.cellCount; c += 1) vals.push(cellText(row.getCell(c).value));
    while (vals.length && vals[vals.length - 1] === "") vals.pop();
    lines.push(vals.join(","));
  });
  return { csv: lines.join("\n"), sheet: sheet.name, rows: lines.length };
}
