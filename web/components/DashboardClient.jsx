"use client";
import dynamic from "next/dynamic";

// The dashboard uses canvas charts, Web Workers and localStorage, so it renders in the browser only.
const App = dynamic(() => import("@/src/main"), {
  ssr: false,
  loading: () => <div className="boot">Loading dashboard…</div>,
});

export default function DashboardClient({ user, initialScenario, openError }) {
  return (
    <>
      {openError && <div className="alert page-alert">Could not open scenario: {openError}</div>}
      <App user={user} initialScenario={initialScenario} />
    </>
  );
}
