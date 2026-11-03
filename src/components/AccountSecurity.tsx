"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { passwordProblem } from "@/lib/auth/password-rules";
import { apiCall, ApiError } from "./api-client";
import { btn, fieldError, input, label } from "./ui";

function Note({ msg }: { msg: { ok: boolean; text: string } | null }) {
  return msg ? (
    <p role={msg.ok ? "status" : "alert"} className={`rounded-lg px-3 py-2 text-sm ${msg.ok ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-800"}`}>
      {msg.text}
    </p>
  ) : null;
}

/** Change the password (or set a first one on a passwordless account). Other sessions are signed out. */
export function PasswordForm({ hasPassword, email }: { hasPassword: boolean; email: string }) {
  const router = useRouter();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const weak = next ? passwordProblem(next, email) : null;

  return (
    <form
      className="space-y-3"
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        if (weak || !next) return setMsg({ ok: false, text: weak ?? "Enter a new password." });
        setBusy(true);
        setMsg(null);
        try {
          const r = await apiCall<{ otherSessionsEnded: number }>("/api/account/password", "POST", { current: hasPassword ? current : undefined, next });
          setMsg({ ok: true, text: `Password ${hasPassword ? "changed" : "set"}.${r.otherSessionsEnded ? ` Signed out ${r.otherSessionsEnded} other session(s).` : ""}` });
          setCurrent("");
          setNext("");
          router.refresh();
        } catch (err) {
          setMsg({ ok: false, text: err instanceof ApiError ? err.message : "Could not update the password." });
        }
        setBusy(false);
      }}
    >
      {hasPassword && (
        <div>
          <label htmlFor="current" className={label}>
            Current password
          </label>
          <input id="current" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} className={`${input} mt-1`} />
        </div>
      )}
      <div>
        <label htmlFor="next" className={label}>
          {hasPassword ? "New password" : "Set a password"}
        </label>
        <input
          id="next"
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          aria-invalid={!!weak}
          className={`${input} mt-1`}
        />
        {weak && <p className={fieldError}>{weak}</p>}
      </div>
      <Note msg={msg} />
      <button type="submit" disabled={busy} className={btn.secondary}>
        {busy ? "Saving…" : hasPassword ? "Change password" : "Set password"}
      </button>
    </form>
  );
}

export function SignOutOthersButton({ sessions }: { sessions: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <div className="space-y-3">
      <p className="text-sm text-[var(--muted)]">
        {sessions <= 1 ? "You are signed in on this device only." : `Signed in on ${sessions} devices or browsers, including this one.`}
      </p>
      {sessions > 1 && (
        <button
          type="button"
          disabled={busy}
          className={btn.secondary}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await apiCall<{ otherSessionsEnded: number }>("/api/account/sign-out-others", "POST");
              setMsg({ ok: true, text: `Signed out ${r.otherSessionsEnded} other session(s).` });
              router.refresh();
            } catch (err) {
              setMsg({ ok: false, text: err instanceof ApiError ? err.message : "Could not sign out other sessions." });
            }
            setBusy(false);
          }}
        >
          Sign out everywhere else
        </button>
      )}
      <Note msg={msg} />
    </div>
  );
}
