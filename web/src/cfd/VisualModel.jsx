import React, { useMemo } from "react";
import { Section, nf } from "../rtc/ui";
import { LiveChart } from "../rtc/charts";
import Cite, { Cites } from "./Cite.jsx";
import { TENDER } from "./terms.js";
import { fmtDate, keyDates } from "./model.js";

/** A box of the flow diagram: a title and up to five lines. */
function Node({ x, y, w, h, tone, title, lines }) {
  return (
    <g className={`cfd-node ${tone}`}>
      <rect x={x} y={y} width={w} height={h} rx="6" />
      <rect className="cfd-node-accent" x={x} y={y} width="5" height={h} rx="2" />
      <text x={x + 18} y={y + 26} className="cfd-node-title">{title}</text>
      {lines.map((l, i) => <text key={i} x={x + 18} y={y + 48 + i * 19} className="cfd-node-line">{l}</text>)}
    </g>
  );
}

function Arrow({ d, label, lx, ly, dashed = false, tone = "" }) {
  return (
    <g className={`cfd-arrow ${tone} ${dashed ? "dashed" : ""}`}>
      <path d={d} markerEnd="url(#cfd-head)" />
      {label && <text x={lx} y={ly} className="cfd-arrow-label">{label}</text>}
    </g>
  );
}

/** Energy and money in SECI CfD-I: who supplies what, where it is sold and how it is settled. */
export function FlowDiagram({ mw }) {
  const X = mw || 100;
  return (
    <svg className="cfd-svg" viewBox="0 0 1150 580" role="img" aria-label="How the SECI CfD-I tender works: energy and money flows" data-testid="cfd-flow">
      <defs>
        <marker id="cfd-head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" className="cfd-head" />
        </marker>
      </defs>
      <Node x={420} y={16} w={280} h={88} tone="bid" title="You bid one strike price (SP)" lines={["₹/kWh for 50–150 MW, no ceiling", "e-RA; fixed for the 15-year term"]} />
      <Node x={20} y={140} w={300} h={104} tone="re" title="Your RE plant: solar / wind" lines={["co-located with the battery", "online by ED + 36 months", "after that: at least 25% of supply"]} />
      <Node x={20} y={272} w={300} h={88} tone="group" title="Group-company RE" lines={["after month 36: up to 50%", "only to charge the battery"]} />
      <Node x={20} y={388} w={300} h={104} tone="market" title="Green market (GDAM) / bilateral" lines={["up to 25% for the whole term", "+75% until month 36,", "only to charge the battery"]} />
      <Node x={420} y={214} w={280} h={142} tone="ess" title="Battery (mandatory)" lines={[`${nf(X)} MW / ${nf(2 * X)} MWh for ${nf(X)} MW bid`, "at least X MW / 2X MWh", "owned by you, co-located", "commissioned by ED + 15 months"]} />
      <Node x={800} y={130} w={300} h={210} tone="px" title="Power exchange" lines={["IEX · PXIL · HPX", "DAM · GDAM · HP-DAM · RTM · TAM · G-TAM", "every day, 2 hours you pick", "between 18:00 and 24:00", `2 MWh per MW: ${nf(2 * X)} MWh a day`, "only cleared volume is settled"]} />
      <Node x={800} y={392} w={300} h={160} tone="pool" title="SECI CfD Pool · ₹76 crore" lines={["MCP below SP: the Pool pays", "you SP − MCP", "MCP above SP: you pay the", "Pool MCP − SP (per 15-min block)"]} />
      <Node x={420} y={420} w={280} h={132} tone="you" title="You net SP on every kWh" lines={["supplied, up to 2 MWh/MW a day", "the market price risk is the Pool's", "plus 50% of RECs (brown markets)", "less fees, charging power, penalties"]} />
      <Arrow d="M 320 196 C 370 196 380 250 418 262" label="charge" lx={340} ly={186} tone="re" />
      <Arrow d="M 320 316 C 370 316 380 296 418 292" label="charge" lx={346} ly={306} tone="group" />
      <Arrow d="M 320 440 C 370 440 380 340 418 330" label="charge" lx={340} ly={430} tone="market" />
      <Arrow d="M 320 160 C 520 110 650 120 798 170" label="wind in the peak hours; surplus RE sold after the day's supply" lx={430} ly={124} dashed tone="re" />
      <Arrow d="M 700 280 C 740 280 760 260 798 250" label="2 h discharge" lx={706} ly={262} tone="ess" />
      <Arrow d="M 860 340 C 860 388 760 432 702 452" label="MCP × energy" lx={760} ly={380} tone="px" />
      <Arrow d="M 798 470 C 760 470 740 488 702 492" label="± (SP − MCP)" lx={716} ly={466} tone="pool" />
      <Arrow d="M 700 60 H 1132 V 440 H 1104" label="SP sets every settlement" lx={860} ly={52} dashed tone="bid" />
    </svg>
  );
}

const MONTH_X = (m) => 40 + (Math.min(m, 40) / 40) * 760;

/** The tender's dates from the Effective Date: construction, battery SCD, own RE, the 15-year term. */
export function Timeline({ effectiveDate }) {
  const d = effectiveDate && /^\d{4}-\d{2}-\d{2}$/.test(effectiveDate) ? keyDates(effectiveDate) : null;
  const at = (k) => (d ? fmtDate(d[k]) : "");
  const marks = [
    { m: 0, up: true, title: "Effective Date", sub: "LoA + 30 days; CfDA signed", date: at("ed") },
    { m: 9, up: false, end: true, title: "Financial closure", sub: "6 months before the SCD", date: at("finClose") },
    { m: 15, up: true, title: "SCD: battery commissioned", sub: "supply and CfD settlement start", date: at("scd") },
    { m: 18, up: false, title: "Latest with penalty", sub: "PBG encashed pro rata; later: capacity cut", date: at("lastWithPenalty") },
    { m: 36, up: true, title: "Own RE commissioned", sub: "charging: 25% market + 50% group max", date: at("reDeadline") },
  ];
  return (
    <svg className="cfd-svg cfd-timeline" viewBox="0 0 1120 190" role="img" aria-label="Tender timeline" data-testid="cfd-timeline">
      <rect x={MONTH_X(0)} y="86" width={MONTH_X(15) - MONTH_X(0)} height="16" className="cfd-band build" />
      <rect x={MONTH_X(15)} y="86" width={MONTH_X(36) - MONTH_X(15)} height="16" className="cfd-band early" />
      <rect x={MONTH_X(36)} y="86" width={1080 - MONTH_X(36)} height="16" className="cfd-band term" />
      <text x={MONTH_X(4)} y="98" className="cfd-band-label" textAnchor="middle">construction</text>
      <text x={MONTH_X(25.5)} y="98" className="cfd-band-label" textAnchor="middle">charging may be 100% green market</text>
      <text x={950} y="98" className="cfd-band-label" textAnchor="middle">own RE ≥ 25% of supply</text>
      <line x1="40" y1="94" x2="1080" y2="94" className="cfd-axis" />
      <path d="M 832 80 l 8 28 M 846 80 l 8 28" className="cfd-break" />
      {marks.map((k) => (
        <g key={k.m} className="cfd-mark">
          <line x1={MONTH_X(k.m)} x2={MONTH_X(k.m)} y1={k.up ? 50 : 102} y2={k.up ? 86 : 138} />
          <circle cx={MONTH_X(k.m)} cy="94" r="5" />
          <text x={MONTH_X(k.m) + (k.end ? -6 : 6)} y={k.up ? 22 : 152} className="cfd-mark-title" textAnchor={k.end ? "end" : "start"}>{k.title} · month {k.m}</text>
          <text x={MONTH_X(k.m) + (k.end ? -6 : 6)} y={k.up ? 38 : 168} className="cfd-mark-sub" textAnchor={k.end ? "end" : "start"}>{k.sub}{k.date ? ` · ${k.date}` : ""}</text>
        </g>
      ))}
      <g className="cfd-mark end">
        <line x1="1060" x2="1060" y1="50" y2="86" />
        <circle cx="1060" cy="94" r="5" />
        <text x="1076" y="22" className="cfd-mark-title" textAnchor="end">Term ends</text>
        <text x="1076" y="38" className="cfd-mark-sub" textAnchor="end">SCD + 15 years{d ? ` · ${at("end")}` : ""}</text>
      </g>
    </svg>
  );
}

/** A day of the obligation: average evening prices, the two best hours, charging and discharge (illustrative). */
export function TypicalDay({ prices, mw, market = "DAM" }) {
  const mean = useMemo(() => prices?.markets?.[market]?.hourOfDayMeanRsPerMwh?.map((v) => v / 1000) || null, [prices, market]);
  const best = useMemo(() => {
    const peak = Array.from({ length: TENDER.peakEnd - TENDER.peakStart }, (_, i) => TENDER.peakStart + i);
    return mean ? [...peak].sort((a, b) => mean[b] - mean[a]).slice(0, 2).sort((a, b) => a - b) : null;
  }, [mean]);
  const option = useMemo(() => {
    const X = mw || 100;
    const need = (2 * X) / 0.87;
    const sun = Array.from({ length: 24 }, (_, h) => Math.max(0, Math.sin((Math.PI * (h - 6)) / 12)));
    const sunTotal = sun.reduce((a, v) => a + v, 0);
    const charge = sun.map((v) => -Math.min(X, (need * v) / sunTotal));
    const discharge = Array.from({ length: 24 }, (_, h) => ((best || [19, 20]).includes(h) ? X : 0));
    const labels = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, "0")}:00`);
    let soc = 0;
    const socLine = Array.from({ length: 24 }, (_, h) => { soc += -charge[h] * 0.87 - discharge[h]; return Math.max(0, soc); });
    return {
      animation: false,
      grid: { left: 56, right: 56, top: 40, bottom: 40 },
      legend: { top: 0, right: 0 },
      tooltip: { trigger: "axis" },
      xAxis: { type: "category", data: labels, axisLabel: { interval: 2 } },
      yAxis: [{ type: "value", name: "MW / MWh" }, { type: "value", name: "₹/kWh", min: 0, splitLine: { show: false } }],
      series: [
        { name: "Battery charging", type: "bar", data: charge.map((v) => Number(v.toFixed(1))), itemStyle: { color: "rgba(125,220,154,0.55)" }, barWidth: "70%",
          markArea: { silent: true, itemStyle: { color: "rgba(212,255,63,0.07)" }, label: { show: true, position: "insideTop", color: "#d4ff3f", fontSize: 11 }, data: [[{ name: "Peak Hours 18:00–24:00", xAxis: labels[18] }, { xAxis: labels[23] }]] } },
        { name: "Supply to the exchange (2 h)", type: "bar", data: discharge, itemStyle: { color: "#a98bff" }, barWidth: "70%" },
        { name: "Battery energy", type: "line", data: socLine.map((v) => Number(v.toFixed(1))), symbol: "none", lineStyle: { color: "#a98bff", type: "dashed", width: 1.4 }, itemStyle: { color: "#a98bff" } },
        ...(mean ? [{ name: `${market} average price`, type: "line", yAxisIndex: 1, data: mean.map((v) => Number(v.toFixed(2))), symbol: "none", lineStyle: { color: "#f2b84b", width: 1.6 }, itemStyle: { color: "#f2b84b" } }] : []),
      ],
    };
  }, [mean, best, mw, market]);
  return (
    <div className="rtc-card" data-testid="cfd-typical-day">
      <div className="rtc-card-head">
        <span>A day of supply for {nf(mw || 100)} MW (illustrative): charge from RE in the day, sell 2 MWh/MW in the best 2 evening hours{best ? ` (on average ${best.map((h) => `${String(h).padStart(2, "0")}:00`).join(" and ")} in the ${market})` : ""}</span>
      </div>
      <LiveChart option={option} height={300} />
    </div>
  );
}

const STEPS_TO_DO = [
  { when: "Bid", text: "Bid once for yourself and your group: 50 to 150 MW in whole MW. Pay the RfS cost (₹50,000) and the bid processing fee (₹20,000/MW, at most ₹20 lakh), plus GST, and give an EMD bank guarantee valid 12 months. Show the net worth and one of the liquidity tests for the plant you propose.", cites: ["capacityBid", "rfsCost", "bidFee", "emd", "netWorth", "turnover"] },
  { when: "e-Reverse Auction", text: "Quote one first-round strike price (₹/kWh, two decimals, no ceiling) for all your projects; in the e-RA lower it in steps of at least 1 paisa. Every bidder within L1 + 2% wins, in tariff order, up to 80% of the capacity bid (at most 500 MW).", cites: ["bid", "ceiling", "decrement", "range", "se"] },
  { when: "LoA + 20 days", text: "Pay the Contract Administration Charges (₹1 lakh/MW + GST) and give the PBG (₹24.20 lakh/MW solar, ₹34.20 lakh/MW wind, ₹6 lakh/MWh battery), valid until 6 months after the SCD. Late: ₹1,000/MW a day.", cites: ["docsDue", "cac", "pbg", "pbgValidity", "lateDocs"] },
  { when: "LoA + 30 days", text: "Sign the CfDA. Its Effective Date is the 30th day from the LoA, and every date below runs from it. Keep at least 51% of the project company until a year after the SCD.", cites: ["cfdaSign", "effectiveDate", "lockIn"] },
  { when: "SCD − 6 months", text: "Reach financial closure (late: ₹100/MW a day, paid in advance).", cites: ["finClose", "fcLate"] },
  { when: "By ED + 15 months", text: "Build and own a battery of at least X MW / 2X MWh, co-located with your RE and connected to an ISTS substation at 220 kV or above with non-solar-hour access. This is the SCD: supply and settlement start.", cites: ["ess", "essOwned", "colocated", "delivery", "substation", "essScd"] },
  { when: "By ED + 36 months", text: "Commission your own RE generation (solar with domestic cells and modules, wind or other RE, in any mix; it may exceed the Contracted Capacity, the grid connection may not).", cites: ["reCod", "reSize", "dcr", "connectivity"] },
  { when: "Every day", text: "Choose 2 hours (eight 15-minute blocks) between 18:00 and 24:00 a day ahead and sell 2 MWh per contracted MW on an exchange, in the market of your choice. Make sure the bids clear: uncleared energy counts as shortfall.", cites: ["twoHours", "mandate", "blocks", "cleared", "markets"] },
  { when: "Every day", text: "Supply only RE. Charge the battery from your own RE; up to 25% may come from the green market or bilateral deals (plus 75% for charging until month 36); after month 36 up to 50% may come from your group companies' RE projects.", cites: ["allRe", "market25", "market75", "group50", "discharged"] },
  { when: "Every week", text: "Supply at least 90% of 14 MWh per MW in each Contract Week, or pay 1.5 × (the week's highest evening MCP across all exchanges − SP) on the shortfall beyond 10%.", cites: ["tolerance", "shortfall", "noPenaltyBelow"] },
  { when: "Every month", text: "Settle with SECI's CfD Pool: you receive SP − MCP when the market clears below the strike price and pay MCP − SP when it clears above, block by block, billed monthly.", cites: ["settlement", "noRisk", "blockSettle"] },
  { when: "All term", text: "Keep a Letter of Credit for SECI of 2000 × MW × (₹10 − SP) × 30. Sell the RECs from brown-market sales within 3 months and pay half the proceeds to the Pool.", cites: ["lc", "rec"] },
  { when: "All term", text: "Sell anything else (surplus RE, other battery use) only after the day's peak supply is met, within the connection.", cites: ["essOtherUse", "thirdParty"] },
];

/** Step 1: the tender as a picture: flows, dates, a day, and the bidder's obligations in order. */
export default function VisualModel({ state, prices }) {
  const X = state.inputs.contractedMw || 100;
  return (
    <>
      <Section index="1" title="How SECI CfD-I works" note="Assured peak supply of 1000 MWh a day (500 MW × 2 h), settled against your strike price">
        <div className="cfd-lead">
          <p>You build a battery with your own renewable generation, sell <strong>2 MWh per contracted MW every evening</strong> on a power exchange, and SECI's CfD Pool tops your price up to the <strong>strike price you bid</strong> (or takes the excess) on every kWh. Since Amendment-03 you keep no market gain and bear no market loss on that energy <Cite id="noRisk" compact />.</p>
          <p>You need no plant to bid: you build the battery and your own solar or wind after you win, and until month 36 the battery may be charged entirely from the green market <Cite id="newProject" compact /> <Cite id="market75" compact />. Step 2, <strong>Worked example</strong>, walks a bid of your size through real evenings.</p>
        </div>
        <FlowDiagram mw={X} />
      </Section>
      <Section index="1.1" title="Timeline" note={state.inputs.effectiveDate ? `From the Effective Date you entered (${fmtDate(Date.parse(`${state.inputs.effectiveDate}T00:00:00Z`))})` : "Months from the Effective Date of the CfDA; enter the date on Plant and sourcing to see the calendar dates"}>
        <Timeline effectiveDate={state.inputs.effectiveDate} />
        <p className="rtc-note">Dates: <Cites ids={["effectiveDate", "essScd", "reCod", "term", "finClose", "delay", "delayBeyond", "fmExtension"]} /></p>
      </Section>
      <Section index="1.2" title="A day of supply" note="IEX prices, Sep 2025 – Sep 2026">
        <TypicalDay prices={prices} mw={X} market={state.inputs.sellMarket || "DAM"} />
      </Section>
      <Section index="1.3" title="What the winning bidder must do" note="In order, each with the clause it comes from">
        <ol className="cfd-todo" data-testid="cfd-todo">
          {STEPS_TO_DO.map((s, i) => (
            <li key={i}>
              <span className="cfd-todo-when">{s.when}</span>
              <span>{s.text}</span>
              <span className="cfd-todo-cites"><Cites ids={s.cites} /></span>
            </li>
          ))}
        </ol>
      </Section>
      <Section index="1.4" title="Your money, in one line" note="What the financial model computes">
        <div className="cfd-money" data-testid="cfd-money">
          <div><span>Revenue</span><strong>SP × energy supplied</strong><small>up to 2 MWh/MW a day, cleared; + 50% of REC sales; + surplus RE sold after the day's supply</small></div>
          <div><span>Costs</span><strong>Battery + own RE + charging power</strong><small>capex, O&M, augmentation, green-market or group power, exchange fees, LC, EMD and PBG guarantees, SECI's charges, weekly penalties</small></div>
          <div><span>Your bid</span><strong>The SP that earns your equity IRR</strong><small>solved on Bid and financials, rounded up to two decimals</small></div>
        </div>
      </Section>
    </>
  );
}
