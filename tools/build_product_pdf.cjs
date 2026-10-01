// Render the public product page (/product) to web/public/product/Joulewise-product.pdf.
// Start the web app first, then: node tools/build_product_pdf.cjs [base-url]
// Uses Playwright (npm i -g playwright, or run from a project that has it).
const path = require("node:path");
const { chromium } = require("playwright");

(async () => {
  const base = process.argv[2] || "http://127.0.0.1:3000";
  const out = path.join(__dirname, "..", "web", "public", "product", "Joulewise-product.pdf");
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await page.goto(`${base}/product`, { waitUntil: "networkidle" });
  const broken = await page.evaluate(() => [...document.images].filter((i) => !i.naturalWidth).map((i) => i.src));
  if (broken.length) throw new Error(`images did not load: ${broken.join(", ")}`);
  await page.emulateMedia({ media: "print" });
  // 1200 px wide with A4 proportions: keeps the desktop layout and prints cleanly on A4
  await page.pdf({ path: out, width: "1200px", height: "1697px", printBackground: true, margin: { top: "0", right: "0", bottom: "0", left: "0" } });
  await browser.close();
  console.log(`wrote ${out}`);
})().catch((err) => { console.error(err.message); process.exit(1); });
