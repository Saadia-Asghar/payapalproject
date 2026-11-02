"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiCall, ApiError } from "./api-client";
import { btn, input } from "./ui";

const REASONS = {
  NOT_AUTHORIZED: "I did not approve this purchase",
  WRONG_ITEM: "The item was wrong",
  NOT_RECEIVED: "The item never arrived",
  EXCEEDED_INSTRUCTIONS: "The agent exceeded instructions",
} as const;

export function OpenSampleDisputeForm({ attemptId }: { attemptId: string }) {
  const router = useRouter();
  const [reason, setReason] = useState<keyof typeof REASONS>("NOT_AUTHORIZED");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="sr-only" htmlFor={`reason-${attemptId}`}>
        Dispute reason
      </label>
      <select id={`reason-${attemptId}`} className={`${input} w-auto py-1.5 text-xs`} value={reason} onChange={(e) => setReason(e.target.value as keyof typeof REASONS)}>
        {Object.entries(REASONS).map(([k, v]) => (
          <option key={k} value={k}>
            {v}
          </option>
        ))}
      </select>
      <button
        type="button"
        className={`${btn.secondary} px-3 py-1.5 text-xs`}
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const r = await apiCall<{ id: string }>("/api/disputes/sample", "POST", { attempt_id: attemptId, reason, complaint: REASONS[reason] });
            router.push(`/merchant/disputes/${r.id}`);
          } catch (err) {
            setError(err instanceof ApiError ? err.message : "Could not open case.");
            setBusy(false);
          }
        }}
      >
        {busy ? "Building packet…" : "Open sample dispute"}
      </button>
      {error && <span className="text-xs text-red-700">{error}</span>}
    </div>
  );
}

export function ReviewDisputeForm({ caseId }: { caseId: string }) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div>
      <label htmlFor="note" className="block text-sm font-medium">
        Reviewer note
      </label>
      <textarea id="note" rows={3} className={`${input} mt-1`} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Evidence checked; requested tracking number from warehouse." />
      <button
        type="button"
        className={`${btn.primary} mt-3`}
        disabled={busy || note.trim().length < 3}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await apiCall(`/api/disputes/${caseId}/review`, "POST", { note });
            router.refresh();
          } catch (err) {
            setError(err instanceof ApiError ? err.message : "Could not save review.");
          }
          setBusy(false);
        }}
      >
        {busy ? "Saving…" : "Mark reviewed"}
      </button>
      {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
    </div>
  );
}
