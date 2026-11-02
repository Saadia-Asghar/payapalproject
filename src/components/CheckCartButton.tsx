"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiCall, ApiError } from "./api-client";
import { btn } from "./ui";

/** Asks the server to build this cart from the catalog and check it against the permission. */
export function CheckCartButton({
  permissionId,
  sku,
  source,
  primary,
}: {
  permissionId: string;
  sku: string;
  source: "AGENT" | "BUYER_PICK";
  primary?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div>
      <button
        type="button"
        disabled={busy}
        className={primary ? btn.primary : btn.secondary}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const r = await apiCall<{ id: string }>("/api/carts/evaluate", "POST", { permission_id: permissionId, sku, source });
            router.push(`/permissions/${permissionId}/carts/${r.id}`);
          } catch (err) {
            setError(err instanceof ApiError ? err.message : "Check failed.");
            setBusy(false);
          }
        }}
      >
        {busy ? "Checking…" : "Check against my permission"}
      </button>
      {error && <p className="mt-2 text-xs text-red-700">{error}</p>}
    </div>
  );
}
