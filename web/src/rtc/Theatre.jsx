import React, { useEffect, useRef, useState } from "react";
import { FastForward, SkipForward, X } from "lucide-react";

// Optimizer "theatre": while the worker searches, an isometric 3D surface over solar MW × wind MW
// (best storage at each point) is built cell by cell: the 25-year tariff in tariff mode, the
// levelised cost otherwise. While the HiGHS LP solves on the engine, its live log scrolls in a
// console, a scan plane sweeps the surface, and its optimum is marked when it arrives. Then the
// least-cost point is marked and the overlay hands over to the result.
//
// `feed` is a ref filled by the parent from worker messages:
//   { axes: { solarGrid, windGrid, total }, cells: [...], tcells: [...], tariffMode,
//     highs: { active, lines, progress, done, result, error, startedAt }, done, result, error }

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

const clockOf = (ms) => `${String(Math.floor(ms / 60000)).padStart(2, "0")}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;

export default function OptimizerTheatre({ feed, onFinish, onCancel, onSkipHighs, title, buildSteps }) {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const consoleRef = useRef(null);
  const [status, setStatus] = useState({ shown: 0, total: 0, phase: "build", evals: 0, screened: 0, mapped: 0, highs: null });
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
      if (!wrapRef.current) return; // observer can fire after the overlay closes
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
    // the stage narrows when the HiGHS console opens beside it
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(resize) : null;
    if (ro) ro.observe(wrapRef.current);
    else window.addEventListener("resize", resize);

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
      const src = f.tariffMode ? f.tcells : f.cells;
      const shown = Math.min(src.length, paced);

      // value grid (null until revealed)
      const V = Array.from({ length: nS }, () => new Array(nW).fill(null));
      let fMin = Infinity;
      let fMax = -Infinity;
      let anyMax = -Infinity;
      for (let k = 0; k < shown; k += 1) {
        const c = src[k];
        V[c.si][c.wi] = c;
        if (Number.isFinite(c.z)) {
          anyMax = Math.max(anyMax, c.z);
          if (c.feasible) { fMin = Math.min(fMin, c.z); fMax = Math.max(fMax, c.z); }
        }
        if (!flashes.has(k)) flashes.set(k, now);
      }
      // designs that miss the DFR target sit on a plateau above the most expensive feasible one
      const targetLo = Number.isFinite(fMin) ? fMin : Number.isFinite(anyMax) ? anyMax * 0.9 : 4;
      const targetHi = Number.isFinite(fMax) ? Math.max(fMax * 1.06, targetLo + 0.2) : targetLo + 1;
      zLo = zLo === null ? targetLo : zLo + (targetLo - zLo) * 0.12;
      zHi = zHi === null ? targetHi : zHi + (targetHi - zHi) * 0.12;
      const zOf = (c) => (c.feasible && Number.isFinite(c.z) ? c.z : zHi);
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
        const c = src[k];
        const age = now - (flashes.get(k) || now);
        if (age > 700) continue;
        const [x, y] = proj(uPos[Math.min(c.si, uPos.length - 1)], vPos[Math.min(c.wi, vPos.length - 1)], hOf(zOf(c)));
        ctx2d.beginPath();
        ctx2d.arc(x, y, 2 + (age / 700) * 6, 0, Math.PI * 2);
        ctx2d.strokeStyle = `rgba(212,255,63,${1 - age / 700})`;
        ctx2d.lineWidth = 1.2;
        ctx2d.stroke();
      }

      drawColorbar(ctx2d, W, H, zLo, zHi, axes.missLabel);

      // HiGHS: scan plane while it solves, its optimum once it is back
      const hs = f.highs;
      const sMin0 = axes.solarGrid[0];
      const sMax0 = axes.solarGrid[nS - 1];
      const wMin0 = axes.windGrid[0];
      const wMax0 = axes.windGrid[nW - 1];
      const xKey = axes.xKey || "solarMw";
      const yKey = axes.yKey || "windMw";
      const uvOf = (z) => [nS <= 1 ? 0.5 : (z[xKey] - sMin0) / Math.max(1e-9, sMax0 - sMin0), nW <= 1 ? 0.5 : (z[yKey] - wMin0) / Math.max(1e-9, wMax0 - wMin0)];
      if (hs?.active && !hs.done && !foundAt && shown >= total) drawScan(ctx2d, proj, (elapsed / 2600) % 1);
      if (hs?.done && hs.result?.sizes && Number.isFinite(hs.result.tariff) && !foundAt) {
        const [u, v] = uvOf(hs.result.sizes);
        drawHighsMark(ctx2d, proj, u, v, hOf(hs.result.tariff), hs.result, now);
      }

      // phase control
      const built = shown >= total && src.length >= total;
      if (!foundAt && f.done && f.result && built && (elapsed >= minMs || skipRef.current)) foundAt = now;
      if (foundAt) {
        const k = now - foundAt;
        const best = f.result.best;
        const [u, v] = uvOf(best.sizes);
        drawFound(ctx2d, proj, u, v, hOf(Number.isFinite(best.tariff) ? best.tariff : best.lcoe), best, Math.min(1, k / 600), now, f.callout);
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
        setStatus({
          shown,
          total,
          phase: foundAt ? "found" : built && !f.done ? "refine" : f.done && built ? "confirm" : "build",
          evals: f.progress?.evals || 0,
          screened: f.cells.length,
          mapped: f.tcells.length,
          highs: hs?.active ? {
            lines: hs.lines.slice(-40),
            count: hs.lines.length,
            lpInfo: hs.lines.find((l) => /^LP:/.test(l.msg))?.msg,
            elapsed: (hs.endedAt || now) - hs.startedAt,
            progress: hs.progress,
            done: hs.done,
            error: hs.error,
            result: hs.result,
          } : null,
        });
      }
      if (!finished) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      if (ro) ro.disconnect();
      else window.removeEventListener("resize", resize);
    };
  }, [feed]);

  const tariffMode = Boolean(feed.current?.tariffMode);
  const hs = status.highs;
  const total = status.total || 0;
  let pct;
  if (!tariffMode) pct = total ? Math.round((status.shown / total) * 100) : 0;
  else {
    const screen = total ? status.screened / total : 0;
    const map = total ? status.mapped / total : 0;
    const lp = hs ? (hs.done ? 1 : 1 - Math.exp(-hs.elapsed / 45000)) : map >= 1 ? 1 : 0;
    pct = Math.round(12 * screen + 18 * map + 62 * lp + (status.phase === "confirm" ? 6 : 0));
  }
  const lpInfo = hs?.lpInfo;
  const steps = buildSteps ? buildSteps(status) : tariffMode ? [
    ["Loaded 8,760-hour demand, solar and wind profiles", true],
    [`Screening ${status.screened}/${total || "…"} solar × wind mixes, cheapest battery at each`, status.screened > 0],
    [`25-year tariff at every mix · ${status.mapped}/${total || "…"} full financial models (DFR checked in every year)`, status.mapped > 0],
    hs
      ? [hs.error ? `HiGHS not used (${hs.error}); continuing with the search` : hs.done && hs.result ? `HiGHS LP optimum ₹${Number(hs.result.tariff).toFixed(4)}/kWh${Number.isFinite(hs.result.lowerBound) ? ` · nothing can beat ₹${hs.result.lowerBound.toFixed(4)}` : ""} · ${clockOf(hs.elapsed)}` : `HiGHS solving the sizing LP for the global optimum · ${clockOf(hs.elapsed)}`, true]
      : ["HiGHS LP skipped (search only)", status.mapped >= total && total > 0],
    ["Exact 25-year model around the optimum (pattern search + neighbourhood check)", Boolean(hs?.done) || (!hs && status.phase !== "build")],
    ["Least-tariff design found", status.phase === "found"],
  ] : [
    ["Loaded 8,760-hour demand, solar and wind profiles", true],
    [`Building the cost surface · ${status.shown}/${status.total || "…"} solar × wind mixes`, status.shown > 0],
    ["Bisecting battery energy for the cheapest feasible storage at every mix", status.shown > 0],
    ["Refining around the minimum with a pattern search", status.phase !== "build"],
    ["Least-cost design found", status.phase === "found"],
  ];
  useEffect(() => {
    const el = consoleRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [hs?.count]);

  return (
    <div className="theatre" role="dialog" aria-modal="true" aria-label="Optimizing">
      <div className="theatre-inner">
        <header className="theatre-head">
          <div>
            <span className="theatre-brand"><img src="/brand/joulewise-logo-dark.png" alt="Joulewise" /></span>
            <span className="rtc-index">OPTIMIZING</span>
            <h2>{title || (tariffMode ? "Solving for the least 25-year tariff" : "Searching for the least-cost mix")}</h2>
          </div>
          <div className="theatre-actions">
            {hs && !hs.done && onSkipHighs && <button type="button" className="rtc-reset" onClick={onSkipHighs} title="Stop waiting for HiGHS and finish with the search results"><FastForward size={13} /> Continue without HiGHS</button>}
            <button type="button" className="rtc-reset" onClick={() => { skipRef.current = true; }}><SkipForward size={13} /> Skip animation</button>
            {onCancel && <button type="button" className="rtc-reset" onClick={onCancel}><X size={13} /> Cancel</button>}
          </div>
        </header>
        <div className={`theatre-stage ${hs && status.phase !== "found" ? "with-console" : ""}`}>
          <div className="theatre-canvas" ref={wrapRef}><canvas ref={canvasRef} /></div>
          {hs && status.phase !== "found" && (
            <aside className={`highs-console ${hs.done ? "is-done" : ""}`} aria-live="polite">
              <header>
                <span><i className={hs.done ? "" : "pulse"} /> HiGHS {hs.done ? (hs.error ? "· not used" : "· optimal") : "· solving"}</span>
                <b>{clockOf(hs.elapsed)}</b>
              </header>
              {lpInfo && <p className="highs-size">{lpInfo.replace(/^LP: /, "")}</p>}
              {hs.progress?.lambda && <p className="highs-lambda">Dinkelbach {hs.progress.iteration} · λ ₹{Number(hs.progress.lambda).toFixed(4)}/kWh{hs.progress.lowerBound ? ` · bound ₹${Number(hs.progress.lowerBound).toFixed(4)}` : ""}</p>}
              <div className="highs-lines" ref={consoleRef}>
                {hs.lines.map((l, i) => <div key={hs.count - hs.lines.length + i} className={l.stage === "highs" ? "hl" : ""}>{l.msg}</div>)}
                {!hs.done && <div className="cursor">▍</div>}
              </div>
            </aside>
          )}
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
  label(g, proj(0.5, nearV + (nearV ? 0.2 : -0.2), 0), axes.xLabel || "SOLAR  MW", "center");
  label(g, proj(nearU + (nearU ? 0.2 : -0.2), 0.5, 0), axes.yLabel || "WIND  MW", "center");
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
  g.fillText(axes.zUnit || "₹/kWh", zx - 8, zy - 14);
  g.restore();
}

function drawColorbar(g, W, H, zLo, zHi, missLabel = "misses DFR") {
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
  g.fillText(missLabel, x - 6, y0 - 11);
}

function drawFound(g, proj, u, v, h, best, k, now, callout) {
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
  const lines = callout ? callout(best) : [
    `Solar   ${nf(best.sizes.solarMw)} MW`,
    `Wind    ${nf(best.sizes.windMw)} MW`,
    `BESS    ${nf(best.sizes.bessMw)} MW · ${nf(best.sizes.bessMwh)} MWh`,
    Number.isFinite(best.tariff) ? `Tariff  ₹${best.tariff.toFixed(3)}/kWh · 25 yr` : `LCOE    ₹${best.lcoe.toFixed(3)}/kWh`,
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

function drawScan(g, proj, phase) {
  // a translucent plane sweeping up and down the value axis
  const h = 0.5 - 0.5 * Math.cos(phase * Math.PI * 2);
  const pts = [proj(0, 0, h), proj(1, 0, h), proj(1, 1, h), proj(0, 1, h)];
  g.save();
  g.beginPath();
  pts.forEach(([x, y], k) => (k ? g.lineTo(x, y) : g.moveTo(x, y)));
  g.closePath();
  g.fillStyle = "rgba(90,180,232,0.07)";
  g.fill();
  g.strokeStyle = "rgba(90,180,232,0.55)";
  g.lineWidth = 1;
  g.stroke();
  g.restore();
}

function drawHighsMark(g, proj, u, v, h, res, now) {
  const [x, y] = proj(u, v, h);
  g.save();
  const s = 7 + 2 * Math.sin(now / 200);
  g.beginPath();
  g.moveTo(x, y - s);
  g.lineTo(x + s, y);
  g.lineTo(x, y + s);
  g.lineTo(x - s, y);
  g.closePath();
  g.strokeStyle = "#5ab4e8";
  g.lineWidth = 1.6;
  g.stroke();
  g.font = "500 11px 'JetBrains Mono', monospace";
  g.fillStyle = "#5ab4e8";
  g.textAlign = "left";
  g.fillText(`HiGHS optimum ₹${res.tariff.toFixed(3)}`, x + 12, y + 4);
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
