import React, { useState } from "react";
import { ChevronDown, ChevronRight, FileText } from "lucide-react";
import { Section } from "../rtc/ui";
import Cite from "./Cite.jsx";
import { DOCUMENTS, RFS, TERMS, TERM_GROUPS } from "./terms.js";

/** Step 2: every term the model uses, grouped, each with its document, clause, page and quote. */
export default function TermsStep() {
  const [open, setOpen] = useState({});
  const conflicts = TERMS.filter((t) => t.status === "conflict");
  return (
    <>
      <Section index="2" title="Tender terms" note={`${TERMS.length} terms from ${DOCUMENTS.length} documents, each quoted with its page`}>
        <div className="cfd-docs" data-testid="cfd-docs">
          {DOCUMENTS.map((d) => (
            <div key={d.id} className="cfd-doc"><FileText size={14} /><span><strong>{d.title}</strong><small>{d.pages} pages · {d.file}{d.id === "rfs" ? ` · ISN-ETS ${RFS.searchCode} · replaces ${RFS.replaces} · page numbers as printed (the PDF has a cover first)` : ""}</small></span></div>
          ))}
        </div>
        <p className="rtc-note">Where an amendment changed a term, the amended term applies; the original is listed and marked replaced. If documents differ, the CfDA prevails, then the RfS <Cite id="precedence" />; {conflicts.length} terms where they still differ are marked “documents differ” and are worth raising with SECI: {conflicts.map((t) => t.label).join("; ")}.</p>
      </Section>
      {TERM_GROUPS.map((g, gi) => (
        <Section key={g} index={`2.${gi + 1}`} title={g}>
          <div className="cfd-terms" data-testid={`cfd-terms-${gi + 1}`}>
            {TERMS.filter((t) => t.group === g).map((t) => (
              <div key={t.id} className={`cfd-term ${t.status || ""}`} data-testid={`cfd-term-${t.id}`}>
                <button type="button" className="cfd-term-head" onClick={() => setOpen((o) => ({ ...o, [t.id]: !o[t.id] }))} aria-expanded={Boolean(open[t.id])}>
                  {open[t.id] ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  <span className="cfd-term-label">{t.label}</span>
                  <span className="cfd-term-value">{t.display}{t.status === "replaced" && <em> · replaced</em>}{t.status === "conflict" && <em> · documents differ</em>}</span>
                  <Cite id={t.id} />
                </button>
                {open[t.id] && <blockquote className="cfd-quote">“{t.quote}”</blockquote>}
              </div>
            ))}
          </div>
        </Section>
      ))}
    </>
  );
}
