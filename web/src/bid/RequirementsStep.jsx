import React, { useMemo, useState } from "react";
import { CheckCircle2, ChevronDown, ChevronRight, CircleDashed, FileSearch, TriangleAlert } from "lucide-react";
import { Section, nf } from "../rtc/ui";
import { buildProposals, isUsed } from "./tenderMap";

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

/** Page chip with the quote it rests on (title); used next to every value taken from the tender. */
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

export const PROVIDER_LABEL = { openai: "OpenAI", anthropic: "Anthropic" };

/** Which reader produced the values: the tender engine's model reading, or its rule-based reader. */
export function ReadingBanner({ result }) {
  if (!result) return null;
  if (result.mode === "rules+llm") {
    return (
      <div className="bid-mode" data-testid="bid-mode-merged">
        <CheckCircle2 size={14} />
        <span>Read by the tender engine: {result.merged?.fromRules ?? "–"} fields by its rule-based reader and {result.merged?.fromModel ?? "–"} more by its model reading ({[PROVIDER_LABEL[result.provider], result.model].filter(Boolean).join(" ")}). Every value is a quote checked against its page.</span>
      </div>
    );
  }
  if (result.mode === "llm") {
    return (
      <div className="bid-mode" data-testid="bid-mode-llm">
        <CheckCircle2 size={14} />
        <span>Read by the tender engine's model reading{result.model ? ` (${[PROVIDER_LABEL[result.provider], result.model].filter(Boolean).join(" ")})` : ""}: {result.usage?.calls || 0} calls, every value checked against its quote on the page.</span>
      </div>
    );
  }
  return (
    <div className="bid-mode rules" data-testid="bid-mode-rules">
      <CheckCircle2 size={14} />
      <span>Read by the tender engine's rule-based reader: every value below is a verbatim quote found on its page and checked against it.</span>
    </div>
  );
}

/** Every requirement of the tender on one page: what it says, how the sizing applies it, and the quote. */
export function TenderRequirements({ result, accepted, setAccepted }) {
  const proposals = useMemo(() => buildProposals(result), [result]);
  const groups = [...new Set(proposals.map((p) => p.group))];
  const used = proposals.filter((p) => isUsed(p, accepted)).length;
  const toggle = (p) => setAccepted({ ...accepted, [p.id]: !isUsed(p, accepted) });
  return (
    <div className="bid-terms" data-testid="bid-terms">
      <p className="rtc-note">{used} requirements apply to the model. A requirement whose quote is not found on its page, or does not print the value, is not applied unless you tick it after checking the page.</p>
      <div className="bid-req-table" role="table">
        <div className="bid-req-row head" role="row">
          <span>Use</span><span>Requirement</span><span>Tender says</span><span>How the sizing applies it</span><span>Page and quote</span>
        </div>
        {groups.map((g) => (
          <React.Fragment key={g}>
            <div className="bid-req-group">{g}</div>
            {proposals.filter((p) => p.group === g).map((p) => (
              <div key={p.id} className={`bid-req-row ${p.stated ? "" : "missing"}`} role="row" data-testid={`req-${p.id}`}>
                <span>
                  {p.stated
                    ? <input type="checkbox" checked={isUsed(p, accepted)} onChange={() => toggle(p)} aria-label={`Apply ${p.label}`} />
                    : <CircleDashed size={13} className="rtc-note" />}
                </span>
                <span><strong>{p.label}</strong></span>
                <span className="bid-req-value">{p.stated ? p.display : <em>Not stated in the tender</em>}</span>
                <span className="rtc-note">{p.stated && !p.source?.proved ? <><strong>Not proved by the page</strong>: applied only if you tick it. </> : null}{p.stated ? p.effect : "Not applied"}</span>
                <span className="bid-req-quote">{p.source ? <><SourceChip source={p.source} compact /> {p.source.quote ? <q>{p.source.quote}</q> : null}</> : null}</span>
              </div>
            ))}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

/** Every field the engine read, by section, with its quotes and checks. */
export function AllFields({ result }) {
  const [filter, setFilter] = useState("found");
  const [openSection, setOpenSection] = useState(null);
  const [openField, setOpenField] = useState(null);
  const sections = result.sections || [];
  const visible = (f) => (filter === "all" ? true : filter === "found" ? f.status === "validated" || f.status === "needs_review" : filter === "review" ? f.status === "needs_review" || f.status === "rejected" : f.status === "not_found");
  return (
    <Section index="1.2" title="Everything read from the tender" note={`${nf(result.counts?.found)} of ${nf(result.counts?.fields)} fields found · type ${result.tender_type}`}
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
          const open = openSection === sec.name;
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
                        <span>{f.label}{f.required ? " *" : ""}{f.reader === "model" ? <em className="bid-reader"> model</em> : null}</span>
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
  );
}
