import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { PasswordForm, SignOutOthersButton } from "@/components/AccountSecurity";
import { AddPasskeyButton } from "@/components/PasskeyManager";
import { btn, card } from "@/components/ui";
import { getSessionUser } from "@/server/auth/session";
import { listPasskeys } from "@/server/auth/webauthn";
import { getDb } from "@/server/db/client";
import { accountSummary } from "@/server/services/accounts";

async function Account({ searchParams }: { searchParams: Promise<{ welcome?: string }> }) {
  const session = await getSessionUser();
  if (!session) redirect("/login?next=/account");
  const { welcome } = await searchParams;
  const db = await getDb();
  const [keys, summary] = await Promise.all([listPasskeys(db, session.user.id), accountSummary(db, session.user.id)]);
  const isBuyer = session.user.role === "BUYER";

  return (
    <div className="space-y-6">
      {welcome && isBuyer && (
        <section className="rounded-2xl border-2 border-[var(--accent)] bg-[var(--accent-soft)] p-6">
          <h2 className="text-lg font-semibold">Welcome, {session.user.display_name.split(" ")[0]} 👋</h2>
          <p className="mt-1 text-sm">Your account is ready. Two quick steps:</p>
          <ol className="mt-3 space-y-2 text-sm">
            <li className={keys.length ? "text-emerald-800" : ""}>
              {keys.length ? "✓" : "1."} <strong>Add a passkey</strong> (below) — your device will sign every approval, so it is provably yours.
            </li>
            <li>
              2. <strong>Create your first purchase permission</strong> — tell your AI assistant exactly what it may buy.
            </li>
          </ol>
          <Link href="/permissions" className={`${btn.primary} mt-4`}>
            {keys.length ? "Create your first permission →" : "Skip for now → permissions"}
          </Link>
        </section>
      )}

      <section className={card}>
        <p className="text-sm text-[var(--muted)]">Signed in as</p>
        <p className="font-semibold">{session.user.display_name}</p>
        <p className="font-mono text-xs text-[var(--muted)]">{session.user.email}</p>
        {summary.is_demo && <p className="mt-2 text-xs text-amber-800">This is a private demo account. Set a password or add a passkey to sign back in later.</p>}
      </section>

      <section className={`${card} space-y-4`}>
        <div>
          <h2 className="text-base font-semibold">Passkeys</h2>
          <p className="mt-1 text-sm text-[var(--muted)]">
            With a passkey, every permission and cart approval is signed by your device over a fingerprint of exactly what you
            approved. The signature is stored in the record and re-checked in your Purchase Passport, so it shows the approval
            came from your passkey and not just from a signed-in browser. Your device keeps the private key; CartWitness stores
            only the public key. You can also sign in with it.
          </p>
        </div>
        {keys.length > 0 && (
          <ul className="divide-y divide-[var(--line)] rounded-lg border border-[var(--line)]">
            {keys.map((k) => (
              <li key={k.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
                <span className="font-medium">🔐 {k.label}</span>
                <span className="text-xs text-[var(--muted)]">
                  added {new Date(k.created_at).toISOString().slice(0, 10)}
                  {k.last_used_at ? ` · last used ${new Date(k.last_used_at).toISOString().slice(0, 16).replace("T", " ")} UTC` : " · not used yet"}
                </span>
              </li>
            ))}
          </ul>
        )}
        <AddPasskeyButton first={keys.length === 0} />
      </section>

      <section className={`${card} space-y-4`}>
        <h2 className="text-base font-semibold">Password</h2>
        <PasswordForm hasPassword={summary.has_password} email={session.user.email} />
      </section>

      <section className={`${card} space-y-3`}>
        <h2 className="text-base font-semibold">Sessions</h2>
        <SignOutOthersButton sessions={summary.sessions} />
      </section>
    </div>
  );
}

export default function AccountPage(props: { searchParams: Promise<{ welcome?: string }> }) {
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Account</h1>
      <Suspense fallback={<div className="h-64 animate-pulse rounded-2xl bg-[var(--surface-2)]" />}>
        <Account searchParams={props.searchParams} />
      </Suspense>
    </div>
  );
}
