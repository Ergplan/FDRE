import React from "react";

// Small isometric drawings of the plant's parts, one per stage of a loss chain (LossChain.jsx).
// Each is its own 160 x 104 SVG with the same projection: x to the lower right, y to the lower
// left, z up, centred on the icon. Colours come from meter.css (.iso-*).

const C = Math.cos(Math.PI / 6);
const OX = 80;
const OY = 46;
const P = (x, y, z = 0) => [OX + (x - y) * C, OY + (x + y) * 0.5 - z];
const pts = (list) => list.map(([x, y, z]) => P(x, y, z).join(",")).join(" ");
const line = (a, b, cls) => {
  const [x1, y1] = P(...a);
  const [x2, y2] = P(...b);
  return <line className={cls} x1={x1} y1={y1} x2={x2} y2={y2} />;
};

function Box({ x, y, z = 0, w, d, h, tone }) {
  const top = [[x, y, z + h], [x + w, y, z + h], [x + w, y + d, z + h], [x, y + d, z + h]];
  const right = [[x + w, y, z], [x + w, y + d, z], [x + w, y + d, z + h], [x + w, y, z + h]];
  const front = [[x, y + d, z], [x + w, y + d, z], [x + w, y + d, z + h], [x, y + d, z + h]];
  return (
    <g className={`iso-box iso-${tone}`}>
      <polygon className="f-right" points={pts(right)} />
      <polygon className="f-front" points={pts(front)} />
      <polygon className="f-top" points={pts(top)} />
    </g>
  );
}

function Pad({ x, y, w, d, cls = "iso-pad" }) {
  return <polygon className={cls} points={pts([[x, y, 0], [x + w, y, 0], [x + w, y + d, 0], [x, y + d, 0]])} />;
}

function Table({ x, y, w, d }) {
  const face = [[x, y, 14], [x + w, y, 14], [x + w, y + d, 5], [x, y + d, 5]];
  return (
    <g>
      {line([x + 3, y + d, 0], [x + 3, y + d, 5], "iso-leg")}
      {line([x + w - 3, y + d, 0], [x + w - 3, y + d, 5], "iso-leg")}
      <polygon className="iso-pv" points={pts(face)} />
      {[0.33, 0.66].map((k) => <React.Fragment key={k}>{line([x + w * k, y, 14], [x + w * k, y + d, 5], "iso-pv-grid")}</React.Fragment>)}
    </g>
  );
}

const Svg = ({ children, label }) => (
  <svg className="iso-icon" viewBox="0 0 160 104" role="img" aria-label={label}>{children}</svg>
);

export const PvIcon = () => (
  <Svg label="Solar PV modules">
    <Pad x={-44} y={-30} w={88} d={70} cls="iso-pad park" />
    {[[-40, -26], [-2, -26], [-40, 4], [-2, 4]].map(([x, y]) => <Table key={`${x}${y}`} x={x} y={y} w={34} d={14} />)}
  </Svg>
);

export const InverterIcon = () => (
  <Svg label="Inverter station">
    <Pad x={-26} y={-20} w={52} d={40} />
    <Box x={-16} y={-12} w={20} d={22} h={24} tone="inverter" />
    <Box x={8} y={-8} w={12} d={14} h={14} tone="steel" />
  </Svg>
);

export function TransformerIcon({ big = false, tone = "idt" }) {
  const s = big ? 1.35 : 1;
  return (
    <Svg label={big ? "Power transformer" : "Transformer"}>
      <Pad x={-30 * s} y={-24 * s} w={60 * s} d={48 * s} />
      <Box x={-14 * s} y={-14 * s} w={24 * s} d={24 * s} h={22 * s} tone={big ? "trafo" : tone} />
      {[0, 1, 2].map((k) => <Box key={k} x={-12 * s + k * 8 * s} y={10 * s} w={4 * s} d={6 * s} h={16 * s} tone={big ? "fin" : "steel"} />)}
      {[0, 1, 2].map((k) => <Box key={`b${k}`} x={-10 * s + k * 7 * s} y={-8 * s} z={22 * s} w={3 * s} d={3 * s} h={10 * s} tone="bushing" />)}
    </Svg>
  );
}

export const CableIcon = () => (
  <Svg label="33 kV collection cables">
    <Pad x={-50} y={-6} w={100} d={14} />
    {[-3, 0, 3].map((k) => <React.Fragment key={k}>{line([-48, k + 1, 1], [48, k + 1, 1], "iso-wire mv")}</React.Fragment>)}
    <Box x={-6} y={-8} w={10} d={18} h={8} tone="steel" />
  </Svg>
);

export const BusIcon = () => (
  <Svg label="33 kV main bus bar">
    <Pad x={-44} y={-18} w={88} d={36} cls="iso-pad yard" />
    {[-36, -12, 12, 34].map((x) => <Box key={x} x={x} y={-2} w={3} d={3} h={28} tone="post" />)}
    <Box x={-40} y={-1} w={80} d={4} h={3} z={28} tone="bus" />
  </Svg>
);

export const LineIcon = () => {
  const tower = (x, y) => {
    const [bx1, by1] = P(x - 5, y, 0);
    const [bx2, by2] = P(x + 5, y, 0);
    const [tx, ty] = P(x, y, 56);
    const [ax1, ay1] = P(x, y - 12, 48);
    const [ax2, ay2] = P(x, y + 12, 48);
    return (
      <g className="iso-tower" key={`${x}${y}`}>
        <line x1={bx1} y1={by1} x2={tx} y2={ty} />
        <line x1={bx2} y1={by2} x2={tx} y2={ty} />
        <line x1={(bx1 + tx) / 2} y1={(by1 + ty) / 2} x2={(bx2 + tx) / 2} y2={(by2 + ty) / 2} />
        <line x1={ax1} y1={ay1} x2={ax2} y2={ay2} />
      </g>
    );
  };
  const [x1, y1] = P(-34, 30, 50);
  const [x2, y2] = P(34, -30, 50);
  return (
    <Svg label="220 kV transmission line">
      {tower(-34, 30)}
      {tower(34, -30)}
      <path className="iso-wire" d={`M ${x1} ${y1} Q ${(x1 + x2) / 2} ${(y1 + y2) / 2 + 10} ${x2} ${y2}`} />
      <path className="iso-wire" d={`M ${x1 - 9} ${y1 + 5} Q ${(x1 + x2) / 2 - 9} ${(y1 + y2) / 2 + 15} ${x2 - 9} ${y2 + 5}`} />
    </Svg>
  );
};

export const MeterIcon = () => (
  <Svg label="220 kV GSS and the billing meter">
    <Pad x={-40} y={-28} w={80} d={60} cls="iso-pad yard gss" />
    <Box x={-34} y={-22} w={3} d={3} h={44} tone="post" />
    <Box x={-34} y={14} w={3} d={3} h={44} tone="post" />
    <Box x={-34} y={-22} w={3} d={39} h={3} z={41} tone="post" />
    <Box x={-12} y={-16} w={30} d={22} h={18} tone="gss" />
    <Box x={8} y={12} w={10} d={8} h={18} tone="meter" />
  </Svg>
);

export const TurbineIcon = () => {
  // drawn upright (no projection) so the rotor fits: tower from the pad to the hub, three blades
  const hub = [80, 30];
  const blade = (deg) => {
    const r = (deg * Math.PI) / 180;
    return <line key={deg} x1={hub[0]} y1={hub[1]} x2={hub[0] + Math.cos(r) * 27} y2={hub[1] + Math.sin(r) * 27} />;
  };
  return (
    <Svg label="Wind turbine">
      <polygon className="iso-pad" points="80,88 104,96 80,104 56,96" />
      <g className="iso-turbine">
        <line x1="80" y1="96" x2={hub[0]} y2={hub[1]} className="iso-turbine-tower" />
        {[-70, 50, 170].map(blade)}
        <rect x="74" y="26" width="14" height="7" rx="2" className="iso-nacelle" />
        <circle cx={hub[0]} cy={hub[1]} r="3" />
      </g>
    </Svg>
  );
};

export const BatteryIcon = () => (
  <Svg label="Battery containers">
    <Pad x={-44} y={-26} w={88} d={56} />
    <Box x={-38} y={-18} w={34} d={16} h={16} tone="bess" />
    <Box x={0} y={-18} w={34} d={16} h={16} tone="bess" />
    <Box x={-38} y={6} w={34} d={16} h={16} tone="bess" />
  </Svg>
);

export const PcsIcon = () => (
  <Svg label="Power conversion system">
    <Pad x={-26} y={-20} w={52} d={40} />
    <Box x={-16} y={-12} w={28} d={20} h={20} tone="inverter" />
    <Box x={-16} y={-12} w={28} d={3} h={20} z={0} tone="bess" />
  </Svg>
);

export const DcIcon = () => (
  <Svg label="DC cables and combiner boxes">
    <Pad x={-44} y={-16} w={88} d={32} />
    {[-2, 2].map((k) => <React.Fragment key={k}>{line([-42, k, 1], [42, k, 1], "iso-wire dc")}</React.Fragment>)}
    <Box x={-30} y={-8} w={10} d={8} h={12} tone="steel" />
    <Box x={12} y={-8} w={10} d={8} h={12} tone="steel" />
  </Svg>
);
