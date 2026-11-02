"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { apiCall, ApiError } from "./api-client";
import { btn, input, label } from "./ui";

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const res = await apiCall<{ role: string }>("/api/auth/login", "POST", { email: form.get("email"), password: form.get("password") });
      const next = params.get("next");
      // Only same-site relative paths, never an open redirect.
      const { role } = res;
      router.push(next && next.startsWith("/") && !next.startsWith("//") ? next : role === "MERCHANT" ? "/merchant" : "/permissions");
      router.refresh();
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
        <input id="email" name="email" type="email" autoComplete="username" required className={`${input} mt-1`} />
      </div>
      <div>
        <label htmlFor="password" className={label}>
          Password
        </label>
        <input id="password" name="password" type="password" autoComplete="current-password" required className={`${input} mt-1`} />
      </div>
      {error && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </p>
      )}
      <button type="submit" disabled={busy} className={`${btn.primary} w-full`}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
