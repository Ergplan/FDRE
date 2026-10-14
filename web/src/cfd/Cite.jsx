import React from "react";
import { FileSearch } from "lucide-react";
import { docById, termById } from "./terms.js";

const clauseOf = (t) => t.clause.replace(/ \((amended|original.*)\)$/, "");

/** A chip naming the document, clause and page of a term, with its quote (and any others from the same clause) on hover. */
export default function Cite({ id, compact = false, also = [] }) {
  const t = termById[id];
  if (!t) return null;
  const doc = docById[t.doc];
  const quotes = [t, ...also.map((a) => termById[a]).filter(Boolean)].map((x) => `“${x.quote}”`).join("\n…\n");
  return (
    <span className={`bid-src cfd-cite ${t.status || ""}`} title={`${doc.title}, ${t.clause}, page ${t.page}${doc.pdfOffset ? ` (PDF page ${t.page + doc.pdfOffset})` : ""}:\n${quotes}`}>
      <FileSearch size={10} /> {doc.short} {compact ? "" : `${clauseOf(t)} · `}p. {t.page}
    </span>
  );
}

/** Several cites, one chip per document, clause and page; terms from the same clause share a chip (list a replaced or conflicting term first to mark it). */
export function Cites({ ids, compact = false }) {
  const groups = new Map();
  for (const id of ids) {
    const t = termById[id];
    if (!t) continue;
    const key = `${t.doc}|${clauseOf(t)}|${t.page}`; // the chip takes the first term's status
    if (groups.has(key)) groups.get(key).push(id); else groups.set(key, [id]);
  }
  return [...groups.values()].map(([first, ...rest], i) => <React.Fragment key={first}>{i > 0 && " "}<Cite id={first} also={rest} compact={compact} /></React.Fragment>);
}
