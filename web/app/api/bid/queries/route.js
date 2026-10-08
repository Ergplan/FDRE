import JSZip from "jszip";
import { currentUserWithAccess, handler, HttpError } from "@/lib/auth";
import { requireTenderAccess } from "@/lib/tenders";
import { logEvent } from "@/lib/activity";

export const dynamic = "force-dynamic";

// Tender to Bid: the pre-bid queries as a Word file (.docx), the format the RFP asks for
// (RFP clause 1.1.10: "attaching the queries in Microsoft word file"). The browser sends the
// queries as the bidder edited them; this route only lays them out: the prescribed title, the
// tender, the bidder, and one table row per query (S. No., clause and page, RFP provision,
// clarification sought, rationale), A4 landscape.

const str = (v, n = 4000) => String(v ?? "").slice(0, n);
const esc = (s) => str(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG = "http://schemas.openxmlformats.org/package/2006/relationships";

function run(text, { bold = false, italic = false, size = null, color = null } = {}) {
  const props = [bold ? "<w:b/>" : "", italic ? "<w:i/>" : "", color ? `<w:color w:val="${color}"/>` : "", size ? `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>` : ""].join("");
  return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ""}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
}

function para(text, opts = {}) {
  const spacing = `<w:spacing w:before="0" w:after="${opts.after ?? 80}"/>`;
  return `<w:p><w:pPr>${spacing}${opts.center ? '<w:jc w:val="center"/>' : ""}</w:pPr>${run(text, opts)}</w:p>`;
}

/** A cell: each line of the text is its own paragraph. */
function cell(text, width, { bold = false, boldFirst = false, fill = null } = {}) {
  const lines = str(text).split("\n");
  const ps = lines.map((line, i) => `<w:p><w:pPr><w:spacing w:before="0" w:after="60"/></w:pPr>${run(line, { bold: bold || (boldFirst && i === 0), size: 18 })}</w:p>`).join("");
  return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${fill}"/>` : ""}</w:tcPr>${ps}</w:tc>`;
}

const COLS = [
  ["S. No.", 700],
  ["Clause / page", 1500],
  ["RFP provision", 4300],
  ["Clarification sought", 5338],
  ["Rationale", 3000],
];

function table(rows) {
  const border = (side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="808080"/>`;
  const head = `<w:tr><w:trPr><w:tblHeader/></w:trPr>${COLS.map(([label, w]) => cell(label, w, { bold: true, fill: "D9D9D9" })).join("")}</w:tr>`;
  const body = rows.map((r) => {
    const values = [String(r.no), r.clause, r.provision, `${r.topic}\n${r.query}`, r.rationale];
    return `<w:tr><w:trPr><w:cantSplit/></w:trPr>${values.map((v, i) => cell(v, COLS[i][1], { boldFirst: i === 3 })).join("")}</w:tr>`;
  }).join("");
  // tblPr children in the schema's order (Word rejects them out of order)
  return `<w:tbl><w:tblPr><w:tblW w:w="${COLS.reduce((a, [, w]) => a + w, 0)}" w:type="dxa"/>`
    + `<w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map(border).join("")}</w:tblBorders>`
    + `<w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="60" w:type="dxa"/><w:left w:w="80" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr>`
    + `<w:tblGrid>${COLS.map(([, w]) => `<w:gridCol w:w="${w}"/>`).join("")}</w:tblGrid>${head}${body}</w:tbl>`;
}

function documentXml({ title, tenderNumber, bidder, date, rows }) {
  const body = [
    para(title, { bold: true, size: 26, center: true, after: 120 }),
    para(`Tender: ${tenderNumber}`, { center: true, after: 40 }),
    para(`Bidder: ${bidder || "______________________________"}`, { center: true, after: 40 }),
    para(`Date: ${date}`, { center: true, after: 200 }),
    para("RFQ = Section A and RFP = Section B of the Bidding Document; page numbers are those printed on the Bidding Document.", { italic: true, size: 18, color: "555555", after: 120 }),
    table(rows),
    para("", { after: 0 }),
  ].join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${body}`
    + `<w:sectPr><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/><w:pgMar w:top="1000" w:right="1000" w:bottom="1000" w:left="1000" w:header="500" w:footer="500" w:gutter="0"/></w:sectPr>`
    + `</w:body></w:document>`;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
  + `<w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="20"/><w:szCs w:val="20"/><w:lang w:val="en-IN"/></w:rPr></w:rPrDefault>`
  + `<w:pPrDefault><w:pPr><w:spacing w:after="80" w:line="252" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>`
  + `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style></w:styles>`;

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
  + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
  + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>`
  + `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>`
  + `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>`
  + `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
  + `<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>`
  + `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`;

const DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
  + `<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;

function coreXml(title, author) {
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`
    + `<dc:title>${esc(title)}</dc:title><dc:creator>${esc(author)}</dc:creator>`
    + `<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`;
}

export const POST = handler(async (req) => {
  const user = await currentUserWithAccess();
  requireTenderAccess(user);
  const body = await req.json();
  const rows = (Array.isArray(body?.rows) ? body.rows.slice(0, 50) : []).map((r, i) => ({
    no: i + 1, topic: str(r.topic, 300), clause: str(r.clause, 200), provision: str(r.provision), query: str(r.query), rationale: str(r.rationale, 2000),
  }));
  if (!rows.length) throw new HttpError(400, "There are no queries in the letter.");
  const title = str(body.title, 300) || "Queries/Request for Additional Information";
  const date = new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" }).replace(/\//g, ".");

  const zip = new JSZip();
  zip.file("[Content_Types].xml", CONTENT_TYPES);
  zip.file("_rels/.rels", ROOT_RELS);
  zip.file("docProps/core.xml", coreXml(title, str(body.bidder, 200) || user.name || user.email));
  zip.file("word/document.xml", documentXml({ title, tenderNumber: str(body.tenderNumber, 120), bidder: str(body.bidder, 200), date, rows }));
  zip.file("word/styles.xml", STYLES);
  zip.file("word/_rels/document.xml.rels", DOC_RELS);
  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });

  await logEvent({ user, kind: "export", detail: { what: "pre-bid-queries.docx", tender: str(body.tenderNumber, 80), queries: rows.length }, req });
  return new Response(buffer, {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "content-disposition": 'attachment; filename="pre-bid_queries.docx"',
    },
  });
});
