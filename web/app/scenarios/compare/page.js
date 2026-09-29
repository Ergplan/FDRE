import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { getScenario } from "@/lib/scenarios";
import { plain } from "@/lib/json";
import PageShell from "@/components/PageShell";
import ScenarioCompare from "@/components/ScenarioCompare";

export const dynamic = "force-dynamic";
export const metadata = { title: "Compare scenarios" };

export default async function Compare({ searchParams }) {
  const user = await currentUser();
  const sp = await searchParams;
  const ids = String(sp?.ids || "").split(",").filter(Boolean).slice(0, 12);
  if (!user) redirect(`/login?next=${encodeURIComponent(`/scenarios/compare?ids=${ids.join(",")}`)}`);
  const items = [];
  const missing = [];
  for (const id of ids) {
    try {
      const d = await getScenario(id);
      items.push(plain({ scenario: d.scenario, current: { version: d.current.version, summary: d.current.summary, created_at: d.current.created_at } }));
    } catch {
      missing.push(id);
    }
  }
  return (
    <PageShell user={user} active="scenarios" eyebrow="Library" title="Compare scenarios">
      <ScenarioCompare items={items} missing={missing} />
    </PageShell>
  );
}
