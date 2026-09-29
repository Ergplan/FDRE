// Build a built-in solar profile from a PVsyst hourly workbook (.xlsx) or CSV.
//   node tools/build_solar_seed.mjs <file.xlsx|csv> <out.json> <seedKey> [site] [source]
import fs from "node:fs";
import path from "node:path";
import { parseDatedProfile } from "../web/src/rtc/engine.js";
import { xlsxToCsv } from "../web/lib/xlsxToCsv.js";

const [file, out, seedKey, site = "", source = ""] = process.argv.slice(2);
if (!file || !out || !seedKey) { console.error("usage: node tools/build_solar_seed.mjs <file> <out.json> <seedKey> [site] [source]"); process.exit(1); }
const text = file.endsWith(".xlsx") ? (await xlsxToCsv(fs.readFileSync(file))).csv : fs.readFileSync(file, "utf8");
const p = parseDatedProfile(text);
if (!p) throw new Error("No dated rows found");
const r4 = (v) => Math.round(v * 1e4) / 1e4;
const entry = {
  seedKey,
  kind: "solar",
  name: p.name || path.basename(file),
  site,
  region: "Maharashtra",
  source: source || `Hourly yield file ${path.basename(file)}; capacity ${p.capacitySource}`,
  capacityMw: r4(p.capacityMw),
  from: p.from,
  to: p.to,
  coverage: r4(p.coverage),
  cuf: r4(p.cuf),
  monthlyCuf: p.monthlyCuf.map(r4),
  quality: p.quality,
  issues: [...p.issues, ...p.notes],
  values: Array.from(p.values, r4),
};
fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), profiles: [entry] }));
console.log(`${entry.quality} ${entry.name}: CUF ${(entry.cuf * 100).toFixed(2)}% on ${entry.capacityMw} MW · ${entry.issues.join("; ")}`);
