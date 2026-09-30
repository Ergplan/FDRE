// Dashboard tabs an administrator can grant. Shared by server and client.
export const TAB_CATALOG = [
  { id: "rtc", label: "Round the Clock", engine: false },
  { id: "bessTender", label: "BESS Tender", engine: false },
  { id: "tender", label: "Tender Upload", engine: true },
  { id: "project", label: "Project Configuration", engine: true },
  { id: "yield", label: "Yield Assessment", engine: true },
  { id: "joulewiseReport", label: "Joulewise EYA Report", engine: true },
  { id: "finance", label: "Financial Inputs", engine: true },
  { id: "statements", label: "Financial Statements", engine: true },
  { id: "sensitivity", label: "Sensitivity & Scenarios", engine: true },
  { id: "customDispatch", label: "Custom Dispatch", engine: true },
  { id: "optimization", label: "Optimization", engine: true },
  { id: "validation", label: "Optimizer Validation", engine: true },
  { id: "optimizedEya", label: "Optimized EYA", engine: true },
  { id: "results", label: "Results", engine: true },
  { id: "reports", label: "Reports", engine: true },
];

export const ALL_TAB_IDS = TAB_CATALOG.map((t) => t.id);

export function cleanTabList(list) {
  if (!Array.isArray(list)) return null;
  const set = new Set(list.map(String));
  return ALL_TAB_IDS.filter((id) => set.has(id));
}

/** Administrators see everything; others get their own list, else the deployment default, else all. */
export function resolveTabs(user, defaultTabs) {
  if (!user) return [];
  if (user.role === "admin") return [...ALL_TAB_IDS];
  return cleanTabList(user.tab_access) ?? cleanTabList(defaultTabs) ?? [...ALL_TAB_IDS];
}

export function usesEngine(tabIds) {
  return tabIds.some((id) => TAB_CATALOG.find((t) => t.id === id)?.engine);
}
