// Usage tracking in the browser: a heartbeat that counts active time (page visible and used in
// the last 5 minutes) and a queue of usage events, both sent to /api/activity.
const BEAT_MS = 60 * 1000;
const IDLE_MS = 5 * 60 * 1000;

let queue = [];
let started = false;
let lastInput = Date.now();
let lastBeat = Date.now();
let activeMs = 0;

function send(body, beacon = false) {
  const json = JSON.stringify(body);
  if (beacon && typeof navigator !== "undefined" && navigator.sendBeacon) {
    navigator.sendBeacon("/api/activity", new Blob([json], { type: "application/json" }));
    return;
  }
  fetch("/api/activity", { method: "POST", headers: { "content-type": "application/json" }, body: json, credentials: "same-origin", keepalive: true }).catch(() => {});
}

function accrue() {
  const now = Date.now();
  const visible = typeof document === "undefined" || document.visibilityState === "visible";
  if (visible && now - lastInput < IDLE_MS) activeMs += now - lastBeat;
  lastBeat = now;
}

function flush(beacon = false) {
  accrue();
  const seconds = Math.round(activeMs / 1000);
  if (!seconds && !queue.length) return;
  activeMs -= seconds * 1000;
  const events = queue.splice(0, 20);
  send({ ping: { activeSeconds: seconds }, events }, beacon);
}

/** Record a usage event (kinds: tab, optimize, run, export, download). Tab views are batched. */
export function trackEvent(kind, detail = {}, ms = null) {
  queue.push({ kind, detail, ms });
  if (kind !== "tab" || queue.length >= 10) flush();
}

/** Send everything now (call before signing out, while the session cookie is still valid). */
export async function flushActivity() {
  accrue();
  const seconds = Math.round(activeMs / 1000);
  activeMs -= seconds * 1000;
  const events = queue.splice(0, 20);
  if (!seconds && !events.length) return;
  await fetch("/api/activity", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ping: { activeSeconds: seconds }, events }), credentials: "same-origin" }).catch(() => {});
}

export function startActivityTracker() {
  if (started || typeof window === "undefined") return;
  started = true;
  const mark = () => { lastInput = Date.now(); };
  for (const ev of ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"]) window.addEventListener(ev, mark, { passive: true });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush(true);
    else { lastBeat = Date.now(); mark(); }
  });
  window.addEventListener("pagehide", () => flush(true));
  setInterval(() => flush(false), BEAT_MS);
  // count the first minute and deliver early events promptly
  setTimeout(() => flush(false), 5000);
}
