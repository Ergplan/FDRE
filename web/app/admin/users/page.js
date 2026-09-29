import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { query } from "@/lib/db";
import { plain } from "@/lib/json";
import PageShell from "@/components/PageShell";
import UserAdmin from "@/components/UserAdmin";

export const dynamic = "force-dynamic";
export const metadata = { title: "Users · FDRE" };

export default async function UsersPage() {
  const user = await currentUser();
  if (!user) redirect("/login?next=/admin/users");
  if (user.role !== "admin") redirect("/");
  const { rows } = await query("SELECT id, email, name, role, created_at, last_login_at FROM users ORDER BY created_at");
  return (
    <PageShell user={user} active="users" eyebrow="Administration" title="Users">
      <UserAdmin me={user} initial={plain(rows)} />
    </PageShell>
  );
}
