"use client";
import { LogOut } from "lucide-react";
import { flushActivity } from "@/src/activity";

export default function SignOutButton() {
  return (
    <button
      type="button"
      className="rtc-reset"
      onClick={async () => {
        await flushActivity();
        await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
        window.location.href = "/login";
      }}
    >
      <LogOut size={13} /> Sign out
    </button>
  );
}
