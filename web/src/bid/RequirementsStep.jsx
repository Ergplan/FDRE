import React, { useMemo, useState } from "react";
import { ArrowRight, CheckCircle2, ChevronDown, ChevronRight, CircleDashed, FileSearch, Info, TriangleAlert } from "lucide-react";
import { Section, nf } from "../rtc/ui";
import { buildProposals } from "./tenderMap";

const STATUS = {
  validated: { label: "Checked", cls: "ok", icon: CheckCircle2 },
  needs_review: { label: "Review", cls: "warn", icon: TriangleAlert },
  not_found: { label: "Not stated", cls: "muted", icon: CircleDashed },
  rejected: { label: "No quote", cls: "bad", icon: TriangleAlert },
};

export function StatusChip({ status }) {
  const s = STATUS[status] || STATUS.not_found;
  const Icon = s.icon;
  return <span className={`bid-status ${s.cls}`}><Icon size={11} /> {s.label}</span>;
}

/** Page chip with the quote it rests on (title); used next to every input set from the tender. */
export function SourceChip({ source, compact = false }) {
  if (!source) return null;
  const tip = [source.label, source.quote ? `“${source.quote}”` : null, source.located ? null : "Quote not found on the page: check it"].filter(Boolean).join("\n");
  return (
    <span className={`bid-src ${source.located ? "" : "unlocated"} ${source.status === "needs_review" ? "review" : ""}`} title={tip}>
      <FileSearch size={10} /> {source.page ? `p. ${source.page}` : "tender"}{!compact && source.status === "needs_review" ? " · review" : ""}
    </span>
  );
}

function Quote({ evidence }) {
  if (!evidence?.length) return <span className="rtc-note">No quote</span>;
  return (
    <ul className="bid-quotes">
      {evidence.map((e, i) => (
        <li key={i} className={e.located ? "" : "unlocated"}>
          <span className="bid-src"><FileSearch size={10} /> p. {e.page}</span>
          <q>{e.quote}</q>
          {!e.located && <em>not found on the page</em>}
        </li>
      ))}
    </ul>
  );
}

/** Step 2: what the tender asks for, how it sets the model, and every field read. */
export default function RequirementsStep({ state, setState, onApply, goto }) {
  const result = state.tender?.result;
  const proposals = useMemo(() => buildProposals(result), [result]);
  const [filter, setFilter] = useState("found");
  const [openSection, setOpenSection] = useState(null);
  const [openField, setOpenField] = useState(null);
  if (!result) {
    return (
      <Section index="2" title="Requirements">
        <p className="rtc-note">No tender has been read. <button type="button" className="link" onClick={() => goto("tender")}>Read a tender</button> or continue to sizing with the defaults.</p>
        <button type="button" className="primary" onClick={() => goto("size")}>Go to sizing <ArrowRight size={14} /></button>
      </Section>
    );
  }
  const accepted = state.accepted || {};
  const toggle = (id) => setState((s) => ({ ...s, accepted: { ...s.accepted, [id]: s.accepted?.[id] === false } }));
  const groups = [...new Set(proposals.map((p) => p.group))];
  const used = proposals.filter((p) => p.stated && !p.info && accepted[p.id] !== false).length;

  const sections = result.sections || [];
  const visible = (f) => (filter === "all" ? true : filter === "found" ? f.status === "validated" || f.status === "needs_review" : filter === "review" ? f.status === "needs_review" || f.status === "rejected" : f.status === "not_found");

  return (
    <>
      <Section index="2" title="What the tender sets" note={`${used} model inputs from the tender · hover a page chip for its quote`}
        actions={<button type="button" className="primary" onClick={() => onApply(proposals)} data-testid="bid-apply">Apply to model and size <ArrowRight size={14} /></button>}>
        <div className="bid-req-table" role="table">
          <div className="bid-req-row head" role="row">
            <span>Use</span><span>Requirement</span><span>Tender says</span><span>Effect on the model</span><span>Source</span>
          </div>
          {groups.map((g) => (
            <React.Fragment key={g}>
              <div className="bid-req-group">{g}</div>
              {proposals.filter((p) => p.group === g).map((p) => (
                <div key={p.id} className={`bid-req-row ${p.stated ? "" : "missing"} ${p.info ? "info" : ""}`} role="row" data-testid={`req-${p.id}`}>
                  <span>
                    {p.info ? <Info size={14} className="rtc-note" /> : (
                      <input type="checkbox" checked={p.stated && accepted[p.id] !== false} disabled={!p.stated} onChange={() => toggle(p.id)} aria-label={`Use ${p.label}`} />
                    )}
                  </span>
                  <span><strong>{p.label}</strong></span>
                  <span className="bid-req-value">{p.stated ? p.display : <em>Not stated: model default kept</em>}</span>
                  <span className="rtc-note">{p.note}</span>
                  <span>{p.source ? <><SourceChip source={p.source} /> <StatusChip status={p.source.status} /></> : null}</span>
                </div>
              ))}
            </React.Fragment>
          ))}
        </div>
      </Section>

      <Section index="2.1" title="Everything read from the tender" note={`${nf(result.counts?.found)} of ${nf(result.counts?.fields)} fields found · ${result.mode === "llm" ? "full reading" : "rule-based reading"} · type ${result.tender_type}`}
        actions={(
          <div className="bid-filter" role="tablist">
            {[["found", "Found"], ["review", "To review"], ["missing", "Not stated"], ["all", "All"]].map(([id, label]) => (
              <button key={id} type="button" className={filter === id ? "active" : ""} onClick={() => setFilter(id)}>{label}</button>
            ))}
          </div>
        )}>
        {result.rules?.some((r) => !r.passed) && (
          <ul className="bid-warnings">
            {result.rules.filter((r) => !r.passed).map((r, i) => <li key={i}><TriangleAlert size={12} /> {r.message}</li>)}
          </ul>
        )}
        <div className="bid-sections">
          {sections.map((sec) => {
            const fields = sec.fields.filter(visible);
            const found = sec.fields.filter((f) => f.status === "validated" || f.status === "needs_review").length;
            const open = openSection === sec.name || (openSection === null && fields.length > 0 && sec === sections.find((s) => s.fields.some(visible)));
            return (
              <div key={sec.name} className={`bid-sec ${open ? "open" : ""}`}>
                <button type="button" className="bid-sec-head" onClick={() => setOpenSection(open ? "" : sec.name)}>
                  {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  <strong>{sec.label}</strong>
                  <span className="rtc-note">{found} of {sec.fields.length} found</span>
                </button>
                {open && (
                  <div className="bid-fields">
                    {fields.length === 0 && <p className="rtc-note">No fields in this view.</p>}
                    {fields.map((f) => (
                      <div key={f.path} className="bid-field">
                        <button type="button" className="bid-field-row" onClick={() => setOpenField(openField === f.path ? null : f.path)}>
                          <span>{f.label}{f.required ? " *" : ""}</span>
                          <span className="bid-field-value">{f.display || (f.value === null ? "–" : String(f.value))}</span>
                          <span>{f.evidence?.[0]?.page ? <span className="bid-src"><FileSearch size={10} /> p. {f.evidence[0].page}</span> : null}</span>
                          <StatusChip status={f.status} />
                        </button>
                        {openField === f.path && (
                          <div className="bid-field-detail">
                            {f.help && <p className="rtc-note">{f.help}</p>}
                            <Quote evidence={f.evidence} />
                            {f.rationale && <p><em>{f.rationale}</em></p>}
                            {f.issues?.length > 0 && <ul className="bid-warnings">{f.issues.map((x, i) => <li key={i}><TriangleAlert size={12} /> {x.message}</li>)}</ul>}
                            <small className="rtc-note">{f.path} · confidence {nf((f.confidence || 0) * 100)}%</small>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Section>
    </>
  );
}
