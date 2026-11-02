"use client";
import dynamic from "next/dynamic";

// Client-only so dates render in the buyer's time zone without hydration mismatches.
export const PermissionFormLoader = dynamic(() => import("./PermissionForm"), {
  ssr: false,
  loading: () => <div className="h-96 animate-pulse rounded-2xl bg-[var(--surface-2)]" />,
});
