"use client";
import { LogOut } from "lucide-react";

export default function SignOutButton() {
  return (
    <button
      type="button"
      className="rtc-reset"
      onClick={async () => {
        await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
        window.location.href = "/login";
      }}
    >
      <LogOut size={13} /> Sign out
    </button>
  );
}
