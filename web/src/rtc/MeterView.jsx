import React from "react";
import { Gauge } from "lucide-react";
import * as E from "./engine";
import { DATA_COLORS } from "../chartTheme";
import { Section, Stat, nf, pf } from "./ui";

// ---------------------------------------------------------------- isometric drawing helpers
// World units: x runs to the lower right, y to the lower left, z up. One projection for the scene.
const OX = 330;
const OY = 112;
const C = Math.cos(Math.PI / 6);
const P = (x, y, z = 0) => [OX + (x - y) * C, OY + (x + y) * 0.5 - z];
const pts = (list) => list.map(([x, y, z]) => P(x, y, z).join(",")).join(" ");

/** A box: top, the +x face and the +y face (the three a viewer from the front sees). */
function Box({ x, y, z = 0, w, d, h, tone = "steel", className = "" }) {
  const top = [[x, y, z + h], [x + w, y, z + h], [x + w, y + d, z + h], [x, y + d, z + h]];
  const right = [[x + w, y, z], [x + w, y + d, z], [x + w, y + d, z + h], [x + w, y, z + h]];
  const front = [[x, y + d, z], [x + w, y + d, z], [x + w, y + d, z + h], [x, y + d, z + h]];
  return (
    <g className={`iso-box iso-${tone} ${className}`}>
      <polygon className="f-right" points={pts(right)} />
      <polygon className="f-front" points={pts(front)} />
      <polygon className="f-top" points={pts(top)} />
    </g>
  );
}

/** A flat area on the ground (a yard or a pad). */
function Pad({ x, y, w, d, className = "iso-pad" }) {
  return <polygon className={className} points={pts([[x, y, 0], [x + w, y, 0], [x + w, y + d, 0], [x, y + d, 0]])} />;
}

/** A row of tilted module tables (front edge low, back edge high). */
function Table({ x, y, w, d }) {
  const lo = 5;
  const hi = 13;
  const face = [[x, y, hi], [x + w, y, hi], [x + w, y + d, lo], [x, y + d, lo]];
  return (
    <g className="iso-table">
      <line className="iso-leg" x1={P(x + 4, y + d, 0)[0]} y1={P(x + 4, y + d, 0)[1]} x2={P(x + 4, y + d, lo)[0]} y2={P(x + 4, y + d, lo)[1]} />
      <line className="iso-leg" x1={P(x + w - 4, y + d, 0)[0]} y1={P(x + w - 4, y + d, 0)[1]} x2={P(x + w - 4, y + d, lo)[0]} y2={P(x + w - 4, y + d, lo)[1]} />
      <polygon className="iso-pv" points={pts(face)} />
      {[0.25, 0.5, 0.75].map((k) => {
        const a = P(x + w * k, y, hi);
        const b = P(x + w * k, y + d, lo);
        return <line key={k} className="iso-pv-grid" x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} />;
      })}
    </g>
  );
}

/** A lattice transmission tower with its cross-arm. */
function Tower({ x, y, h = 78 }) {
  const [bx1, by1] = P(x - 5, y, 0);
  const [bx2, by2] = P(x + 5, y, 0);
  const [tx, ty] = P(x, y, h);
  const [ax1, ay1] = P(x, y - 14, h - 10);
  const [ax2, ay2] = P(x, y + 14, h - 10);
  return (
    <g className="iso-tower">
      <line x1={bx1} y1={by1} x2={tx} y2={ty} />
      <line x1={bx2} y1={by2} x2={tx} y2={ty} />
      <line x1={(bx1 + tx) / 2} y1={(by1 + ty) / 2} x2={(bx2 + tx) / 2} y2={(by2 + ty) / 2} />
      <line x1={ax1} y1={ay1} x2={ax2} y2={ay2} />
    </g>
  );
}

/** A conductor sagging between two points (a quadratic curve). */
function Span({ a, b, sag = 12, className = "iso-wire" }) {
  const [x1, y1] = P(...a);
  const [x2, y2] = P(...b);
  return <path className={className} d={`M ${x1} ${y1} Q ${(x1 + x2) / 2} ${(y1 + y2) / 2 + sag} ${x2} ${y2}`} />;
}

/** A wind turbine: tower and three blades. */
function Turbine({ x, y }) {
  const [bx, by] = P(x, y, 0);
  const [hx, hy] = P(x, y, 92);
  const blade = (deg) => {
    const r = (deg * Math.PI) / 180;
    return <line key={deg} x1={hx} y1={hy} x2={hx + Math.cos(r) * 30} y2={hy + Math.sin(r) * 30} />;
  };
  return (
    <g className="iso-turbine">
      <line x1={bx} y1={by} x2={hx} y2={hy} className="iso-turbine-tower" />
      {[-90, 30, 150].map(blade)}
      <circle cx={hx} cy={hy} r="2.6" />
    </g>
  );
}

/** A label with a leader line to the part it names: title, then up to two lines. */
function Callout({ at, x, y, title, lines, tone = "", w = 214, anchor = "start" }) {
  const [ax, ay] = P(...at);
  const h = 22 + lines.length * 16;
  const left = anchor === "end" ? x - w : x;
  const ex = anchor === "end" ? x : x + (ax > x + w / 2 ? w : 0);
  return (
    <g className={`iso-callout ${tone}`}>
      <line className="iso-leader" x1={ax} y1={ay} x2={ex} y2={Math.min(Math.max(ay, y + 6), y + h - 6)} />
      <circle className="iso-dot" cx={ax} cy={ay} r="3.2" />
      <rect x={left} y={y} width={w} height={h} rx="4" />
      <text x={left + 10} y={y + 16} className="iso-callout-title">{title}</text>
      {lines.map((l, i) => <text key={i} x={left + 10} y={y + 33 + i * 16} className={`iso-callout-line ${l.tone || ""}`}>{l.text}</text>)}
    </g>
  );
}

/** The plant from the solar park to the 220 kV GSS, with where each loss is taken and where the units are billed. */
export function PlantIsometric({ sizes, sim }) {
  const ev = sim.evac;
  const genBus = sim.solarGenMWh + sim.windGenMWh;
  const solarCufBus = sizes.solarMw > 0 ? sim.solarGenMWh / (sizes.solarMw * E.HOURS) : 0;
  const hasWind = sizes.windMw > 0;
  const hasBess = sizes.bessMw > 0;
  const tables = [];
  for (let r = 0; r < 5; r += 1) for (let c = 0; c < 4; c += 1) tables.push({ x: 4 + c * 58, y: 8 + r * 34, w: 50, d: 16 });
  const inverters = [20, 80, 140]; // stations along the park's right edge
  const busZ = 32;
  const BUS = { x: 286, y: 186 }; // 33 kV main bus bar in the pooling substation
  const TR = { x: 344, y: 170 }; // 33/220 kV power transformer
  const towers = [[430, 110], [500, 40], [570, -30]];
  const GSS = { x: 640, y: -120 };
  return (
    <svg className="iso-svg" viewBox="0 0 1180 600" role="img" aria-label="The plant from the solar park through the inverters, the 33 kV bus, the power transformer and the 220 kV line to the billing meter at the GSS, with the losses at each stage" data-testid="rtc-isometric">
      {/* ground */}
      <Pad x={-8} y={0} w={252} d={184} className="iso-pad park" />
      <Pad x={270} y={150} w={120} d={100} className="iso-pad yard" />
      <Pad x={GSS.x - 10} y={GSS.y - 10} w={100} d={84} className="iso-pad yard gss" />
      {hasWind && <><Turbine x={-30} y={170} /><Turbine x={-50} y={230} /><Turbine x={0} y={262} /></>}
      {/* solar park */}
      {tables.map((t, i) => <Table key={i} {...t} />)}
      {/* DC strings to the inverter stations, then 33 kV cables to the bus */}
      {inverters.map((y) => <Span key={`dc${y}`} a={[236, y + 10, 4]} b={[250, y + 10, 4]} sag={2} className="iso-wire dc" />)}
      {inverters.map((y) => <Span key={`mv${y}`} a={[272, y + 12, 6]} b={[BUS.x + 20, BUS.y + 2, busZ]} sag={16} className="iso-wire mv" />)}
      {inverters.map((y) => (
        <g key={y}>
          <Box x={250} y={y} w={18} d={22} h={18} tone="inverter" />
          <Box x={270} y={y + 4} w={13} d={14} h={14} tone="idt" />
        </g>
      ))}
      {/* pooling substation: 33 kV main bus bar, the battery and the 33/220 kV power transformer */}
      {[0, 25, 50].map((dx) => <Box key={dx} x={BUS.x + dx} y={BUS.y} w={3} d={3} h={busZ} tone="post" />)}
      <Box x={BUS.x - 4} y={BUS.y + 1} w={62} d={4} h={3} z={busZ} tone="bus" />
      {hasBess && [0, 1, 2].map((i) => <Box key={i} x={282 + i * 32} y={222} w={26} d={16} h={16} tone="bess" />)}
      {hasBess && <Span a={[318, 222, 16]} b={[BUS.x + 30, BUS.y + 5, busZ]} sag={6} className="iso-wire mv" />}
      <Span a={[BUS.x + 58, BUS.y + 3, busZ]} b={[TR.x + 6, TR.y + 20, 30]} sag={4} className="iso-wire mv" />
      <Box x={TR.x} y={TR.y} w={30} d={30} h={30} tone="trafo" />
      {[0, 1, 2, 3].map((k) => <Box key={k} x={TR.x + 2 + k * 7} y={TR.y + 30} w={4} d={8} h={22} tone="fin" />)}
      <Box x={TR.x + 8} y={TR.y + 6} w={4} d={4} h={16} z={30} tone="bushing" />
      <Box x={TR.x + 20} y={TR.y + 6} w={4} d={4} h={16} z={30} tone="bushing" />
      {/* 220 kV line to the GSS */}
      {towers.map(([x, y]) => <Tower key={x} x={x} y={y} />)}
      <Span a={[TR.x + 22, TR.y + 8, 46]} b={[towers[0][0], towers[0][1], 68]} sag={4} />
      <Span a={[towers[0][0], towers[0][1], 68]} b={[towers[1][0], towers[1][1], 68]} sag={12} />
      <Span a={[towers[1][0], towers[1][1], 68]} b={[towers[2][0], towers[2][1], 68]} sag={12} />
      <Span a={[towers[2][0], towers[2][1], 68]} b={[GSS.x + 4, GSS.y + 30, 52]} sag={8} />
      {/* 220 kV GSS: gantry, bay and the billing meter */}
      <Box x={GSS.x} y={GSS.y + 6} w={4} d={4} h={56} tone="post" />
      <Box x={GSS.x} y={GSS.y + 52} w={4} d={4} h={56} tone="post" />
      <Box x={GSS.x} y={GSS.y + 6} w={4} d={50} h={4} z={52} tone="post" />
      <Box x={GSS.x + 22} y={GSS.y + 14} w={44} d={30} h={24} tone="gss" />
      <Box x={GSS.x + 44} y={GSS.y + 52} w={14} d={10} h={22} tone="meter" />
      {/* labels */}
      <Callout at={[116, 92, 12]} x={14} y={14} title={`Solar park · ${nf(sizes.solarMw)} MWac`} lines={[{ text: "Module, DC and soiling losses:" }, { text: "in your hourly file", tone: "muted" }]} />
      {hasWind && <Callout at={[-30, 170, 92]} x={14} y={300} title={`Wind · ${nf(sizes.windMw)} MW, same 33 kV bus`} lines={[{ text: `${nf(sim.windGenMWh / 1000, 1)} MU/yr at the bus` }]} w={236} />}
      <Callout at={[259, 91, 18]} x={14} y={430} title="Inverters + inverter-duty transformers" lines={[{ text: "Conversion and IDT losses:" }, { text: "in your hourly file", tone: "muted" }]} w={258} />
      <Callout at={[279, 140, 12]} x={14} y={520} title="33 kV collection cables" lines={[{ text: "Cable losses: in your hourly file", tone: "muted" }]} w={258} />
      <Callout at={[BUS.x + 26, BUS.y + 3, busZ + 3]} x={300} y={500} title="33 kV main bus bar · generation measured here" lines={[{ text: `${nf(genBus / 1000, 1)} MU/yr generated · solar CUF ${pf(solarCufBus, 2)}` }, { text: `${nf(ev.injectedMWh / 1000, 1)} MU/yr injected toward the GSS` }]} w={336} tone="bus" />
      {hasBess && <Callout at={[318, 238, 16]} x={300} y={430} title={`Battery · ${nf(sizes.bessMw)} MW / ${nf(sizes.bessMwh)} MWh at 33 kV`} lines={[{ text: `${nf(sim.dischargeMWh / 1000, 1)} MU/yr discharged to the bus` }]} w={300} />}
      <Callout at={[TR.x + 15, TR.y + 15, 30]} x={660} y={500} title="Power transformer 33/220 kV" lines={[{ text: `Loss ${pf(ev.trafoLossPct, 2)} · −${nf(ev.trafoLossMWh / 1000, 2)} MU/yr`, tone: "loss" }]} w={244} tone="loss" />
      <Callout at={[towers[1][0], towers[1][1], 60]} x={560} y={120} title="220 kV transmission line" lines={[{ text: `Loss ${pf(ev.lineLossPct, 2)} · −${nf(ev.lineLossMWh / 1000, 2)} MU/yr`, tone: "loss" }]} w={236} tone="loss" />
      <Callout at={[GSS.x + 51, GSS.y + 57, 22]} x={904} y={462} title="Billing meter · 220 kV GSS (POI)" lines={[{ text: `${nf(ev.meterMWh / 1000, 1)} MU/yr metered`, tone: "meter" }, { text: `${nf(sim.deliveredMWh / 1000, 1)} MU to the customer` }, { text: `DFR ${pf(sim.dfr, 2)} at the meter` }]} w={262} tone="meter" />
    </svg>
  );
}

/** Year 1 from the 33 kV bus to the billing meter, and what is billed there. */
export default function PlantToMeter({ sizes, sim, inputs, finance, fin }) {
  const ev = sim.evac;
  const genBus = sim.solarGenMWh + sim.windGenMWh;
  const lostRoundTrip = sim.chargeMWh - sim.dischargeMWh;
  const exportBus = ev.efficiency > 0 ? sim.excessMWh / ev.efficiency : 0;
  const y1 = finance.rows[0];
  const MU = (v) => nf(v / 1000, 2);
  const solarCufBus = sizes.solarMw > 0 ? sim.solarGenMWh / (sizes.solarMw * E.HOURS) : null;
  const rows = [
    ["Generated at the 33 kV main bus bar", genBus, "group"],
    ["solar", sim.solarGenMWh, "indent"],
    ["wind", sim.windGenMWh, "indent"],
    ["Into the battery", -sim.chargeMWh, "indent"],
    ["Back from the battery", sim.dischargeMWh, "indent"],
    ["Curtailed", -sim.curtailMWh, "indent"],
    ["Injected at the 33 kV bus toward the GSS", ev.injectedMWh, "total"],
    [`Power transformer 33/220 kV (${pf(ev.trafoLossPct, 2)})`, -ev.trafoLossMWh, "loss"],
    [`220 kV transmission line (${pf(ev.lineLossPct, 2)})`, -ev.lineLossMWh, "loss"],
    ["At the billing meter, 220 kV GSS", ev.meterMWh, "total meter"],
    ["delivered to the customer (DFR, tariff)", sim.deliveredMWh, "indent"],
    ["surplus sold", sim.excessMWh, "indent"],
  ];
  return (
    <Section index="P" title="From the plant to the billing meter" note="Your hourly generation is at the 33 kV main bus bar; the customer is billed at the 220 kV GSS">
      <div className="rtc-stats flush-top" data-testid="rtc-meter-stats">
        <Stat label="Billing metering point" value="220 kV GSS" detail="interface meters (main and check) at the point of interconnection" />
        <Stat label="Reaches the meter" value={pf(ev.efficiency, 3)} detail={`of each MWh injected at 33 kV: −${pf(ev.trafoLossPct, 2)} transformer, −${pf(ev.lineLossPct, 2)} line`} />
        <Stat label="Lost on the way · year 1" value={`${MU(ev.trafoLossMWh + ev.lineLossMWh)} MU`} detail={`₹${nf(((ev.trafoLossMWh + ev.lineLossMWh) * finance.tariff) / 1e4, 2)} cr of revenue at ₹${nf(finance.tariff, 3)}/kWh`} />
        <Stat label="Solar CUF" value={solarCufBus === null ? "–" : pf(solarCufBus * ev.efficiency, 2)} detail={solarCufBus === null ? "no solar" : `at the 220 kV meter; ${pf(solarCufBus, 2)} at the 33 kV bus`} />
        <Stat label="DFR at the meter" value={pf(sim.dfr, 2)} detail={`${nf(sim.deliveredMWh / 1000, 1)} of ${nf(sim.demandMWh / 1000, 1)} MU · target ${pf(inputs.dfrTarget, 0)}`} tone={sim.dfr >= inputs.dfrTarget - 1e-6 ? "good" : "bad"} />
      </div>
      <div className="rtc-card iso-card">
        <PlantIsometric sizes={sizes} sim={sim} />
      </div>
      <div className="rtc-grid rtc-grid-2 meter-grid">
        <div className="table-wrap" data-testid="rtc-meter-ladder">
          <table>
            <thead><tr><th>Year 1, 33 kV bus → 220 kV meter</th><th className="num">MU</th></tr></thead>
            <tbody>
              {rows.map(([label, v, kind]) => (
                <tr key={label} className={kind.includes("total") ? "rtc-model-total" : kind === "group" ? "rtc-model-group-row" : ""}>
                  <td className={kind === "indent" ? "rtc-indent" : kind === "loss" ? "rtc-indent rtc-loss" : ""}>{label}</td>
                  <td className={`rtc-num ${kind === "loss" ? "rtc-loss" : ""}`}>{v < 0 ? `(${MU(-v)})` : MU(v)}</td>
                </tr>
              ))}
              <tr><td className="rtc-indent rtc-muted">battery round-trip loss (in “into” − “back”)</td><td className="rtc-num rtc-muted">{MU(lostRoundTrip)}</td></tr>
              <tr><td className="rtc-indent rtc-muted">surplus at the bus before losses</td><td className="rtc-num rtc-muted">{MU(exportBus)}</td></tr>
            </tbody>
          </table>
        </div>
        <div className="meter-notes">
          <div className="meter-def">
            <Gauge size={16} />
            <div>
              <strong>Billing metering point</strong>
              <p>The interface meters (main and check) at the 220 kV bay of the GSS, the point of interconnection. The customer's bill, the DFR, the plant capacity limit and surplus sales are all on the units these meters record. The units generated are measured at the plant's 33 kV main bus bar (your hourly file).</p>
            </div>
          </div>
          <div className="meter-def">
            <div>
              <strong>What the losses cost</strong>
              <p>
                Year 1: the meter records {MU(ev.meterMWh)} MU of the {MU(ev.injectedMWh)} MU injected at 33 kV. At ₹{nf(finance.tariff, 3)}/kWh the {MU(ev.trafoLossMWh + ev.lineLossMWh)} MU lost is ₹{nf(((ev.trafoLossMWh + ev.lineLossMWh) * finance.tariff) / 1e4, 2)} crore a year.
                The optimizer sizes the plant for the DFR at the meter, so it builds enough to cover these losses; every year of the financial model bills only the metered units (revenue {y1 ? `₹${nf(y1.energyRevenue, 1)} cr in year 1` : ""}).
                {fin.sellSurplus ? " Surplus is sold on the metered units too." : ""}
              </p>
            </div>
          </div>
        </div>
      </div>
    </Section>
  );
}
