import React from "react";
import { ArrowRight, CheckCircle2, TriangleAlert } from "lucide-react";
import { Field, Section, Stat, nf } from "../rtc/ui";
import { capacityIssues, plantMw, solarMinMw } from "./model";
import { SourceChip } from "./RequirementsStep";

const fmtDate = (v) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || ""));
  return m ? `${m[3]}.${m[2]}.${m[1]}` : v;
};

/** Step 2: the capacity the bidder bids, within what the tender allows. */
export default function CapacityStep({ state, setState, terms, goto }) {
  const prov = terms.provenance;
  const issues = capacityIssues(state, terms);
  const total = plantMw(state, terms);
  const solarMin = solarMinMw(state, terms);
  const setBid = (values) => setState((s) => ({ ...s, bid: { ...s.bid, ...values }, lp: null }));
  return (
    <Section index="2" title="Bid capacity" note="Your answer; the tender's limits are shown with their pages"
      actions={<button type="button" className="primary" onClick={() => goto("sources")} disabled={issues.length > 0} data-testid="bid-to-sources">Supply sources <ArrowRight size={14} /></button>}>
      <div className="bid-tender-facts">
        <div><span>Base supply capacity</span><strong>{terms.baseMw ? `${nf(terms.baseMw, 0)} MW` : "Not stated"}</strong><SourceChip source={prov.capacity} /></div>
        <div><span>Part capacity</span><strong>{terms.partAllowed === false ? "Not allowed: bid the whole capacity" : terms.partAllowed ? "Allowed" : "Not stated"}</strong><SourceChip source={prov.part} /></div>
        <div><span>Greenshoe</span><strong>{terms.greenshoeMw ? `${nf(terms.greenshoeMw, 0)} MW at the procurer's option` : "None stated"}</strong><SourceChip source={prov.greenshoe} /></div>
        {terms.greenshoeStart && <div><span>Greenshoe supply start</span><strong>{fmtDate(terms.greenshoeStart)}</strong><SourceChip source={prov.greenshoeStart} /></div>}
        {terms.greenshoeSameTariff && <div><span>Greenshoe tariff</span><strong>Same as the base capacity</strong><SourceChip source={prov.greenshoeTariff} /></div>}
        {terms.supplyStart && <div><span>Base supply start</span><strong>{fmtDate(terms.supplyStart)}</strong><SourceChip source={prov.start} /></div>}
      </div>

      <div className="rtc-grid rtc-grid-2">
        <div data-testid="bid-base-mw">
          <Field label="Capacity you bid" unit="MW" value={state.bid.baseMw} onChange={(v) => setBid({ baseMw: v })} step={10} min={1}
            hint={terms.partAllowed === false && terms.baseMw ? `The tender requires ${nf(terms.baseMw, 0)} MW` : "Round-the-clock supply capacity"} />
        </div>
        {terms.greenshoeMw ? (
          <div className="rtc-field" data-testid="bid-greenshoe">
            <div className="rtc-field-top"><span>Size the plant for the greenshoe {nf(terms.greenshoeMw, 0)} MW as well?</span></div>
            <div className="bid-choice">
              <button type="button" className={state.bid.greenshoe === true ? "active" : ""} onClick={() => setBid({ greenshoe: true })}>Yes: {nf((state.bid.baseMw || 0) + terms.greenshoeMw, 0)} MW</button>
              <button type="button" className={state.bid.greenshoe === false ? "active" : ""} onClick={() => setBid({ greenshoe: false })}>No: the bid capacity only</button>
            </div>
            <small>{terms.greenshoeSameTariff ? "The greenshoe is supplied at the same tariff, so one tariff must cover both. " : ""}The sizing supplies the chosen capacity from year 1.</small>
          </div>
        ) : null}
      </div>

      {issues.length > 0
        ? <ul className="bid-warnings" data-testid="bid-capacity-issues">{issues.map((m) => <li key={m}><TriangleAlert size={12} /> {m}</li>)}</ul>
        : (
          <div className="rtc-grid rtc-grid-3" data-testid="bid-capacity-ok">
            <Stat label="Contracted capacity sized" value={`${nf(total, 0)} MW`} detail={state.bid.greenshoe ? "bid + greenshoe" : "bid"} />
            {solarMin ? <Stat label="Solar the tender requires" value={`${nf(solarMin, 0)} MW at least`} detail={`${terms.solarMultiple} × contracted capacity`} /> : null}
            <Stat label="Supply floors" value={terms.rules.length ? terms.rules.map((r) => `${Math.round(r.target * 100)}%`).join(" · ") : "None stated"} detail={terms.rules.map((r) => r.label.replace(" supply floor", "")).join(" · ")} />
          </div>
        )}
      {issues.length === 0 && <p className="rtc-note"><CheckCircle2 size={12} /> Next, tell the model which supply sources you have, with their parameters and costs.</p>}
    </Section>
  );
}
