import React from "react";
import { FileSearch } from "lucide-react";
import { docById, termById } from "./terms.js";

/** A chip naming the document, clause and page of a term, with its quote on hover. */
export default function Cite({ id, compact = false }) {
  const t = termById[id];
  if (!t) return null;
  const doc = docById[t.doc];
  return (
    <span className={`bid-src cfd-cite ${t.status === "replaced" ? "replaced" : ""}`} title={`${doc.title}, ${t.clause}, page ${t.page}:\n“${t.quote}”`}>
      <FileSearch size={10} /> {doc.short} {compact ? "" : `${t.clause.replace(/ \((amended|original.*)\)$/, "")} · `}p. {t.page}
    </span>
  );
}
