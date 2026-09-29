// Runs the RTC optimizer off the main thread. Surface cells (one per solar x wind grid point)
// are batched and streamed so the UI can draw the surface as it is found. For the tariff
// objective the worker also asks the engine's HiGHS LP (/api/rtc/lp) for the global optimum
// as soon as screening is done, streams its log to the UI while it solves, and hands the
// result back to the exact 25-year search. Without the engine the search runs on its own.
import { buildContext, buildModel, highsPayload, optimizeSteps } from "./engine.js";

const HIGHS_TIMEOUT_MS = 20 * 60 * 1000;
let skipHighs = null; // aborts the HiGHS request when the user continues without it

async function runHighs(id, payload, t0) {
  const started = performance.now() - t0; // HiGHS line times are relative to this
  const lines = [];
  let result = null;
  let error = null;
  let pending = [];
  let lastPost = 0;
  const post = (force) => {
    const now = performance.now();
    if (pending.length && (force || now - lastPost > 150)) {
      self.postMessage({ id, type: "highs-log", lines: pending });
      pending = [];
      lastPost = now;
    }
  };
  const abort = new AbortController();
  let skipped = false;
  skipHighs = () => { skipped = true; abort.abort(); };
  const timer = setTimeout(() => abort.abort(), HIGHS_TIMEOUT_MS);
  try {
    const res = await fetch("/api/rtc/lp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(payload),
      signal: abort.signal,
    });
    if (!res.ok || !res.body) {
      let msg = `engine returned ${res.status}`;
      try {
        const j = await res.json();
        msg = j.error || j.detail || msg;
      } catch { /* not JSON */ }
      throw new Error(msg);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const raw = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!raw) continue;
        const ev = JSON.parse(raw);
        if (ev.type === "log") {
          const line = { t: Math.round(started + ev.t), stage: ev.stage, msg: ev.msg };
          lines.push(line);
          pending.push(line);
        } else if (ev.type === "progress") {
          self.postMessage({ id, type: "highs-progress", progress: ev });
        } else if (ev.type === "result") {
          result = ev.result;
        } else if (ev.type === "error") {
          error = ev.error;
        }
      }
      post(false);
    }
  } catch (err) {
    error = skipped ? "skipped by the user" : abort.signal.aborted ? "timed out" : String(err?.message || err);
  } finally {
    clearTimeout(timer);
    skipHighs = null;
  }
  post(true);
  if (!error && !(result && result.ok)) error = result ? `HiGHS status: ${result.status}` : "no result";
  self.postMessage({ id, type: "highs-done", result: error ? null : result, error });
  return error ? { error, log: lines } : { highs: result, log: lines };
}

self.onmessage = async (event) => {
  if (event.data?.type === "skip-highs") {
    skipHighs?.();
    return;
  }
  const { id, ctx, modelInput, useHighs } = event.data;
  try {
    const t0 = performance.now();
    const context = buildContext(ctx);
    const model = buildModel(modelInput);
    let last = 0;
    let cells = [];
    let tcells = [];
    const flush = () => {
      if (cells.length) self.postMessage({ id, type: "cells", cells });
      if (tcells.length) self.postMessage({ id, type: "tcells", cells: tcells });
      cells = [];
      tcells = [];
    };
    const onProgress = (p) => {
      if (p.stage === "axes") {
        self.postMessage({ id, type: "axes", axes: p });
        return;
      }
      if (p.stage === "cell") {
        cells.push({ ...p, z: p.lcoe });
        if (cells.length >= 6) flush();
        return;
      }
      if (p.stage === "tcell") {
        tcells.push(p);
        if (tcells.length >= 6) flush();
        return;
      }
      const now = Date.now();
      if (now - last > 120) {
        last = now;
        flush();
        self.postMessage({ id, type: "progress", progress: p });
      }
    };
    const steps = optimizeSteps(context, model, onProgress);
    let highsRun = null;
    let step = steps.next();
    while (!step.done) {
      if (step.value.stage === "screened") {
        flush();
        if (useHighs && model.objective === "tariff") {
          self.postMessage({ id, type: "highs-start" });
          highsRun = runHighs(id, highsPayload(context, model, step.value.seed), t0);
        }
        step = steps.next();
      } else if (step.value.stage === "await-seeds") {
        flush();
        const ext = highsRun ? await highsRun : null;
        step = steps.next(ext);
      } else {
        step = steps.next();
      }
    }
    flush();
    self.postMessage({ id, type: "done", result: step.value });
  } catch (err) {
    self.postMessage({ id, type: "error", error: String(err?.message || err) });
  }
};
