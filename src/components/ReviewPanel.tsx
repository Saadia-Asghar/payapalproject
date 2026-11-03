"use client";
// Screen 2 — "Review exactly what you are allowing".
// Everything shown here comes from the server's review call, including the terms hash
// that the approval must echo back. If the draft changes in between, approval is refused.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { termRows } from "@/lib/permissions/present";
import { CONSENT_KEYS, CONSENT_STATEMENTS, type ApprovedTerms, type ConsentKey, type FieldErrors } from "@/lib/permissions/terms";
import { apiCall, ApiError } from "./api-client";
import { PasskeyApproveButton, type PasskeyAssertion } from "./PasskeyApproveButton";
import { btn, card } from "./ui";

interface Review {
  policyId: string;
  version: number;
  terms: ApprovedTerms;
  canonical: string;
  termsHash: string;
  summary: string;
  merchants: Record<string, string>;
  hasPasskey: boolean;
}

type LoadState = { kind: "loading" } | { kind: "ready"; review: Review } | { kind: "invalid"; errors: FieldErrors; message: string } | { kind: "error"; message: string };

const NO_CONSENTS: Record<ConsentKey, boolean> = { checked_terms: false, ai_may_err: false, no_charge_yet: false };

export function ReviewPanel({ permissionId }: { permissionId: string }) {
  const router = useRouter();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [consents, setConsents] = useState(NO_CONSENTS);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(
    () =>
      apiCall<Review>(`/api/permissions/${permissionId}/review`, "POST").then(
        (review): LoadState => ({ kind: "ready", review }),
        (err): LoadState =>
          err instanceof ApiError && err.code === "INVALID_TERMS"
            ? { kind: "invalid", errors: (err.details as FieldErrors) ?? {}, message: err.message }
            : { kind: "error", message: err instanceof Error ? err.message : "Could not load the review." },
      ),
    [permissionId],
  );

  useEffect(() => {
    let live = true;
    load().then((next) => live && setState(next));
    return () => {
      live = false;
    };
  }, [load]);

  if (state.kind === "loading") return <div className="h-96 animate-pulse rounded-2xl bg-[var(--surface-2)]" />;
  if (state.kind === "error") return <p className="rounded-lg bg-red-50 p-4 text-sm text-red-800">{state.message}</p>;
  if (state.kind === "invalid") {
    return (
      <div className={card}>
        <h2 className="font-semibold text-red-800">This permission can’t be approved yet</h2>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-red-800">
          {Object.entries(state.errors).map(([k, v]) => (
            <li key={k}>{v}</li>
          ))}
        </ul>
        <Link href={`/permissions/${permissionId}/edit`} className={`${btn.primary} mt-5`}>
          ← Back to the form
        </Link>
      </div>
    );
  }

  const { review } = state;
  const allChecked = CONSENT_KEYS.every((k) => consents[k]);

  async function approve(passkey: PasskeyAssertion | undefined) {
    setBusy(true);
    setProblem(null);
    try {
      await apiCall(`/api/permissions/${permissionId}/approve`, "POST", { terms_hash: review.termsHash, consents, passkey });
      router.push(`/permissions/${permissionId}?approved=${review.version}`);
      router.refresh();
    } catch (err) {
      setBusy(false);
      if (err instanceof ApiError && err.code === "TERMS_CHANGED") {
        setProblem("These terms changed since this page loaded. The latest version is shown below — please review it again.");
        setConsents(NO_CONSENTS);
        setState(await load());
        return;
      }
      throw err; // shown by the approve button
    }
  }

  async function cancel() {
    const msg =
      review.version === 1
        ? "Discard this permission? Nothing has been approved yet."
        : `Discard these edits? Version ${review.version - 1} stays active.`;
    if (!window.confirm(msg)) return;
    await apiCall(`/api/permissions/${permissionId}/draft`, "DELETE");
    router.push(review.version === 1 ? "/permissions" : `/permissions/${permissionId}`);
    router.refresh();
  }

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border-2 border-amber-300 bg-amber-50 p-6">
        <p className="text-xs font-bold uppercase tracking-wider text-amber-800">
          Review summary • Not yet approved • {review.policyId} v{review.version}
        </p>
        <p className="mt-3 text-base leading-relaxed text-[var(--ink)]">{review.summary}</p>
      </div>

      <div className={card}>
        <h2 className="text-base font-semibold">Exactly what you are allowing</h2>
        <dl className="mt-4 divide-y divide-[var(--line)]">
          {termRows(review.terms, review.merchants).map((r) => (
            <div key={r.label} className="grid gap-1 py-2.5 text-sm sm:grid-cols-[200px_1fr]">
              <dt className="text-[var(--muted)]">{r.label}</dt>
              <dd className={r.emphasis ? "font-semibold text-[var(--ink)]" : "text-[var(--ink)]"}>{r.value}</dd>
            </div>
          ))}
        </dl>
        <details className="mt-4 text-sm">
          <summary className="cursor-pointer font-medium text-[var(--accent)]">Terms fingerprint and exact signed data</summary>
          <p className="mt-2 text-[var(--muted)]">
            On approval, CartWitness stores this exact data, its SHA-256 fingerprint, your account, the time, and your
            confirmations below, then signs the record. Any later change produces a different fingerprint.
          </p>
          <p className="mt-2 break-all font-mono text-xs">{review.termsHash}</p>
          <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-[var(--surface-2)] p-3 text-xs">{JSON.stringify(JSON.parse(review.canonical), null, 2)}</pre>
        </details>
      </div>

      <fieldset className={card}>
        <legend className="sr-only">Confirm before approving</legend>
        <div className="space-y-3">
          {CONSENT_KEYS.map((k) => (
            <label key={k} className="flex cursor-pointer items-start gap-3 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 accent-[var(--accent)]"
                checked={consents[k]}
                onChange={(e) => setConsents((c) => ({ ...c, [k]: e.target.checked }))}
              />
              <span>{CONSENT_STATEMENTS[k]}</span>
            </label>
          ))}
        </div>
        {problem && (
          <p role="alert" className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
            {problem}
          </p>
        )}
        <div className="mt-6">
          <PasskeyApproveButton
            label="Approve permission"
            hasPasskey={review.hasPasskey}
            disabled={!allChecked || busy}
            optionsUrl={`/api/permissions/${permissionId}/approve/options`}
            optionsBody={{ terms_hash: review.termsHash }}
            onApprove={approve}
          />
        </div>
        <div className="mt-4 flex flex-wrap gap-3">
          <Link href={`/permissions/${permissionId}/edit`} className={btn.secondary}>
            Edit
          </Link>
          <button type="button" className={btn.secondary} disabled={busy} onClick={() => void cancel()}>
            Cancel
          </button>
        </div>
        {!allChecked && <p className="mt-3 text-xs text-[var(--muted)]">Tick all three statements to enable approval.</p>}
      </fieldset>
    </div>
  );
}
