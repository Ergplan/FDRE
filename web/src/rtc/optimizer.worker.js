// Runs the RTC least-cost optimizer off the main thread. Surface cells (one per solar x wind
// grid point) are batched and streamed so the UI can draw the cost surface as it is found.
import { buildContext, buildModel, optimize } from "./engine.js";

self.onmessage = (event) => {
  const { id, ctx, modelInput } = event.data;
  try {
    const context = buildContext(ctx);
    const model = buildModel(modelInput);
    let last = 0;
    let cells = [];
    const flush = () => {
      if (cells.length) self.postMessage({ id, type: "cells", cells });
      cells = [];
    };
    const result = optimize(context, model, (p) => {
      if (p.stage === "axes") {
        self.postMessage({ id, type: "axes", axes: p });
        return;
      }
      if (p.stage === "cell") {
        cells.push(p);
        if (cells.length >= 6) flush();
        return;
      }
      const now = Date.now();
      if (now - last > 120) {
        last = now;
        flush();
        self.postMessage({ id, type: "progress", progress: p });
      }
    });
    flush();
    self.postMessage({ id, type: "done", result });
  } catch (err) {
    self.postMessage({ id, type: "error", error: String(err?.message || err) });
  }
};
