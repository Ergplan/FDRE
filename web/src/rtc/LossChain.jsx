import React from "react";
import { MapPin } from "lucide-react";
import * as E from "./engine";
import { NumberInput, nf, pf } from "./ui";
import { BatteryIcon, BusIcon, CableIcon, DcIcon, InverterIcon, LineIcon, MeterIcon, PcsIcon, PvIcon, TransformerIcon, TurbineIcon } from "./isoIcons";

// A technology's path from its source to the billing meter, drawn top to bottom: every part with
// its loss slider, the points where a profile can be measured (the stages above that point are
// already in the profile; the ones below are applied), the shared 33/220 kV power transformer and
// 220 kV line, and the 220 kV GSS billing meter. Energies are year 1, before curtailment.

const SOURCE = {
  solar: { icon: PvIcon, title: "Solar PV modules", wire: "dc" },
  wind: { icon: TurbineIcon, title: "Wind turbines (WTG)", wire: "lv" },
  bess: { icon: BatteryIcon, title: "Battery containers", wire: "dc" },
};
const STAGE_ICON = {
  solar: { dc: DcIcon, inverter: InverterIcon, idt: () => <TransformerIcon />, cable: CableIcon },
  wind: { wtgTrafo: () => <TransformerIcon tone="idt" />, cable: CableIcon },
  bess: { pcs: PcsIcon, mvTrafo: () => <TransformerIcon />, cable: CableIcon },
};
// the wire after each stage: dc, lv (low-voltage AC), mv (33 kV), hv (220 kV)
const WIRE_AFTER = {
  solar: { dc: "dc", inverter: "lv", idt: "mv", cable: "mv" },
  wind: { wtgTrafo: "mv", cable: "mv" },
  bess: { pcs: "lv", mvTrafo: "mv", cable: "mv" },
};
// the measuring points: before the first stage, then after each stage (the last is the 33 kV bus)
const POINTS = {
  solar: ["Module output (DC)", "DC at the inverters", "Inverter output (LV AC)", "Inverter station output (33 kV)", "33 kV main bus bar"],
  wind: ["WTG terminals (0.69 kV)", "WTG transformer output (33 kV)", "33 kV main bus bar"],
  bess: ["Battery DC terminals", "PCS output (LV AC)", "MV transformer output (33 kV)", "33 kV main bus bar"],
};

function LossSlider({ value, max, onChange, disabled, testid }) {
  return (
    <div className={`loss-slider ${disabled ? "is-off" : ""}`} data-testid={testid}>
      <input type="range" min={0} max={max} step={0.0005} value={value || 0} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} aria-label="Loss" />
      <NumberInput value={value || 0} onCommit={onChange} scale={100} digits={2} step={0.05} min={0} max={max * 100} disabled={disabled} />
      <em>%</em>
    </div>
  );
}

function Row({ icon: Icon, wire, wireIn, title, detail, children, side, dim = false, kind = "", testid }) {
  return (
    <div className={`loss-row ${kind} ${dim ? "is-dim" : ""}`} style={{ "--wire-in": `var(--wire-${wireIn || wire})`, "--wire-out": `var(--wire-${wire})` }} data-testid={testid}>
      <div className="loss-icon"><Icon /></div>
      <div className="loss-body">
        <strong>{title}</strong>
        {detail && <small>{detail}</small>}
        {children}
      </div>
      <div className="loss-side">{side}</div>
    </div>
  );
}

function Point({ label, wire, checked, onPick, note, kind }) {
  return (
    <div className={`loss-point ${checked ? "is-on" : ""}`} style={{ "--wire-in": `var(--wire-${wire})`, "--wire-out": `var(--wire-${wire})` }}>
      <div className="loss-point-dot"><i /></div>
      <label className="loss-point-label">
        <input type="radio" checked={checked} onChange={onPick} name={`${kind}-point`} />
        <span>{label}</span>
        {checked && <b><MapPin size={12} /> {kind === "bess" ? "your round-trip efficiency is quoted here" : "your hourly file is measured here"}</b>}
      </label>
      <div className="loss-point-note">{note}</div>
    </div>
  );
}

const MU = (mwh) => `${nf(mwh / 1000, 2)} MU/yr`;

/** The loss chain of one technology, with its sliders, wired to the Round the clock inputs. */
export default function LossChain({ kind, state, patch, sizes, sim, cf }) {
  const inputs = state.inputs;
  const stages = E.LOSS_STAGES[kind];
  const n = stages.length;
  const lossKey = `${kind}Loss`;
  const atKey = kind === "bess" ? "bessRteAt" : `${kind}FileAt`;
  const losses = inputs[lossKey] || {};
  const at = inputs[atKey] ?? n;
  const setLoss = (k, v) => patch("inputs", { [lossKey]: { ...losses, [k]: v } });
  const setAt = (i) => patch("inputs", { [atKey]: i });
  const trafo = inputs.trafoLossPct || 0;
  const line = inputs.lineLossPct || 0;
  const aux = inputs.lossPct || 0;
  const src = SOURCE[kind];
  const mw = kind === "solar" ? sizes.solarMw : kind === "wind" ? sizes.windMw : sizes.bessMw;
  const cuf = (mwh) => (mw > 0 ? pf(mwh / (mw * E.HOURS), 2) : "–");

  // energy (solar, wind) or round-trip efficiency (battery) along the chain, from the measuring point down
  const isBess = kind === "bess";
  const rte = state.bess.rte;
  const start = isBess ? rte : mw * E.HOURS * E.mean(cf);
  const after = []; // value after each stage, or null above the measuring point
  let v = start;
  for (let i = 0; i < n; i += 1) {
    if (i < at) { after.push(null); continue; }
    const l = losses[stages[i].key] || 0;
    v *= isBess ? (1 - l) ** 2 : 1 - l;
    after.push(v);
  }
  const atBus = isBess ? v : v * (1 - aux);
  const dis = sim.dischargeMWh; // the battery's discharge at the bus, year 1
  const busEnergy = isBess ? dis : atBus;
  const afterTrafo = busEnergy * (1 - trafo);
  const atMeter = afterTrafo * (1 - line);
  const value = (x) => (isBess ? `round trip ${pf(x, 2)}` : `${MU(x)} · CUF ${cuf(x)}`);
  const pointNote = (i) => {
    if (i < at) return null;
    if (i === at) return value(start);
    return value(after[i - 1]);
  };
  const titleOf = (i) => (isBess && i === 0 ? "Battery DC terminals" : POINTS[kind][i]);

  return (
    <div className={`loss-chain ${kind}`} data-testid={`loss-chain-${kind}`}>
      <Row icon={src.icon} wire={src.wire} title={src.title} kind="source"
        detail={kind === "solar" ? `${nf(mw)} MWac · DC/AC ${nf(inputs.solarDcAc, 2)}` : kind === "wind" ? `${nf(mw)} MW` : `${nf(sizes.bessMw)} MW / ${nf(sizes.bessMwh)} MWh · round trip ${pf(rte, 1)} as you entered it`}
        side={null} />
      {stages.map((st, i) => {
        const inFile = i < at;
        const Icon = STAGE_ICON[kind][st.key];
        const prev = i === at ? start : after[i - 1];
        const lost = !inFile && prev !== null ? (isBess ? null : prev * (losses[st.key] || 0)) : null;
        return (
          <React.Fragment key={st.key}>
            <Point kind={kind} label={titleOf(i)} wire={i === 0 ? src.wire : WIRE_AFTER[kind][stages[i - 1].key]} checked={at === i} onPick={() => setAt(i)} note={pointNote(i)} />
            <Row icon={Icon} wire={WIRE_AFTER[kind][st.key]} wireIn={i === 0 ? src.wire : WIRE_AFTER[kind][stages[i - 1].key]} title={st.label} detail={st.detail} dim={inFile} testid={`loss-${kind}-${st.key}`}
              side={inFile ? <span className="loss-muted">already in your {isBess ? "round-trip efficiency" : "hourly file"}</span> : lost !== null ? <span className="loss-mu">−{MU(lost)}</span> : <span className="loss-mu">−{pf(1 - (1 - (losses[st.key] || 0)) ** 2, 2)} of the round trip</span>}>
              <LossSlider value={losses[st.key] || 0} max={st.max} onChange={(x) => setLoss(st.key, x)} disabled={inFile} testid={`slider-${kind}-${st.key}`} />
            </Row>
          </React.Fragment>
        );
      })}
      <Point kind={kind} label={POINTS[kind][n]} wire="mv" checked={at === n} onPick={() => setAt(n)} note={pointNote(n)} />
      <Row icon={BusIcon} wire="mv" title="33 kV main bus bar" kind="bus"
        detail={isBess
          ? `The battery charges from and discharges to the bus: round trip ${pf(atBus, 2)} seen from here (used in the dispatch)`
          : `Generation is counted here${aux > 0 ? ` (after ${pf(aux, 2)} other losses, Energy needed chapter)` : ""}: CUF ${cuf(atBus)}`}
        side={<span className="loss-value">{isBess ? `${MU(dis)} discharged` : MU(atBus)}</span>} />
      <Row icon={() => <TransformerIcon big />} wire="hv" wireIn="mv" title="Power transformer 33/220 kV" detail="Shared by solar, wind and the battery" testid={`loss-${kind}-trafo`}
        side={<span className="loss-mu">−{MU(busEnergy * trafo)}</span>}>
        <LossSlider value={trafo} max={0.03} onChange={(x) => patch("inputs", { trafoLossPct: x })} testid={`slider-${kind}-trafo`} />
      </Row>
      <Row icon={LineIcon} wire="hv" title="220 kV transmission line" detail="To the GSS; shared by solar, wind and the battery" testid={`loss-${kind}-line`}
        side={<span className="loss-mu">−{MU(afterTrafo * line)}</span>}>
        <LossSlider value={line} max={0.05} onChange={(x) => patch("inputs", { lineLossPct: x })} testid={`slider-${kind}-line`} />
      </Row>
      <Row icon={MeterIcon} wire="hv" title="220 kV GSS · billing meter" kind="meter"
        detail={isBess ? "Battery energy billed here (part of the DFR)" : `Billed here: CUF ${cuf(atMeter)} at the meter`}
        side={<span className="loss-value meter">{isBess ? `${MU(atMeter)} billed` : MU(atMeter)}</span>} />
      <p className="rtc-note loss-foot">
        {isBess
          ? "The battery's round trip as seen from the 33 kV bus drives the dispatch; what it discharges then loses the power transformer and line losses on the way to the meter."
          : `Year-1 ${kind} output at each point, before curtailment and the battery; the dispatch then decides what is sent to the meter (From the plant to the billing meter, below the answer).`}
        {" "}Pick the point where your {isBess ? "round-trip efficiency is quoted" : "hourly file is measured"}: the stages above it are already in it and are not applied again.
      </p>
    </div>
  );
}
