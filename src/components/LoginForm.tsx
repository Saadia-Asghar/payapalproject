"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, useSyncExternalStore } from "react";
import { apiCall, ApiError } from "./api-client";
import { passkeyErrorMessage, passkeysSupported, signInWithPasskey } from "./passkeys";
import { btn, input, label } from "./ui";

function useAfterSignIn() {
  const router = useRouter();
  const params = useSearchParams();
  return (role: string) => {
    const next = params.get("next");
    // Only same-site relative paths, never an open redirect.
    router.push(next && next.startsWith("/") && !next.startsWith("//") ? next : role === "MERCHANT" ? "/merchant" : "/permissions");
    router.refresh();
  };
}

function Alert({ message }: { message: string | null }) {
  return message ? (
    <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
      {message}
    </p>
  ) : null;
}

/** One click, no password: a fresh private buyer, or the shared demo merchant. */
export function DemoSignIn() {
  const after = useAfterSignIn();
  const [busy, setBusy] = useState<null | "BUYER" | "MERCHANT">(null);
  const [error, setError] = useState<string | null>(null);

  async function go(role: "BUYER" | "MERCHANT") {
    setBusy(role);
    setError(null);
    try {
      await apiCall("/api/auth/demo", "POST", { role });
      after(role);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not start the demo.");
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <button type="button" disabled={busy !== null} onClick={() => void go("BUYER")} className={`${btn.primary} flex-col items-start! py-3! text-left`}>
          <span className="font-semibold">{busy === "BUYER" ? "Starting…" : "Try as buyer →"}</span>
          <span className="text-xs font-normal opacity-85">Your own fresh, private account</span>
        </button>
        <button type="button" disabled={busy !== null} onClick={() => void go("MERCHANT")} className={`${btn.secondary} flex-col items-start! py-3! text-left`}>
          <span className="font-semibold">{busy === "MERCHANT" ? "Starting…" : "Try as merchant →"}</span>
          <span className="text-xs font-normal text-[var(--muted)]">Demo Sneaker Store workspace</span>
        </button>
      </div>
      <Alert message={error} />
    </div>
  );
}

const noop = () => () => {};

export function PasskeySignIn() {
  const supported = useSyncExternalStore(noop, passkeysSupported, () => false);
  const after = useAfterSignIn();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!supported) return null;
  return (
    <div className="space-y-3">
      <button
        type="button"
        disabled={busy}
        className={`${btn.secondary} w-full`}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            after((await signInWithPasskey()).role);
          } catch (err) {
            setError(err instanceof ApiError ? err.message : passkeyErrorMessage(err));
            setBusy(false);
          }
        }}
      >
        {busy ? "Waiting for your passkey…" : "🔐 Sign in with a passkey"}
      </button>
      <Alert message={error} />
    </div>
  );
}

export function LoginForm() {
  const after = useAfterSignIn();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const res = await apiCall<{ role: string }>("/api/auth/login", "POST", { email: form.get("email"), password: form.get("password") });
      after(res.role);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not sign in.");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <div>
        <label htmlFor="email" className={label}>
          Email
        </label>
        <input id="email" name="email" type="email" autoComplete="username webauthn" required className={`${input} mt-1`} />
      </div>
      <div>
        <label htmlFor="password" className={label}>
          Password
        </label>
        <input id="password" name="password" type="password" autoComplete="current-password" required className={`${input} mt-1`} />
      </div>
      <Alert message={error} />
      <button type="submit" disabled={busy} className={`${btn.primary} w-full`}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
