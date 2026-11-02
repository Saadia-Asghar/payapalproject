"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiCall, ApiError } from "./api-client";
import { btn } from "./ui";

export function CartApproveButton({ attemptId, cartHash, total }: { attemptId: string; cartHash: string; total: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div>
      <button
        type="button"
        disabled={busy}
        className={btn.primary}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await apiCall(`/api/carts/${attemptId}/approve`, "POST", { cart_hash: cartHash });
            router.refresh();
          } catch (err) {
            setError(err instanceof ApiError ? err.message : "Approval failed.");
          }
          setBusy(false);
        }}
      >
        {busy ? "Approving…" : `Approve this exact cart — $${total} USD`}
      </button>
      {error && (
        <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </p>
      )}
    </div>
  );
}
