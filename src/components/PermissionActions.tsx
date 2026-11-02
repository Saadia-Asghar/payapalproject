"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiCall, ApiError } from "./api-client";
import { btn } from "./ui";

export function PermissionActions({ permissionId, policyId, canRevoke, canEdit }: { permissionId: string; policyId: string; canRevoke: boolean; canEdit: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function revoke() {
    if (!window.confirm(`Revoke ${policyId}? The AI will not be able to use it for any future purchase. Payments already completed are not reversed.`)) return;
    setBusy(true);
    try {
      await apiCall(`/api/permissions/${permissionId}/revoke`, "POST");
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not revoke.");
    }
    setBusy(false);
  }

  return (
    <div>
      <div className="flex flex-wrap gap-3">
        <a href="#full-permission" className={btn.secondary}>
          View full permission
        </a>
        {canEdit && (
          <Link href={`/permissions/${permissionId}/edit`} className={btn.secondary}>
            Edit (creates new version)
          </Link>
        )}
        {canRevoke && (
          <button type="button" className={btn.danger} disabled={busy} onClick={() => void revoke()}>
            {busy ? "Revoking…" : "Revoke"}
          </button>
        )}
        {canRevoke && (
          <Link href={`/permissions/${permissionId}/shop`} className={btn.primary}>
            Start shopping
          </Link>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </p>
      )}
    </div>
  );
}
