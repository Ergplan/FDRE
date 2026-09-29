import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import PageShell from "@/components/PageShell";
import AccountForm from "@/components/AccountForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "Account · FDRE" };

export default async function Account() {
  const user = await currentUser();
  if (!user) redirect("/login?next=/account");
  return (
    <PageShell user={user} active="account" eyebrow={user.email} title="Account">
      <AccountForm user={user} />
    </PageShell>
  );
}
