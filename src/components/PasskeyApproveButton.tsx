"use client";
// Approve with the buyer's passkey: the authenticator signs a challenge derived from the exact
// terms/cart. Accounts without a passkey can create one in the same step, or approve with the
// weaker session-only method (clearly labelled), which the server refuses once a passkey exists.
import { useState, useSyncExternalStore } from "react";
import { ApiError } from "./api-client";
import { passkeyErrorMessage, passkeysSupported, registerPasskey, signApproval } from "./passkeys";
import { btn } from "./ui";

export type PasskeyAssertion = Awaited<ReturnType<typeof signApproval>>;

const noop = () => () => {};

export function PasskeyApproveButton(props: {
  label: string;
  hasPasskey: boolean;
  disabled?: boolean;
  optionsUrl: string;
  optionsBody: unknown;
  /** Performs the approval; `passkey` is undefined for a session-only approval. Throw to show an error. */
  onApprove: (passkey: PasskeyAssertion | undefined) => Promise<void>;
}) {
  const supported = useSyncExternalStore(noop, passkeysSupported, () => false);
  const [hasPasskey, setHasPasskey] = useState(props.hasPasskey);
  const [busy, setBusy] = useState<null | "passkey" | "session">(null);
  const [error, setError] = useState<string | null>(null);

  async function run(mode: "passkey" | "session") {
    setBusy(mode);
    setError(null);
    try {
      if (mode === "passkey") {
        if (!hasPasskey) {
          await registerPasskey();
          setHasPasskey(true);
        }
        await props.onApprove(await signApproval(props.optionsUrl, props.optionsBody));
      } else {
        await props.onApprove(undefined);
      }
    } catch (err) {
      if (err instanceof ApiError && err.code === "PASSKEY_REQUIRED") setHasPasskey(true);
      setError(err instanceof ApiError ? err.message : passkeyErrorMessage(err));
    }
    setBusy(null);
  }

  const disabled = props.disabled || busy !== null;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        {supported || hasPasskey ? (
          <button type="button" className={btn.primary} disabled={disabled} onClick={() => void run("passkey")}>
            {busy === "passkey" ? "Waiting for your passkey…" : hasPasskey ? `🔐 ${props.label} with passkey` : `🔐 Create a passkey & ${props.label.toLowerCase()}`}
          </button>
        ) : null}
        {!hasPasskey && (
          <button type="button" className={supported ? btn.secondary : btn.primary} disabled={disabled} onClick={() => void run("session")}>
            {busy === "session" ? "Approving…" : `${props.label} without a passkey`}
          </button>
        )}
      </div>
      <p className="text-xs text-[var(--muted)]">
        {hasPasskey
          ? "Your device signs a fingerprint of exactly this data (Face ID, Touch ID, Windows Hello, PIN or phone). The signature is stored in the record and can be re-verified by anyone."
          : supported
            ? "Recommended: a passkey makes this approval provably yours. Without one, the record is application-signed only."
            : "This browser has no passkey support, so the approval will be application-signed only."}
      </p>
      {error && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </p>
      )}
    </div>
  );
}
