import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { query } from "@/lib/db";
import { plain } from "@/lib/json";
import { getSetting } from "@/lib/settings";
import { ALL_TAB_IDS, cleanTabList } from "@/lib/tabs";
import PageShell from "@/components/PageShell";
import UserAdmin from "@/components/UserAdmin";

export const dynamic = "force-dynamic";
export const metadata = { title: "Users" };

export default async function UsersPage() {
  const user = await currentUser();
  if (!user) redirect("/login?next=/admin/users");
  if (user.role !== "admin") redirect("/");
  const { rows } = await query("SELECT id, email, name, role, tab_access, created_at, last_login_at FROM users ORDER BY created_at");
  return (
    <PageShell user={user} active="users" eyebrow="Administration" title="Users">
      <UserAdmin me={user} initial={plain(rows)} defaultTabs={cleanTabList(await getSetting("default_tabs", null)) ?? ALL_TAB_IDS} />
    </PageShell>
  );
}
