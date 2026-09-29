import React, { useEffect, useRef, useState } from "react";
import { SkipForward, X } from "lucide-react";

// Optimizer "theatre": while the worker searches, an isometric 3D cost surface
// (levelised ₹/kWh over solar MW × wind MW, best storage at each point) is built cell by cell,
// the least-cost point is marked, and then the overlay hands over to the result.
//
// `feed` is a ref filled by the parent from worker messages:
//   { axes: { solarGrid, windGrid, total }, cells: [...], done: bool, result, error }

const VIRIDIS = ["#440154", "#482878", "#3e4989", "#31688e", "#26828e", "#1f9e89", "#35b779", "#6ece58", "#b5de2b", "#fde725"];
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const STOPS = VIRIDIS.map(hex);

function viridis(t, alpha = 1) {
  const x = Math.max(0, Math.min(1, t)) * (STOPS.length - 1);
  const i = Math.min(STOPS.length - 2, Math.floor(x));
  const f = x - i;
  const c = STOPS[i].map((v, k) => Math.round(v + (STOPS[i + 1][k] - v) * f));
  return `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;
}

const BUILD_MS = 6200; // surface build pacing
const MIN_MS = 7000; // the curve is on screen at least this long before the answer
const FOUND_MS = 2000; // hold on the marked minimum
const FADE_MS = 550;

const nf = (v, d = 0) => new Intl.NumberFormat("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d }).format(v);

function positions(n) {
  // a locked axis (one grid point) is drawn as a thin ribbon so the surface stays visible
  if (n <= 1) return [0.4, 0.6];
  return Array.from({ length: n }, (_, i) => i / (n - 1));
}

export default function OptimizerTheatre({ feed, onFinish, onCancel }) {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const [status, setStatus] = useState({ shown: 0, total: 0, phase: "build", evals: 0 });
  const finishRef = useRef(onFinish);
  finishRef.current = onFinish;
  const skipRef = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx2d = canvas.getContext("2d");
    const reduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const minMs = reduced ? 1200 : MIN_MS;
    const buildMs = reduced ? 800 : BUILD_MS;
    const start = performance.now();
    let raf = 0;
    let foundAt = null;
    let finished = false;
    let zLo = null;
    let zHi = null;
    let lastStatus = 0;
    const flashes = new Map();

    const resize = () => {
      const w = wrapRef.current.clientWidth;
      const h = Math.max(360, Math.min(600, Math.round(w * 0.58)));
      const dpr = window.devicePixelRatio || 1;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);

    const frame = (now) => {
      const f = feed.current;
      const elapsed = now - start;
      const W = canvas.clientWidth;
      const H = canvas.clientHeight;
      ctx2d.clearRect(0, 0, W, H);
      const axes = f.axes;
      if (!axes) {
        drawWaiting(ctx2d, W, H, elapsed);
        raf = requestAnimationFrame(frame);
        return;
      }
      const nS = axes.solarGrid.length;
      const nW = axes.windGrid.length;
      const total = nS * nW;
      const paced = skipRef.current ? total : Math.floor(total * Math.min(1, Math.max(0, (elapsed - 500) / buildMs)));
      const shown = Math.min(f.cells.length, paced);

      // value grid (null until revealed)
      const V = Array.from({ length: nS }, () => new Array(nW).fill(null));
      let fMin = Infinity;
      let fMax = -Infinity;
      let anyMax = -Infinity;
      for (let k = 0; k < shown; k += 1) {
        const c = f.cells[k];
        V[c.si][c.wi] = c;
        if (Number.isFinite(c.lcoe)) {
          anyMax = Math.max(anyMax, c.lcoe);
          if (c.feasible) { fMin = Math.min(fMin, c.lcoe); fMax = Math.max(fMax, c.lcoe); }
        }
        if (!flashes.has(k)) flashes.set(k, now);
      }
      // designs that miss the DFR target sit on a plateau above the most expensive feasible one
      const targetLo = Number.isFinite(fMin) ? fMin : Number.isFinite(anyMax) ? anyMax * 0.9 : 4;
      const targetHi = Number.isFinite(fMax) ? Math.max(fMax * 1.06, targetLo + 0.2) : targetLo + 1;
      zLo = zLo === null ? targetLo : zLo + (targetLo - zLo) * 0.12;
      zHi = zHi === null ? targetHi : zHi + (targetHi - zHi) * 0.12;
      const zOf = (c) => (c.feasible && Number.isFinite(c.lcoe) ? c.lcoe : zHi);
      const hOf = (z) => Math.max(0, Math.min(1, (z - zLo) / Math.max(1e-6, zHi - zLo)));

      // camera: slow sway around the vertical axis
      const t = elapsed / 1000;
      const az = reduced ? -0.72 : -0.72 + Math.sin(t * 0.35) * 0.22 + (foundAt ? 0 : 0);
      const el = 0.52;
      const R = Math.min(W * 0.36, H * 0.72);
      const cx = W * 0.44;
      const cy = H * 0.58;
      const Hz = H * 0.42;
      const proj = (u, v, h) => {
        const x = u - 0.5;
        const y = v - 0.5;
        const xr = x * Math.cos(az) - y * Math.sin(az);
        const yr = x * Math.sin(az) + y * Math.cos(az);
        return [cx + xr * R * 1.25, cy + yr * R * Math.sin(el) - h * Hz, yr];
      };
      const uPos = positions(nS);
      const vPos = positions(nW);
      const di = (i) => (nS <= 1 ? 0 : i);
      const dj = (j) => (nW <= 1 ? 0 : j);

      drawBox(ctx2d, proj, axes, zLo, zHi, W, H);

      // surface quads, far to near
      const quads = [];
      for (let i = 0; i < uPos.length - 1; i += 1) {
        for (let j = 0; j < vPos.length - 1; j += 1) {
          const cs = [V[di(i)][dj(j)], V[di(i + 1)][dj(j)], V[di(i + 1)][dj(j + 1)], V[di(i)][dj(j + 1)]];
          if (cs.some((c) => !c)) continue;
          const pts = [[uPos[i], vPos[j]], [uPos[i + 1], vPos[j]], [uPos[i + 1], vPos[j + 1]], [uPos[i], vPos[j + 1]]].map(([u, v], k) => proj(u, v, hOf(zOf(cs[k]))));
          const depth = pts.reduce((s, p) => s + p[2], 0) / 4;
          const zAvg = cs.reduce((s, c) => s + zOf(c), 0) / 4;
          const bad = cs.filter((c) => !c.feasible).length >= 2;
          quads.push({ pts, depth, zAvg, bad });
        }
      }
      quads.sort((a, b) => a.depth - b.depth);
      for (const q of quads) {
        ctx2d.beginPath();
        q.pts.forEach(([x, y], k) => (k ? ctx2d.lineTo(x, y) : ctx2d.moveTo(x, y)));
        ctx2d.closePath();
        ctx2d.fillStyle = q.bad ? "rgba(255,107,95,0.22)" : viridis(hOf(q.zAvg), 0.94);
        ctx2d.fill();
        ctx2d.strokeStyle = q.bad ? "rgba(255,107,95,0.45)" : "rgba(10,10,10,0.35)";
        ctx2d.lineWidth = 0.6;
        ctx2d.stroke();
      }

      // freshly computed points flash
      for (let k = Math.max(0, shown - 24); k < shown; k += 1) {
        const c = f.cells[k];
        const age = now - (flashes.get(k) || now);
        if (age > 700) continue;
        const [x, y] = proj(uPos[Math.min(c.si, uPos.length - 1)], vPos[Math.min(c.wi, vPos.length - 1)], hOf(zOf(c)));
        ctx2d.beginPath();
        ctx2d.arc(x, y, 2 + (age / 700) * 6, 0, Math.PI * 2);
        ctx2d.strokeStyle = `rgba(212,255,63,${1 - age / 700})`;
        ctx2d.lineWidth = 1.2;
        ctx2d.stroke();
      }

      drawColorbar(ctx2d, W, H, zLo, zHi);

      // phase control
      const built = shown >= total && f.cells.length >= total;
      if (!foundAt && f.done && f.result && built && (elapsed >= minMs || skipRef.current)) foundAt = now;
      if (foundAt) {
        const k = now - foundAt;
        const best = f.result.best;
        const sMin = axes.solarGrid[0];
        const sMax = axes.solarGrid[nS - 1];
        const wMin = axes.windGrid[0];
        const wMax = axes.windGrid[nW - 1];
        const u = nS <= 1 ? 0.5 : (best.sizes.solarMw - sMin) / Math.max(1e-9, sMax - sMin);
        const v = nW <= 1 ? 0.5 : (best.sizes.windMw - wMin) / Math.max(1e-9, wMax - wMin);
        drawFound(ctx2d, proj, u, v, hOf(best.lcoe), best, Math.min(1, k / 600), now);
        if (!finished && k > (skipRef.current ? 700 : FOUND_MS) + FADE_MS) {
          finished = true;
          finishRef.current?.();
        }
        canvas.style.opacity = String(k > (skipRef.current ? 700 : FOUND_MS) ? Math.max(0, 1 - (k - (skipRef.current ? 700 : FOUND_MS)) / FADE_MS) : 1);
      }
      if (f.error && !finished) {
        finished = true;
        finishRef.current?.();
      }

      if (now - lastStatus > 100) {
        lastStatus = now;
        setStatus({ shown, total, phase: foundAt ? "found" : built && !f.done ? "refine" : f.done && built ? "confirm" : "build", evals: f.progress?.evals || 0 });
      }
      if (!finished) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, [feed]);

  const pct = status.total ? Math.round((status.shown / status.total) * 100) : 0;
  const steps = [
    ["Loaded 8,760-hour demand, solar and wind profiles", true],
    [`Building the cost surface · ${status.shown}/${status.total || "…"} solar × wind mixes`, status.shown > 0],
    ["Bisecting battery energy for the cheapest feasible storage at every mix", status.shown > 0],
    ["Refining around the minimum with a pattern search", status.phase !== "build"],
    ["Least-cost design found", status.phase === "found"],
  ];

  return (
    <div className="theatre" role="dialog" aria-modal="true" aria-label="Optimizing">
      <div className="theatre-inner">
        <header className="theatre-head">
          <div>
            <span className="theatre-brand"><img src="/brand/joulewise-logo-dark.png" alt="Joulewise" /></span>
            <span className="rtc-index">OPTIMIZING</span>
            <h2>Searching for the least-cost mix</h2>
          </div>
          <div className="theatre-actions">
            <button type="button" className="rtc-reset" onClick={() => { skipRef.current = true; }}><SkipForward size={13} /> Skip animation</button>
            {onCancel && <button type="button" className="rtc-reset" onClick={onCancel}><X size={13} /> Cancel</button>}
          </div>
        </header>
        <div className="theatre-stage" ref={wrapRef}>
          <canvas ref={canvasRef} />
        </div>
        <div className="theatre-foot">
          <ol className="theatre-log">
            {steps.map(([text, on], i) => <li key={i} className={on ? "on" : ""}>{text}</li>)}
          </ol>
          <div className="theatre-bar"><i style={{ width: `${status.phase === "found" ? 100 : Math.min(96, pct)}%` }} /></div>
        </div>
      </div>
    </div>
  );
}

function drawWaiting(g, W, H, elapsed) {
  g.fillStyle = "#86867f";
  g.font = "500 11px 'JetBrains Mono', monospace";
  g.textAlign = "center";
  g.fillText("PREPARING PROFILES" + ".".repeat(1 + (Math.floor(elapsed / 300) % 3)), W / 2, H / 2);
}

function drawBox(g, proj, axes, zLo, zHi) {
  g.save();
  g.lineWidth = 1;
  // floor grid
  g.strokeStyle = "rgba(255,255,255,0.07)";
  for (let k = 0; k <= 5; k += 1) {
    const a = k / 5;
    line(g, proj(a, 0, 0), proj(a, 1, 0));
    line(g, proj(0, a, 0), proj(1, a, 0));
  }
  // back walls: the two walls whose floor edge is farthest from the viewer
  const edgeDepth = (u0, v0, u1, v1) => (proj(u0, v0, 0)[2] + proj(u1, v1, 0)[2]) / 2;
  const walls = [
    { e: [0, 0, 1, 0], d: edgeDepth(0, 0, 1, 0) },
    { e: [1, 0, 1, 1], d: edgeDepth(1, 0, 1, 1) },
    { e: [1, 1, 0, 1], d: edgeDepth(1, 1, 0, 1) },
    { e: [0, 1, 0, 0], d: edgeDepth(0, 1, 0, 0) },
  ].sort((a, b) => a.d - b.d).slice(0, 2);
  g.strokeStyle = "rgba(255,255,255,0.06)";
  for (const { e: [u0, v0, u1, v1] } of walls) {
    for (let k = 0; k <= 4; k += 1) line(g, proj(u0, v0, k / 4), proj(u1, v1, k / 4));
    for (let k = 0; k <= 5; k += 1) {
      const a = k / 5;
      const u = u0 + (u1 - u0) * a;
      const v = v0 + (v1 - v0) * a;
      line(g, proj(u, v, 0), proj(u, v, 1));
    }
  }
  g.strokeStyle = "rgba(255,255,255,0.22)";
  line(g, proj(0, 0, 0), proj(1, 0, 0));
  line(g, proj(1, 0, 0), proj(1, 1, 0));
  line(g, proj(1, 1, 0), proj(0, 1, 0));
  line(g, proj(0, 1, 0), proj(0, 0, 0));

  // axis labels on the near edges
  g.fillStyle = "#86867f";
  g.font = "10.5px 'JetBrains Mono', monospace";
  const nearV = proj(0.5, 0, 0)[2] > proj(0.5, 1, 0)[2] ? 0 : 1;
  const nearU = proj(0, 0.5, 0)[2] > proj(1, 0.5, 0)[2] ? 0 : 1;
  const sG = axes.solarGrid;
  const wG = axes.windGrid;
  for (let k = 0; k <= 4; k += 1) {
    const a = k / 4;
    const sv = sG.length > 1 ? sG[0] + (sG[sG.length - 1] - sG[0]) * a : sG[0];
    const wv = wG.length > 1 ? wG[0] + (wG[wG.length - 1] - wG[0]) * a : wG[0];
    if (sG.length > 1 || k === 2) label(g, proj(a, nearV + (nearV ? 0.07 : -0.07), 0), nf(sv), "center");
    if (wG.length > 1 || k === 2) label(g, proj(nearU + (nearU ? 0.07 : -0.07), a, 0), nf(wv), "center");
  }
  g.fillStyle = "#c2c2bc";
  g.font = "500 11px 'Inter Tight', sans-serif";
  label(g, proj(0.5, nearV + (nearV ? 0.2 : -0.2), 0), "SOLAR  MW", "center");
  label(g, proj(nearU + (nearU ? 0.2 : -0.2), 0.5, 0), "WIND  MW", "center");
  // z ticks on the back corner
  const corner = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([u, v]) => ({ u, v, d: proj(u, v, 0)[2], x: proj(u, v, 0)[0] })).sort((a, b) => a.d - b.d)[0];
  g.strokeStyle = "rgba(255,255,255,0.22)";
  line(g, proj(corner.u, corner.v, 0), proj(corner.u, corner.v, 1));
  g.fillStyle = "#86867f";
  g.font = "10.5px 'JetBrains Mono', monospace";
  for (let k = 0; k <= 4; k += 1) {
    const [x, y] = proj(corner.u, corner.v, k / 4);
    g.textAlign = "right";
    g.fillText((zLo + (zHi - zLo) * (k / 4)).toFixed(2), x - 8, y + 3);
  }
  const [zx, zy] = proj(corner.u, corner.v, 1);
  g.textAlign = "right";
  g.fillStyle = "#c2c2bc";
  g.fillText("₹/kWh", zx - 8, zy - 14);
  g.restore();
}

function drawColorbar(g, W, H, zLo, zHi) {
  const x = W - 46;
  const y0 = H * 0.16;
  const h = H * 0.56;
  const grad = g.createLinearGradient(0, y0 + h, 0, y0);
  VIRIDIS.forEach((c, i) => grad.addColorStop(i / (VIRIDIS.length - 1), c));
  g.fillStyle = grad;
  g.fillRect(x, y0, 12, h);
  g.strokeStyle = "rgba(255,255,255,0.25)";
  g.strokeRect(x + 0.5, y0 + 0.5, 11, h - 1);
  g.fillStyle = "#86867f";
  g.font = "10px 'JetBrains Mono', monospace";
  g.textAlign = "right";
  for (let k = 0; k <= 4; k += 1) g.fillText((zLo + (zHi - zLo) * (k / 4)).toFixed(2), x - 6, y0 + h - (h * k) / 4 + 3);
  g.fillStyle = "rgba(255,107,95,0.5)";
  g.fillRect(x, y0 - 18, 12, 8);
  g.textAlign = "right";
  g.fillStyle = "#86867f";
  g.fillText("misses DFR", x - 6, y0 - 11);
}

function drawFound(g, proj, u, v, h, best, k, now) {
  const [x, y] = proj(u, v, h);
  const [fx, fy] = proj(u, v, 0);
  g.save();
  g.setLineDash([4, 4]);
  g.strokeStyle = `rgba(212,255,63,${0.8 * k})`;
  line(g, [x, y], [fx, fy]);
  g.setLineDash([]);
  const pulse = 6 + 5 * (0.5 + 0.5 * Math.sin(now / 160));
  g.beginPath();
  g.arc(x, y, pulse, 0, Math.PI * 2);
  g.strokeStyle = `rgba(212,255,63,${k})`;
  g.lineWidth = 1.5;
  g.stroke();
  g.beginPath();
  g.arc(x, y, 4, 0, Math.PI * 2);
  g.fillStyle = "#d4ff3f";
  g.fill();
  // callout
  const lines = [
    `Solar   ${nf(best.sizes.solarMw)} MW`,
    `Wind    ${nf(best.sizes.windMw)} MW`,
    `BESS    ${nf(best.sizes.bessMw)} MW · ${nf(best.sizes.bessMwh)} MWh`,
    `LCOE    ₹${best.lcoe.toFixed(3)}/kWh`,
  ];
  g.font = "500 12px 'JetBrains Mono', monospace";
  const bw = Math.max(...lines.map((l) => g.measureText(l).width)) + 24;
  const bh = lines.length * 18 + 16;
  const bx = x + 18;
  const by = y - bh - 14;
  g.globalAlpha = k;
  g.fillStyle = "rgba(10,10,10,0.92)";
  g.fillRect(bx, by, bw, bh);
  g.strokeStyle = "#d4ff3f";
  g.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);
  g.fillStyle = "#f4f4f1";
  g.textAlign = "left";
  lines.forEach((l, i) => g.fillText(l, bx + 12, by + 22 + i * 18));
  g.restore();
}

function line(g, a, b) {
  g.beginPath();
  g.moveTo(a[0], a[1]);
  g.lineTo(b[0], b[1]);
  g.stroke();
}

function label(g, p, text, align) {
  g.textAlign = align;
  g.fillText(text, p[0], p[1] + 4);
}
