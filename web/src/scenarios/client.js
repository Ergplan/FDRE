// Browser helpers for the scenario API.
async function call(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    window.location.href = `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
    throw new Error("Session expired. Sign in again.");
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export const scenarioApi = {
  list: (params = {}) => call(`/api/scenarios?${new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== ""))}`),
  get: (id, version) => call(`/api/scenarios/${id}${version ? `?version=${version}` : ""}`),
  create: (payload) => call("/api/scenarios", { method: "POST", body: payload }),
  saveVersion: (id, payload) => call(`/api/scenarios/${id}`, { method: "PUT", body: payload }),
  update: (id, meta) => call(`/api/scenarios/${id}`, { method: "PATCH", body: meta }),
  remove: (id) => call(`/api/scenarios/${id}`, { method: "DELETE" }),
  restore: (id, version) => call(`/api/scenarios/${id}/restore`, { method: "POST", body: { version } }),
  exportUrl: (ids, version) => `/api/scenarios/export?ids=${ids.join(",")}${version ? `&version=${version}` : ""}`,
};

export const authApi = {
  logout: () => call("/api/auth/logout", { method: "POST" }),
};
