import React, { useMemo } from "react";
import { ArrowRight, CircleCheck } from "lucide-react";
import { Field, Section, Stat, nf, pf } from "../rtc/ui";
import { LiveChart } from "../rtc/charts";
import { Cites } from "./Cite.jsx";
import { TENDER } from "./terms.js";
import { fmtDate } from "./model.js";
import { EXAMPLE_DEFAULTS, exampleMw, workedExample } from "./example.js";

// polarity of the CfD settlement (validated against the dark chart surface)
const POOL_PAYS = "#9473f0";
const YOU_PAY = "#c08420";

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const lakh = (v) => `₹${nf(Math.abs(v), 2)} lakh`;
const cr = (v) => `₹${nf(Math.abs(v), 2)} cr`;
const hour = (h) => `${String(h).padStart(2, "0")}:00–${String(h + 1).padStart(2, "0")}:00`;
const weekday = (t) => new Date(t).toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });

/** One evening as a waterfall: what the exchange pays, the Pool's top-up or claw-back, what you keep. */
function Evening({ title, e, sp, scale }) {
  const w = (v) => `${(Math.abs(v) / scale) * 100}%`;
  const poolIn = e.poolLakh >= 0;
  return (
    <div className="cfd-evening" data-testid="cfd-evening">
      <div className="cfd-evening-head"><span>{title}</span><strong>{fmtDate(e.date)}</strong></div>
      <p className="cfd-evening-hours">You sell {nf(e.mwhPerHour)} MWh in each of your 2 best hours: {e.hours.map((h, i) => `${hour(h)} at ₹${nf(e.prices[i], 2)}/kWh`).join(", ")}.</p>
      <div className="cfd-settle">
        <span>Exchange pays you</span>
        <div className="cfd-settle-bar"><i className="ex" style={{ width: w(e.exchangeLakh) }} /></div>
        <b>{lakh(e.exchangeLakh)}</b>
        <span>{poolIn ? "CfD Pool pays you" : "You pay the CfD Pool"}</span>
        <div className="cfd-settle-bar"><i style={{ marginLeft: poolIn ? w(e.exchangeLakh) : w(e.youLakh), width: w(e.poolLakh), background: poolIn ? POOL_PAYS : YOU_PAY }} /></div>
        <b>{poolIn ? "+" : "−"}{lakh(e.poolLakh)}</b>
        <span>You keep</span>
        <div className="cfd-settle-bar"><i className="you" style={{ width: w(e.youLakh) }} /></div>
        <b>{lakh(e.youLakh)}</b>
      </div>
      <small>= ₹{nf(sp, 2)}/kWh × {nf(e.mwhPerHour * e.prices.length)} MWh, whatever the price. {poolIn ? "The market paid less than your strike price, so the Pool tops it up." : e.poolLakh < 0 ? "The market paid more than your strike price, so you hand the excess to the Pool." : "The market paid exactly your strike price."}</small>
    </div>
  );
}

/** The year's evenings against the strike price: below it the Pool pays you, above it you pay the Pool (one bar per evening). */
function YearChart({ year, sp }) {
  const option = useMemo(() => ({
    animation: false,
    grid: { left: 52, right: 56, top: 24, bottom: 36 },
    tooltip: {
      trigger: "axis",
      formatter: (items) => {
        const s = year.series[items[0].dataIndex];
        const flow = s.poolLakh >= 0 ? `Pool pays you ₹${nf(s.poolLakh, 2)} lakh` : `you pay the Pool ₹${nf(-s.poolLakh, 2)} lakh`;
        return `${fmtDate(s.date)}<br/>Your 2 best hours: ₹${nf(s.avg, 2)}/kWh<br/>Strike price: ₹${nf(sp, 2)}/kWh<br/>${flow}`;
      },
    },
    xAxis: { type: "category", data: year.series.map((s) => new Date(s.date).toLocaleDateString("en-GB", { month: "short", year: "2-digit", timeZone: "UTC" })), axisLabel: { interval: (i) => new Date(year.series[i].date).getUTCDate() === 1 }, axisTick: { show: false } },
    yAxis: { type: "value", name: "₹/kWh", min: 0, max: Math.ceil(Math.max(sp, year.maxPrice) + 1), splitLine: { lineStyle: { color: "rgba(255,255,255,0.06)" } } },
    series: [
      { name: "Your 2 best evening hours", type: "bar", barCategoryGap: "20%", large: false,
        data: year.series.map((s) => ({ value: Number(s.avg.toFixed(3)), itemStyle: { color: s.avg < sp ? POOL_PAYS : YOU_PAY } })) },
      { name: "Your strike price", type: "line", data: year.series.map(() => sp), symbol: "none", silent: true, lineStyle: { color: "#d4ff3f", type: "dashed", width: 1.5 }, itemStyle: { color: "#d4ff3f" },
        endLabel: { show: true, formatter: `₹${nf(sp, 2)}`, color: "#d4ff3f" } },
    ],
  }), [year, sp]);
  return (
    <div className="rtc-card" data-testid="cfd-example-year">
      <div className="cfd-legend">
        <span><i className="box" style={{ background: POOL_PAYS }} /> Evening price below your strike price: the Pool pays you the gap</span>
        <span><i className="box" style={{ background: YOU_PAY }} /> Above it: you pay the Pool the excess</span>
        <span><i className="dashed" /> Your strike price</span>
      </div>
      <LiveChart option={option} height={300} />
    </div>
  );
}

/** Step 2: the tender worked through for one bid size, with real IEX evenings. */
export default function ExampleStep({ state, prices, model, setExample, goto }) {
  const ex = state.example || {};
  const i = state.inputs;
  const mw = exampleMw(state);
  const sp = isNum(ex.sp) ? ex.sp : model?.bid ?? EXAMPLE_DEFAULTS.sp;
  const spSource = isNum(ex.sp) ? "your example" : model?.bid ? "your bid from Bid and financials" : "an example; yours is solved on Bid and financials";
  const market = i.sellMarket || "DAM";
  const rte = isNum(i.rte) ? i.rte : EXAMPLE_DEFAULTS.rte;
  const solarCuf = isNum(i.solarCuf) ? i.solarCuf : EXAMPLE_DEFAULTS.solarCuf;
  const assumed = !isNum(i.rte) || !isNum(i.solarCuf);
  const x = useMemo(() => (prices ? workedExample({ mw, sp, prices, market, rte, solarCuf }) : null), [mw, sp, prices, market, rte, solarCuf]);

  const controls = (
    <div className="cfd-example-controls" data-testid="cfd-example-controls">
      <div className="cfd-chips" role="group" aria-label="Bid size">
        {[50, 100, 150].map((v) => <button key={v} type="button" className={mw === v ? "active" : ""} onClick={() => setExample({ mw: v })} data-testid={`cfd-example-mw-${v}`}>{v} MW</button>)}
      </div>
      <div data-testid="cfd-example-mw"><Field label="Bid size" unit="MW" value={mw} step={1} min={TENDER.bidMinMw} max={TENDER.bidMaxMw} onChange={(v) => setExample({ mw: Math.round(v) })} hint="50 to 150 MW (RfS 6.1)" /></div>
      <div data-testid="cfd-example-sp"><Field label="Strike price" unit="₹/kWh" value={sp} step={0.01} min={0} max={20} onChange={(v) => setExample({ sp: v })} hint={spSource} /></div>
      {(isNum(ex.mw) || isNum(ex.sp)) && <button type="button" className="secondary" onClick={() => setExample({ mw: null, sp: null })}>Use my bid</button>}
    </div>
  );

  if (!x) return <><Section index="2" title="Worked example" note="Loading IEX prices">{controls}</Section></>;
  const c = x.commit;
  const g = x.charging;
  const m = x.money;
  const w = x.week;
  const y = x.year;
  const scale = Math.max(...["low", "middle", "high"].map((k) => Math.max(x.evenings[k].exchangeLakh, x.evenings[k].youLakh)));

  return (
    <>
      <Section index="2" title={`Worked example: a ${nf(mw)} MW bid`} note={`Step by step, on real IEX ${market} evenings · this does not change your inputs`}>
        {controls}
        <div className="cfd-answer" data-testid="cfd-answer">
          <div className="cfd-answer-head"><CircleCheck size={18} /><div><span>Do you need a solar or wind plant already?</span><strong>No. You build everything after you win.</strong></div></div>
          <ul>
            <li>You bid as a company, on financial strength: a net worth and one liquidity test sized to the plant you propose. No operating plants or experience are asked for. <Cites ids={["company", "netWorth", "turnover"]} /></li>
            <li>After the award you build a battery of {nf(c.batteryMw)} MW / {nf(c.batteryMwh)} MWh by month 15 from the Effective Date, when supply starts, and your own RE by month 36. <Cites ids={["newProject", "essScd", "reCod"]} /></li>
            <li>Until month 36 the battery may be charged entirely with green-market or bilateral power (25% + 75%), so you supply before any solar or wind of yours runs. <Cites ids={["market25", "market75"]} /></li>
            <li>From month 36 your own RE covers what the market (25%) and your group companies' RE (50%) do not: at least {pf(g.ownShareWithGroup, 0)} of the year's energy, or {pf(g.ownShareAlone, 0)} without group RE. For {nf(mw)} MW that is about <strong>{nf(g.solarWithGroup, 0)} MWac</strong> or <strong>{nf(g.solarAlone, 0)} MWac</strong> of solar. <Cites ids={["group50", "discharged"]} /></li>
            <li>Its type and size are yours: solar, wind or both, smaller or larger than {nf(mw)} MW, co-located with the battery, and you may change it until the SCD. <Cites ids={["reSize", "configChange", "colocated"]} /></li>
            <li>Already own a plant with untied capacity? It may bid too, but the longer contract RfS 2.6 promises it refers to a Clause 11 that reads “Not used”. <Cites ids={["existingProjects", "existingAllowed"]} /></li>
          </ul>
        </div>
      </Section>

      <Section index="2.1" title="What you sign up for" note={`${nf(mw)} MW is ${pf(c.share, 0)} of the tender's 500 MW`}>
        <div className="rtc-grid rtc-grid-4" data-testid="cfd-example-commit">
          <Stat label="Every evening" value={`${nf(c.dailyMwh)} MWh`} detail={`${nf(mw)} MW for 2 hours you pick between 18:00 and 24:00`} />
          <Stat label="Every Contract Week" value={`${nf(c.weeklyMwh)} MWh`} detail={`at least ${nf(c.weeklyMinMwh)} MWh (90%) or a penalty`} />
          <Stat label="Every year" value={`${nf(c.yearlyMwh / 1000, 1)} GWh`} detail="for 15 years from the SCD" />
          <Stat label="Battery, at least" value={`${nf(c.batteryMw)} MW / ${nf(c.batteryMwh)} MWh`} detail="owned by you" />
        </div>
        <p className="rtc-note"><Cites ids={["mandate", "tolerance", "contractWeek", "term", "ess"]} /></p>
      </Section>

      <Section index="2.2" title="What you build, and how the battery is charged" note="Months from the Effective Date (the 30th day after the Letter of Award)">
        <div className="cfd-phases" data-testid="cfd-phases">
          <div><span>Months 0–15 · build</span><strong>Battery {nf(c.batteryMw)} MW / {nf(c.batteryMwh)} MWh and the line to an ISTS substation</strong><small>No supply yet. Financial closure 6 months before month 15.</small></div>
          <div><span>Months 15–36 · supply starts</span><strong>Charge from the green market, sell {nf(c.dailyMwh)} MWh each evening</strong><small>About {nf(g.perDayMwh, 0)} MWh a day bought in the day (at {pf(rte, 0)} round-trip efficiency); up to 100% may come from the market. Build your own RE meanwhile.</small></div>
          <div><span>Month 36 to the end of the term · own RE in</span><strong>Own RE gives at least {pf(g.ownShareWithGroup, 0)}–{pf(g.ownShareAlone, 0)} of the energy</strong><small>About {nf(g.solarWithGroup, 0)} MWac of solar with 50% group-company RE, or {nf(g.solarAlone, 0)} MWac without (at {pf(solarCuf, 0)} CUF). Market power at most 25%.</small></div>
        </div>
        <p className="rtc-note">{assumed ? `Solar is sized on energy alone with an example ${pf(rte, 0)} battery efficiency and ${pf(solarCuf, 0)} solar CUF (your own figures on Plant and sourcing replace them). ` : "Solar is sized on energy alone with your efficiency and CUF. "}Optimise own RE on Plant and sourcing finds the size that meets every day, not just the year. <Cites ids={["essScd", "reCod", "finClose"]} /></p>
      </Section>

      <Section index="2.3" title="Money you put up before you earn" note={`For ${nf(mw)} MW with ${nf(c.batteryMwh)} MWh of battery and ${nf(g.plantSolar)} MWac of solar`}>
        <div className="rtc-grid rtc-grid-4" data-testid="cfd-example-money">
          <Stat label="EMD with the bid" value={cr(m.emdCr)} detail="bank guarantee, returned once the PBG is in" />
          <Stat label="PBG after the award" value={cr(m.pbgCr)} detail="bank guarantee, until 6 months after the SCD" />
          <Stat label="SECI's charges" value={cr(m.cacCr + m.bidFeeCr + m.rfsCostCr)} detail="contract administration, bid fee, RfS cost; + GST" />
          <Stat label="Letter of Credit to SECI" value={cr(m.lcCr)} detail={`2000 × ${nf(mw)} MW × (₹10 − ₹${nf(sp, 2)}) × 30; all term`} />
        </div>
        <p className="rtc-note">You also need a net worth of {cr(m.netWorthCr)} for this plant. <Cites ids={["emd", "pbg", "cac", "bidFee", "lc", "netWorth"]} /></p>
      </Section>

      <Section index="2.4" title="Three real evenings, settled" note={`At your strike price of ₹${nf(sp, 2)}/kWh, on IEX ${market} prices`}>
        <div className="cfd-evenings">
          <Evening title="The cheapest evening of the year" e={x.evenings.low} sp={sp} scale={scale} />
          <Evening title="A middle evening" e={x.evenings.middle} sp={sp} scale={scale} />
          <Evening title="The dearest evening of the year" e={x.evenings.high} sp={sp} scale={scale} />
        </div>
        <p className="rtc-note">Whatever the market pays, you end each evening with your strike price on every kWh you supplied. The market price only decides whether the money comes from the Pool or goes to it. Settled every 15-minute block and billed monthly. <Cites ids={["settlement", "noRisk", "blockSettle"]} /></p>
      </Section>

      <Section index="2.5" title="A week with a missed evening" note={`Contract Week ${fmtDate(w.start)} – ${fmtDate(w.end)}`}>
        <div className="cfd-week" data-testid="cfd-example-week">
          <p>Say the battery trips on <strong>{weekday(w.missedDate)} {fmtDate(w.missedDate)}</strong> and you supply nothing that evening.</p>
          <div className="cfd-week-rows">
            <span>Required this week</span><b>{nf(w.requiredMwh)} MWh</b>
            <span>Supplied</span><b>{nf(w.suppliedMwh)} MWh</b>
            <span>Short</span><b>{nf(w.shortMwh)} MWh ({pf(w.shortPct, 1)})</b>
            <span>Free tolerance (10%)</span><b>{nf(w.freeMwh)} MWh</b>
            <span>Penalised</span><b>{nf(w.penalisedMwh)} MWh</b>
            <span>Reference price: the week's highest evening price on any exchange market</span><b>₹{nf(w.refPrice, 2)}/kWh ({w.refMarket}, {fmtDate(w.refDate)})</b>
            <span>Penalty = 1.5 × (₹{nf(w.refPrice, 2)} − ₹{nf(sp, 2)}) × {nf(w.penalisedMwh)} MWh</span><b>{w.penaltyLakh > 0 ? lakh(w.penaltyLakh) : "nil (the reference is not above your strike price)"}</b>
            <span>Plus the evening you did not sell (no CfD settlement for it)</span><b>{lakh(w.lostLakh)} lost</b>
          </div>
          <p className="rtc-note">Missing one hour instead ({nf(mw)} MWh, {pf(w.oneHourPct, 1)} of the week) stays within the 10% tolerance: no penalty, only that hour's revenue is lost. Prices are hourly averages of the 15-minute prices. <Cites ids={["shortfall", "tolerance", "noPenaltyBelow", "uncleared"]} /></p>
        </div>
      </Section>

      <Section index="2.6" title="A year of evenings at your strike price" note={`IEX ${market}, ${fmtDate(Date.parse(`${y.from}T00:00:00Z`))} – ${fmtDate(Date.parse(`${y.to}T00:00:00Z`))}; every evening supplied in full`}>
        <div className="rtc-grid rtc-grid-4" data-testid="cfd-example-yearstats">
          <Stat label="Energy supplied" value={`${nf(y.energyMwh / 1000, 1)} GWh`} detail={`average evening price ₹${nf(y.avgPrice, 2)}/kWh`} />
          <Stat label="The exchanges pay you" value={cr(y.exchangeCr)} detail="market price × energy" />
          <Stat label={y.poolCr >= 0 ? "The Pool pays you, net" : "You pay the Pool, net"} value={cr(y.poolCr)} detail={`Pool pays on ${y.daysPoolPays} evenings, you pay on ${y.daysYouPay}`} />
          <Stat label="You receive" value={cr(y.youCr)} detail={`₹${nf(sp, 2)}/kWh × ${nf(y.energyMwh / 1000, 1)} GWh`} />
        </div>
        <YearChart year={y} sp={sp} />
        <p className="rtc-note">The highest evening price in these 12 months was ₹{nf(y.maxPrice, 2)}/kWh: at a strike price above it, the Pool pays you every evening and never receives. SECI's ₹{TENDER.poolCr} crore Pool is your payment security. <Cites ids={["pool", "poolSecurity", "seciLimited"]} /></p>
      </Section>

      <Section index="2.7" title="Your bid" note="The strike price that covers your costs and return">
        <div className="cfd-bidline" data-testid="cfd-example-bid">
          <p>Your revenue is fixed by the strike price; the market price does not change it. So the strike price must pay for the battery, your own RE, the charging power, O&amp;M, the guarantees and the penalties, and earn your return over 15 years. In the e-Reverse Auction you then need to be within 2% of the lowest bid to win. <Cites ids={["spFixed", "range", "decrement"]} /></p>
          <div className="cfd-bidline-actions">
            <button type="button" className="secondary" onClick={() => goto("plant")}>Your plant and sourcing <ArrowRight size={14} /></button>
            <button type="button" className="primary" onClick={() => goto("finance")}>Solve your strike price <ArrowRight size={14} /></button>
          </div>
        </div>
      </Section>
    </>
  );
}
