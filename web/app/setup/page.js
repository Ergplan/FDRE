import { redirect } from "next/navigation";
import { userCount } from "@/lib/auth";
import AuthForm from "@/components/AuthForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "Set up" };

export default async function Setup() {
  if ((await userCount()) > 0) redirect("/login");
  return <AuthForm mode="setup" />;
}
