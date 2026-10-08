import React, { useMemo } from "react";
import { ArrowRight, CalendarDays, Clock } from "lucide-react";
import { Section, Stat, nf } from "../rtc/ui";
import { tenderDates } from "./tenderMap";
import { SourceChip } from "./RequirementsStep";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const KIND = { bidding: "Bidding", deadline: "Bid deadline", award: "Award and PPA", supply: "Supply" };

const toDate = (iso) => new Date(`${iso}T00:00:00`);
const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const fmt = (iso) => toDate(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
const daysFrom = (today, iso) => Math.round((toDate(iso) - toDate(today)) / 86400000);
const when = (n) => (n === 0 ? "today" : n > 0 ? `in ${nf(n, 0)} day${n === 1 ? "" : "s"}` : `${nf(-n, 0)} day${n === -1 ? "" : "s"} ago`);

/** One month: the days in a Monday-first grid, the tender's dates marked. */
function Month({ year, month, events, today }) {
  const first = new Date(year, month, 1);
  const lead = (first.getDay() + 6) % 7;
  const days = new Date(year, month + 1, 0).getDate();
  const byDay = {};
  for (const e of events) byDay[e.date] = [...(byDay[e.date] || []), e];
  const cells = [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];
  return (
    <div className="bid-month" data-testid={`month-${year}-${month + 1}`}>
      <h4>{MONTHS[month]} {year}</h4>
      <div className="bid-month-days">
        {WEEKDAYS.map((w) => <span key={w} className="bid-weekday">{w}</span>)}
        {cells.map((d, i) => {
          if (!d) return <span key={`x${i}`} />;
          const iso = isoOf(new Date(year, month, d));
          const evs = byDay[iso] || [];
          const kind = evs[0]?.kind;
          return (
            <span key={iso} className={`bid-day ${evs.length ? `ev ${kind}` : ""} ${iso === today ? "today" : ""} ${evs.length && iso < today ? "past" : ""}`}
              title={evs.map((e) => e.label).join("\n") || undefined}>
              {d}
            </span>
          );
        })}
      </div>
      <ul className="bid-month-events">
        {events.map((e) => <li key={e.id} className={e.kind}><strong>{toDate(e.date).getDate()}</strong> {e.label}</li>)}
      </ul>
    </div>
  );
}

/** Step 2: the tender's dates on a calendar, with what is next and how far away. */
export default function DatesStep({ state, goto }) {
  const result = state.tender?.result;
  const events = useMemo(() => tenderDates(result), [result]);
  const today = isoOf(new Date());
  if (!events.length) {
    return (
      <Section index="2" title="Key dates">
        <p className="rtc-note">The tender reading has no dates. Open or read a tender first.</p>
        <button type="button" className="primary" onClick={() => goto("tender")}>Tender <ArrowRight size={14} /></button>
      </Section>
    );
  }
  const months = [];
  for (const e of events) {
    const d = toDate(e.date);
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    let m = months.find((x) => x.key === key);
    if (!m) months.push((m = { key, year: d.getFullYear(), month: d.getMonth(), events: [] }));
    m.events.push(e);
  }
  const next = events.find((e) => e.date >= today);
  const deadline = events.find((e) => e.kind === "deadline");
  const start = events.find((e) => e.id.endsWith("supply_start_date"));
  return (
    <Section index="2" title="Key dates" note="Every date the tender prints, from the reading, with its page and quote"
      actions={<button type="button" className="primary" onClick={() => goto("capacity")} data-testid="bid-to-capacity-2">Bid capacity <ArrowRight size={14} /></button>}>
      <div className="rtc-grid rtc-grid-3" data-testid="bid-dates-head">
        <Stat label="Next" value={next ? next.label : "All dates passed"} detail={next ? `${fmt(next.date)} · ${when(daysFrom(today, next.date))}` : ""} />
        {deadline && <Stat label="Bid submission closes" value={fmt(deadline.date)} detail={when(daysFrom(today, deadline.date))} tone={daysFrom(today, deadline.date) < 7 ? "bad" : undefined} />}
        {start && <Stat label="Supply starts" value={fmt(start.date)} detail={when(daysFrom(today, start.date))} />}
      </div>
      <div className="bid-legend">{Object.entries(KIND).map(([k, label]) => <span key={k} className={`bid-legend-item ${k}`}><i /> {label}</span>)}<span className="bid-legend-item today"><i /> Today</span></div>
      <div className="bid-cal" data-testid="bid-calendar">
        {months.map((m) => <Month key={m.key} year={m.year} month={m.month} events={m.events} today={today} />)}
      </div>
      <div className="bid-agenda" role="table" data-testid="bid-agenda">
        <div className="bid-agenda-row head" role="row"><span>Date</span><span>Event</span><span>When</span><span>Page and quote</span></div>
        {events.map((e) => {
          const n = daysFrom(today, e.date);
          return (
            <div key={e.id} className={`bid-agenda-row ${e.kind} ${n < 0 ? "past" : ""}`} role="row" data-testid={`date-${e.id.split(".").pop()}`}>
              <span><CalendarDays size={12} /> {fmt(e.date)}<small>{toDate(e.date).toLocaleDateString("en-GB", { weekday: "long" })}</small></span>
              <span><strong>{e.label}</strong></span>
              <span className="rtc-note"><Clock size={11} /> {when(n)}</span>
              <span className="bid-req-quote"><SourceChip source={e.source} compact /> {e.source?.quote ? <q>{e.source.quote}</q> : null}</span>
            </div>
          );
        })}
      </div>
    </Section>
  );
}
