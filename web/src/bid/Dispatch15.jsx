import React, { useEffect, useState } from "react";
import { CheckCircle2, Download, Loader2, Play, TriangleAlert, XCircle } from "lucide-react";
import { Section, nf, pf } from "../rtc/ui";
import { getJson } from "./TenderStep";

const PLANT_TITLE = { biomass: "Biomass", thermal: "Thermal", hydro: "Hydro" };

/**
 * Size step 4.5: the sized plant dispatched in 15-minute blocks (96 a day) for every PPA year,
 * with biomass and thermal held at their technical minimum and ramp limit in every block.
 * Runs on the engine as a job (a few minutes); the per-year results show as each year finishes,
 * then the ZIP of 15-minute CSV files can be downloaded.
 */
export default function Dispatch15({ lp, start }) {
  const jobId = lp?.d15?.jobId || null;
  const [job, setJob] = useState(null);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    if (!jobId) { setJob(null); return undefined; }
    let stop = false;
    let timer = null;
    const poll = async () => {
      try {
        const next = await getJson(`/api/bid/dispatch15/${jobId}`);
        if (stop) return;
        setJob(next);
        if (next.status === "queued" || next.status === "running") timer = setTimeout(poll, 2500);
      } catch (err) {
        if (!stop) setError(/No such/.test(err.message) ? "This run is no longer on the server (runs are kept for 24 hours): run it again." : err.message);
      }
    };
    poll();
    return () => { stop = true; clearTimeout(timer); };
  }, [jobId]);

  async function run() {
    setError("");
    setStarting(true);
    try {
      await start();
    } catch (err) {
      setError(err.message);
    } finally {
      setStarting(false);
    }
  }

  const busy = starting || job?.status === "queued" || job?.status === "running";
  const years = job?.years || [];
  const done = job?.status === "done";
  const total = job?.progress?.total || 25;
  const rules = years[0]?.rules || [];
  const plants = Object.keys(years[0]?.plants || {});
  const failedYears = years.filter((y) => !y.allMet);
  const worst = (pid, key, fn) => (years.length ? fn(...years.map((y) => y.plants[pid]?.[key] ?? 0)) : null);

  return (
    <Section index="4.5" title="15-minute dispatch, every PPA year" note="96 blocks a day · ramp and technical minimum in every block"
      actions={(
        <>
          <button type="button" className={done ? "secondary" : "primary"} onClick={run} disabled={busy || !lp} data-testid="bid-d15-run">
            {busy ? <Loader2 className="spin" size={14} /> : <Play size={14} />} {jobId ? "Run again" : "Run the 15-minute dispatch"}
          </button>
          {done && (
            <a className="button primary" href={`/api/bid/dispatch15/${jobId}/zip`} download data-testid="bid-d15-download">
              <Download size={14} /> Download 15-minute dispatch (ZIP)
            </a>
          )}
        </>
      )}>
      <p className="rtc-note">
        The sizing above works hour by hour. This takes the plant it chose and dispatches it in 15-minute time blocks for every
        year of the PPA, one HiGHS run per year with that year's degradation: biomass and thermal stay at or above their
        technical minimum in every block and move by no more than their ramp rate per block (%/min × 15); the battery charges
        from renewable output only and never charges and discharges in the same block; the tender's supply floors are checked
        on the 15-minute delivery. Solar and wind profiles are hourly, so each hour is split into four blocks along the
        hour's trend, keeping its energy. The download has one CSV per year (35,040 rows) and a summary by year.
      </p>
      {busy && (
        <div className="bid-progress" role="status" data-testid="bid-d15-progress">
          <div className="bid-progress-bar"><i style={{ width: `${Math.round(((job?.progress?.done || 0) / total) * 100)}%` }} /></div>
          <span><Loader2 className="spin" size={13} /> {years.length ? `Year ${years.length} of ${total} done` : "Solving year 1 (the longest; later years start from it)"}</span>
        </div>
      )}
      {job?.status === "failed" && <div className="alert"><TriangleAlert size={14} /> {job.error}</div>}
      {error && <div className="alert"><TriangleAlert size={14} /> {error}</div>}
      {done && (
        <div className={`bid-mode ${failedYears.length ? "rules" : ""}`} data-testid="bid-d15-verdict">
          {failedYears.length ? <TriangleAlert size={14} /> : <CheckCircle2 size={14} />}
          <span>
            {failedYears.length
              ? `In 15-minute blocks the plant misses a supply floor in ${failedYears.length} of ${years.length} years (years ${failedYears.map((y) => y.year).join(", ")}); shortfall ${nf(failedYears.reduce((a, y) => a + y.shortfallMu, 0), 1)} MU in all. Size again with more battery or a fixed larger biomass.`
              : `Every supply floor is met in all ${years.length} years in 15-minute blocks.`}
            {plants.map((pid) => ` ${PLANT_TITLE[pid] || pid}: lowest output ${pf(worst(pid, "minPct", Math.min), 1)} of MW (technical minimum ${pf(years[0].plants[pid].minLoad, 0)}), largest 15-minute change ${pf(worst(pid, "maxStepPct", Math.max), 1)} (limit ${years[0].plants[pid].rampPerBlock != null ? pf(years[0].plants[pid].rampPerBlock, 0) : "none"}).`).join("")}
          </span>
        </div>
      )}
      {years.length > 0 && (
        <div className="bid-d15" data-testid="bid-d15-table">
          <div className="bid-d15-row head">
            <span>Year</span>
            {rules.map((r) => <span key={r.id}>{r.label || r.id} ≥ {pf(r.target, 0)}</span>)}
            <span>Shortfall</span>
            {plants.map((pid) => <span key={pid}>{PLANT_TITLE[pid] || pid}: lowest · largest 15-min change</span>)}
            <span>Curtailed</span>
            <span>Sold</span>
          </div>
          {years.map((y) => (
            <div key={y.year} className={`bid-d15-row ${y.allMet ? "" : "failed"}`}>
              <span>{y.year}</span>
              {y.rules.map((r) => <span key={r.id} className={r.met ? "ok" : "bad"}>{r.met ? <CheckCircle2 size={12} /> : <XCircle size={12} />} {pf(r.achieved, 1)}</span>)}
              <span>{y.shortfallMu > 0.0005 ? `${nf(y.shortfallMu, 1)} MU` : "none"}</span>
              {plants.map((pid) => <span key={pid}>{pf(y.plants[pid].minPct, 1)} · {pf(y.plants[pid].maxStepPct, 1)}</span>)}
              <span>{nf(y.curtailedMu, 0)} MU</span>
              <span>{nf(y.soldMu, 0)} MU</span>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}
