import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { getScenario } from "@/lib/scenarios";
import { plain } from "@/lib/json";
import DashboardClient from "@/components/DashboardClient";

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }) {
  const user = await currentUser();
  if (!user) redirect("/login");
  const sp = await searchParams;
  let initialScenario = null;
  let openError = "";
  if (sp?.open) {
    try {
      initialScenario = plain(await getScenario(sp.open, sp.v || null));
    } catch (err) {
      openError = err.message;
    }
  }
  return <DashboardClient user={user} initialScenario={initialScenario} openError={openError} />;
}
