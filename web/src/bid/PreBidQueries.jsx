import React, { useState } from "react";
import { AlertTriangle, Check, Clipboard, FileDown, FileSearch, Loader2, RotateCcw } from "lucide-react";
import { Section, nf } from "../rtc/ui";
import { tenderDates } from "./tenderMap";
import { PREBID_HOW, PREBID_QUERIES, PREBID_TENDER, PREBID_TITLE, queriesForWord, queriesText, queryWithEdits } from "./preBidQueries";

const toDate = (iso) => new Date(`${iso}T00:00:00`);
const fmt = (iso) => toDate(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

function Page({ page }) {
  return <span className="bid-src"><FileSearch size={10} /> p. {page}</span>;
}

/** When queries were due, from the tender's own schedule (the dates step reads the same fields). */
function Deadline({ result }) {
  const dates = tenderDates(result);
  const at = (id) => dates.find((d) => d.id === id);
  const last = at("core.key_dates.query_deadline");
  const meeting = at("core.key_dates.pre_bid_meeting_date");
  const reply = at("core.key_dates.query_response_date");
  if (!last) return null;
  const today = todayIso();
  const left = Math.round((toDate(last.date) - toDate(today)) / 86400000);
  const passed = left < 0;
  return (
    <div className={`bid-mode ${passed ? "rules" : ""}`} data-testid="prebid-deadline">
      {passed ? <AlertTriangle size={14} /> : <Check size={14} />}
      <span>
        {passed
          ? <>The tender's last date for queries was <strong>{fmt(last.date)}</strong> <Page page={last.source?.page} />{meeting ? <>, and the pre-bid meeting was on {fmt(meeting.date)}</> : null}. Check the TCIL portal for an extension or corrigendum before sending.{reply ? <> WBSEDCL's response to queries is due {fmt(reply.date)}.</> : null}</>
          : <>Last date for queries: <strong>{fmt(last.date)}</strong> <Page page={last.source?.page} /> ({left === 0 ? "today" : `${nf(left, 0)} day${left === 1 ? "" : "s"} left`}){meeting ? <>; pre-bid meeting {fmt(meeting.date)}</> : null}{reply ? <>; WBSEDCL replies by {fmt(reply.date)}</> : null}.</>}
      </span>
    </div>
  );
}

function QueryCard({ q, prebid, setPrebid }) {
  const cur = queryWithEdits(q, prebid);
  const edited = Boolean(prebid?.edits?.[q.id]);
  const setText = (key, value) => setPrebid((p) => {
    const edit = { ...(p.edits?.[q.id] || {}), [key]: value };
    if (value === q[key]) delete edit[key];
    const edits = { ...(p.edits || {}) };
    if (Object.keys(edit).length) edits[q.id] = edit; else delete edits[q.id];
    return { ...p, edits };
  });
  const toggle = () => setPrebid((p) => ({ ...p, off: { ...(p.off || {}), [q.id]: !p.off?.[q.id] } }));
  const reset = () => setPrebid((p) => { const edits = { ...(p.edits || {}) }; delete edits[q.id]; return { ...p, edits }; });
  const rows = (text) => Math.max(3, text.split("\n").reduce((n, line) => n + Math.ceil(line.length / 110), 0));
  return (
    <article className={`bid-q ${cur.include ? "" : "off"}`} data-testid={`prebid-${q.id}`}>
      <header>
        <span className="bid-q-no">Q{PREBID_QUERIES.indexOf(q) + 1}</span>
        <strong>{q.topic}</strong>
        <button type="button" className={`rtc-switch ${cur.include ? "on" : ""}`} aria-pressed={cur.include} onClick={toggle} data-testid={`prebid-include-${q.id}`}>
          <i />{cur.include ? "In the letter" : "Left out"}
        </button>
      </header>
      <ul className="bid-quotes">
        {q.refs.map((r) => <li key={r.quote}><Page page={r.page} /><span className="bid-chip">{r.clause}</span><q>{r.quote}</q></li>)}
      </ul>
      <label className="bid-q-field">
        <span>Clarification sought</span>
        <textarea value={cur.query} rows={rows(cur.query)} onChange={(e) => setText("query", e.target.value)} disabled={!cur.include} />
      </label>
      <label className="bid-q-field">
        <span>Rationale (sent to WBSEDCL)</span>
        <textarea value={cur.rationale} rows={rows(cur.rationale)} onChange={(e) => setText("rationale", e.target.value)} disabled={!cur.include} />
      </label>
      <div className="bid-q-note">
        <span><strong>Why it matters for the tariff</strong> (your note, not sent): {q.impact}</span>
        <span className="rtc-note">When answered, change: {q.model}</span>
        {edited && <button type="button" className="secondary" onClick={reset}><RotateCcw size={12} /> Back to the draft</button>}
      </div>
    </article>
  );
}

/** Tender step 1.2: pre-bid queries drafted from the RFP, ordered by their effect on the tariff. */
export default function PreBidQueries({ result, prebid, setPrebid }) {
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const number = result?.values?.["core.identity.tender_number"];
  if (number !== PREBID_TENDER) {
    return (
      <Section index="1.2" title="Pre-bid queries" note="Drafted for the WBSEDCL RE-RTC RfQ/RfP">
        <p className="rtc-note">Pre-bid queries are drafted for the WBSEDCL RE-RTC tender ({PREBID_TENDER}). Open it from 1.4 to see them.</p>
      </Section>
    );
  }
  const included = PREBID_QUERIES.filter((q) => !prebid?.off?.[q.id]).length;

  async function copy() {
    setError("");
    try {
      await navigator.clipboard.writeText(queriesText(prebid, number));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("The browser did not allow copying; download the Word file instead.");
    }
  }

  async function download() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/bid/queries", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(queriesForWord(prebid, number)),
      });
      if (!res.ok) {
        let msg = `Download failed (${res.status})`;
        try { msg = (await res.json()).error || msg; } catch { /* not JSON */ }
        throw new Error(msg);
      }
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = "WBSEDCL_RE-RTC_pre-bid_queries.docx";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section index="1.2" title="Pre-bid queries" note={`${included} of ${PREBID_QUERIES.length} in the letter · largest effect on the tariff first`}
      actions={(
        <>
          <button type="button" className="secondary" onClick={copy} disabled={!included} data-testid="prebid-copy">
            {copied ? <Check size={14} /> : <Clipboard size={14} />} {copied ? "Copied" : "Copy all"}
          </button>
          <button type="button" className="primary" onClick={download} disabled={!included || busy} data-testid="prebid-download">
            {busy ? <Loader2 className="spin" size={14} /> : <FileDown size={14} />} Download Word file
          </button>
        </>
      )}>
      <div className="bid-q-head">
        <Deadline result={result} />
        <p className="rtc-note">
          Each query quotes the clause it asks about, word for word, with its page. Send them as RFP clause 1.1.10 <Page page={PREBID_HOW.page} /> asks: in writing on the TCIL portal, or by speed post/courier and e-mail with the queries in a Microsoft Word file, titled “{PREBID_TITLE}”. Edit any text or leave a query out; the Word file and Copy all use your version.
        </p>
        <label className="bid-q-field bidder">
          <span>Bidder (printed on the letter)</span>
          <input value={prebid?.bidder || ""} onChange={(e) => setPrebid((p) => ({ ...p, bidder: e.target.value }))} placeholder="Company name" data-testid="prebid-bidder" />
        </label>
        {error && <div className="alert"><AlertTriangle size={14} /> {error}</div>}
      </div>
      <div className="bid-q-list">
        {PREBID_QUERIES.map((q) => <QueryCard key={q.id} q={q} prebid={prebid} setPrebid={setPrebid} />)}
      </div>
    </Section>
  );
}
