// Runs the RTC least-cost optimizer off the main thread.
import { buildContext, buildModel, optimize } from "./engine.js";

self.onmessage = (event) => {
  const { id, ctx, modelInput } = event.data;
  try {
    const context = buildContext(ctx);
    const model = buildModel(modelInput);
    let last = 0;
    const result = optimize(context, model, (p) => {
      const now = Date.now();
      if (now - last > 120) {
        last = now;
        self.postMessage({ id, type: "progress", progress: p });
      }
    });
    self.postMessage({ id, type: "done", result });
  } catch (err) {
    self.postMessage({ id, type: "error", error: String(err?.message || err) });
  }
};
