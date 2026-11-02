"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiCall } from "./api-client";
import { btn } from "./ui";

export function NewPermissionButton({ label = "New permission" }: { label?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      className={btn.primary}
      onClick={async () => {
        setBusy(true);
        const { id } = await apiCall<{ id: string }>("/api/permissions", "POST");
        router.push(`/permissions/${id}/edit`);
      }}
    >
      {busy ? "Creating…" : `+ ${label}`}
    </button>
  );
}
