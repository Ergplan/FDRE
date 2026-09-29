import { notFound, redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { getScenario } from "@/lib/scenarios";
import { plain } from "@/lib/json";
import PageShell from "@/components/PageShell";
import ScenarioDetail from "@/components/ScenarioDetail";
import { MODULE_LABEL } from "@/lib/summaryFields";

export const dynamic = "force-dynamic";

export default async function ScenarioPage({ params, searchParams }) {
  const user = await currentUser();
  const { id } = await params;
  if (!user) redirect(`/login?next=/scenarios/${id}`);
  const sp = await searchParams;
  let data;
  try {
    data = plain(await getScenario(id, sp?.v || null));
  } catch {
    notFound();
  }
  return (
    <PageShell user={user} active="scenarios" eyebrow={`${MODULE_LABEL[data.scenario.module]} · scenario`} title={data.scenario.name}>
      <ScenarioDetail data={data} />
    </PageShell>
  );
}
