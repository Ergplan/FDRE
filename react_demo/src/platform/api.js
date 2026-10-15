// The only place the platform API (/api/v1) is called from the workspace. The session is an
// HttpOnly cookie set by /auth/login; every answer carries X-Request-Id for the audit trail.

export class ApiError extends Error {
  constructor(status, body, requestId) {
    super(body?.message || body?.detail?.message || `HTTP ${status}`);
    this.status = status;
    this.body = body;
    this.requestId = requestId;
  }
}

export async function platformApi(path, { method = "GET", body, headers = {} } = {}) {
  const res = await fetch(`/api/v1${path}`, {
    method,
    credentials: "include",
    headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const requestId = res.headers.get("X-Request-Id");
  if (res.status === 204) return null;
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) {
    if (res.status === 401) window.dispatchEvent(new CustomEvent("fdre:unauthenticated"));
    throw new ApiError(res.status, data, requestId);
  }
  return data;
}

export const auth = {
  me: () => platformApi("/auth/me"),
  login: (email, password) => platformApi("/auth/login", { method: "POST", body: { email, password } }),
  logout: () => platformApi("/auth/logout", { method: "POST" }),
};

export function orgApi(orgId) {
  const base = `/orgs/${orgId}`;
  return {
    tenders: () => platformApi(`${base}/tenders`),
    createTender: (body) => platformApi(`${base}/tenders`, { method: "POST", body }),
    scenarios: (tenderId) => platformApi(`${base}/tenders/${tenderId}/scenarios`),
    createScenario: (tenderId, body) => platformApi(`${base}/tenders/${tenderId}/scenarios`, { method: "POST", body }),
    scenario: (id) => platformApi(`${base}/scenarios/${id}`),
    saveInputs: (id, expectedRevision, inputs, note = "") =>
      platformApi(`${base}/scenarios/${id}/inputs`, { method: "PUT", body: { expected_revision: expectedRevision, inputs, note } }),
    versions: (id) => platformApi(`${base}/scenarios/${id}/versions`),
    launchRun: (scenarioId, kind, solverSettings = {}, idempotencyKey) =>
      platformApi(`${base}/scenarios/${scenarioId}/runs`, { method: "POST", body: { kind, solver_settings: solverSettings }, headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {} }),
    runs: (scenarioId) => platformApi(`${base}/scenarios/${scenarioId}/runs`),
    run: (id, includeResult = true) => platformApi(`${base}/runs/${id}?include_result=${includeResult}`),
    cancelRun: (id) => platformApi(`${base}/runs/${id}/cancel`, { method: "POST" }),
    audit: (objectType, objectId) => platformApi(`${base}/audit?object_type=${objectType}&object_id=${objectId}`),
    notifications: (unreadOnly = false) => platformApi(`${base}/notifications?unread_only=${unreadOnly}`),
    markRead: (id) => platformApi(`${base}/notifications/${id}/read`, { method: "POST" }),
  };
}
