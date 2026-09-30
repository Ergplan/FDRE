"use client";
import { useEffect } from "react";
import { startActivityTracker } from "@/src/activity";

/** Counts active time on the non-dashboard pages too. */
export default function ActivityPing() {
  useEffect(() => { startActivityTracker(); }, []);
  return null;
}
