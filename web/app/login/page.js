import { redirect } from "next/navigation";
import { currentUser, userCount } from "@/lib/auth";
import AuthForm from "@/components/AuthForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in · FDRE" };

export default async function Login({ searchParams }) {
  if ((await userCount()) === 0) redirect("/setup");
  if (await currentUser()) redirect("/");
  const sp = await searchParams;
  return <AuthForm mode="login" next={sp?.next || "/"} />;
}
