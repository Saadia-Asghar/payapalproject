import { redirect } from "next/navigation";
import { Suspense } from "react";
import { AddPasskeyButton } from "@/components/PasskeyManager";
import { card } from "@/components/ui";
import { getSessionUser } from "@/server/auth/session";
import { listPasskeys } from "@/server/auth/webauthn";
import { getDb } from "@/server/db/client";

async function Passkeys() {
  const session = await getSessionUser();
  if (!session) redirect("/login?next=/account");
  const keys = await listPasskeys(await getDb(), session.user.id);
  return (
    <div className="space-y-6">
      <section className={card}>
        <p className="text-sm text-[var(--muted)]">Signed in as</p>
        <p className="font-semibold">{session.user.display_name}</p>
        <p className="font-mono text-xs text-[var(--muted)]">{session.user.email}</p>
      </section>
      <section className={`${card} space-y-4`}>
        <div>
          <h2 className="text-base font-semibold">Passkeys</h2>
          <p className="mt-1 text-sm text-[var(--muted)]">
            With a passkey, every permission and cart approval is signed by your device over a fingerprint of exactly what you
            approved. The signature is stored in the record and re-checked in your Purchase Passport, so it shows the approval
            came from your passkey and not just from a signed-in browser. Your device keeps the private key; CartWitness stores
            only the public key.
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
        {session.user.email.startsWith("demo-buyer-") && (
          <p className="text-xs text-[var(--muted)]">
            This is a private demo account with no password. Add a passkey if you want to sign back in to it later.
          </p>
        )}
      </section>
    </div>
  );
}

export default function AccountPage() {
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Account</h1>
      <Suspense fallback={<div className="h-64 animate-pulse rounded-2xl bg-[var(--surface-2)]" />}>
        <Passkeys />
      </Suspense>
    </div>
  );
}
