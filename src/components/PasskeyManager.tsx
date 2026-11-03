"use client";
import { useRouter } from "next/navigation";
import { useState, useSyncExternalStore } from "react";
import { ApiError } from "./api-client";
import { passkeyErrorMessage, passkeysSupported, registerPasskey } from "./passkeys";
import { btn } from "./ui";

const noop = () => () => {};

export function AddPasskeyButton({ first }: { first: boolean }) {
  const router = useRouter();
  const supported = useSyncExternalStore(noop, passkeysSupported, () => false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  if (!supported) return <p className="text-sm text-amber-800">This browser does not support passkeys. Try a current Chrome, Safari, Edge or Firefox.</p>;
  return (
    <div className="space-y-3">
      <button
        type="button"
        disabled={busy}
        className={first ? btn.primary : btn.secondary}
        onClick={async () => {
          setBusy(true);
          setMessage(null);
          try {
            const p = await registerPasskey();
            setMessage({ ok: true, text: `Added “${p.label}”. Approvals on this account now require a passkey.` });
            router.refresh();
          } catch (err) {
            setMessage({ ok: false, text: err instanceof ApiError ? err.message : passkeyErrorMessage(err) });
          }
          setBusy(false);
        }}
      >
        {busy ? "Waiting for your device…" : first ? "🔐 Create a passkey" : "Add another passkey"}
      </button>
      {message && (
        <p role={message.ok ? "status" : "alert"} className={`rounded-lg px-3 py-2 text-sm ${message.ok ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-800"}`}>
          {message.text}
        </p>
      )}
    </div>
  );
}
