import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { query } from "@/lib/db";
import { plain } from "@/lib/json";
import PageShell from "@/components/PageShell";
import ActivityAdmin from "@/components/ActivityAdmin";

export const dynamic = "force-dynamic";
export const metadata = { title: "Activity" };

export default async function ActivityPage() {
  const user = await currentUser();
  if (!user) redirect("/login?next=/admin/activity");
  if (user.role !== "admin") redirect("/");
  const { rows } = await query("SELECT id, email, name FROM users ORDER BY name, email");
  return (
    <PageShell user={user} active="activity" eyebrow="Administration" title="User activity">
      <ActivityAdmin users={plain(rows)} />
    </PageShell>
  );
}
