// Build the built-in resource-profile library from SCADA blockwise exports.
//   node tools/build_profile_library.mjs <folder with *_blockwise_*.csv and _index.csv> <out.json> [region]
// Each plant is converted with the same parser users get in the app (parseDatedProfile):
// 8760 hourly capacity factors, gap-filled, with a quality grade. A cluster average of the
// validated plants is added. Rejected plants are listed without values.
import fs from "node:fs";
import path from "node:path";
import { HOURS, mean, monthlyMeans, parseDatedProfile } from "../web/src/rtc/engine.js";

const [dir, out, region = "Maharashtra (WRPC)"] = process.argv.slice(2);
if (!dir || !out) { console.error("usage: node tools/build_profile_library.mjs <dir> <out.json> [region]"); process.exit(1); }

const SITES = [[/patoda/i, "Patoda, Beed"], [/ghatnandur|ghtnd/i, "Ghatnandur, Beed"], [/wasi/i, "Wasi, Dharashiv"], [/tdlwd|tadwal/i, "Tadwale, Dharashiv"], [/slpr/i, "Solapur"]];
const siteOf = (n) => (SITES.find(([re]) => re.test(n)) || [null, ""])[1];
const r4 = (v) => Math.round(v * 1e4) / 1e4;

const index = fs.existsSync(path.join(dir, "_index.csv"))
  ? Object.fromEntries(fs.readFileSync(path.join(dir, "_index.csv"), "utf8").split(/\r?\n/).slice(1).filter(Boolean).map((l) => { const c = l.split(","); return [c.at(-1), { id: c[0], capacity: Number(c[4]) }]; }))
  : {};

const entries = [];
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".csv") && !x.startsWith("_") && !/all_.*entities/i.test(x)).sort()) {
  const meta = index[f] || {};
  const p = parseDatedProfile(fs.readFileSync(path.join(dir, f), "utf8"), { referenceMw: meta.capacity || null });
  const site = siteOf(p.name || f);
  entries.push({
    seedKey: `wind:wrpc:${meta.id || f}`,
    kind: "wind",
    name: p.name || f,
    site,
    region,
    source: `WRPC SCADA blockwise (15-min), entity ${meta.id || "?"}; site inferred from the entity name`,
    capacityMw: r4(p.capacityMw),
    from: p.from,
    to: p.to,
    coverage: r4(p.coverage),
    cuf: r4(p.cuf),
    monthlyCuf: p.monthlyCuf.map(r4),
    quality: p.quality,
    issues: p.issues,
    values: p.quality === "rejected" ? null : Array.from(p.values, r4),
  });
  console.log(`${p.quality.padEnd(9)} ${(p.name || f).padEnd(26)} CUF ${(p.cuf * 100).toFixed(1)}%  ${p.issues.join("; ")}`);
}

const good = entries.filter((e) => e.quality === "validated");
if (good.length >= 2) {
  const avg = new Float64Array(HOURS);
  for (const e of good) for (let t = 0; t < HOURS; t += 1) avg[t] += e.values[t] / good.length;
  const sites = [...new Set(good.map((e) => e.site.split(",").at(-1).trim()).filter(Boolean))].join(" / ");
  entries.unshift({
    seedKey: "wind:wrpc:cluster-validated",
    kind: "wind",
    name: `${sites || "Maharashtra"} wind cluster (validated average)`,
    site: good.map((e) => e.site).filter(Boolean).join(" + "),
    region,
    source: `Hour-by-hour average of ${good.length} validated plants: ${good.map((e) => e.name).join(", ")}`,
    capacityMw: r4(good.reduce((s, e) => s + e.capacityMw, 0)),
    from: good.map((e) => e.from).sort()[0],
    to: good.map((e) => e.to).sort().at(-1),
    coverage: r4(Math.min(...good.map((e) => e.coverage))),
    cuf: r4(mean(avg)),
    monthlyCuf: monthlyMeans(avg).map(r4),
    quality: "validated",
    issues: [],
    values: Array.from(avg, r4),
  });
}
fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), profiles: entries }));
console.log(`wrote ${entries.length} profiles → ${out} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
