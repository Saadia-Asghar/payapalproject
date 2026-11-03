// Setup status: which features are configured on this server. Shows yes/no only — never values.
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { btn, card } from "@/components/ui";
import { aiConfigured } from "@/server/ai/draft";
import { getDb } from "@/server/db/client";
import { paypalConfigured } from "@/server/paypal/client";

async function Status() {
  await connection();
  let dbOk = false;
  let demoAccounts = 0;
  try {
    const db = await getDb();
    const [r] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM users WHERE email LIKE '%@demo.cartwitness.test'");
    dbOk = true;
    demoAccounts = r.n;
  } catch {
    dbOk = false;
  }
  const paypal = paypalConfigured();
  const items = [
    { ok: dbOk, required: true, label: "Database", detail: dbOk ? (process.env.DATABASE_URL ? "PostgreSQL" : "Embedded (local development)") : "Not reachable — check DATABASE_URL" },
    { ok: demoAccounts >= 2, required: true, label: "Demo accounts", detail: demoAccounts >= 2 ? "buyer@ and merchant@demo.cartwitness.test" : "Run npm run setup (or npm run db:seed)" },
    {
      ok: !!process.env.CW_SIGNING_PRIVATE_KEY,
      required: true,
      label: "Signing key",
      detail: process.env.CW_SIGNING_PRIVATE_KEY ? "From CW_SIGNING_PRIVATE_KEY" : "Using a development key in .data/ (set CW_SIGNING_PRIVATE_KEY for production)",
    },
    { ok: paypal, required: true, label: "PayPal sandbox checkout", detail: paypal ? "Ready" : "Add PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and NEXT_PUBLIC_PAYPAL_CLIENT_ID" },
    { ok: !!process.env.PAYPAL_WEBHOOK_ID, required: false, label: "PayPal webhooks", detail: process.env.PAYPAL_WEBHOOK_ID ? "Ready" : "Optional: PAYPAL_WEBHOOK_ID (needs a public HTTPS URL)" },
    {
      ok: aiConfigured(),
      required: false,
      label: "Claude form suggestions",
      detail: aiConfigured() ? `Ready (${process.env.CW_AI_MODEL || "claude-opus-5-5"})` : "Optional: ANTHROPIC_API_KEY — a rule-based parser is used meanwhile",
    },
  ];
  return (
    <ul className="divide-y divide-[var(--line)]">
      {items.map((i) => (
        <li key={i.label} className="flex items-start gap-3 py-3 text-sm">
          <span aria-hidden className={`mt-0.5 font-bold ${i.ok ? "text-emerald-700" : i.required ? "text-amber-700" : "text-[var(--muted)]"}`}>
            {i.ok ? "✓" : i.required ? "!" : "·"}
          </span>
          <span>
            <span className="font-medium">{i.label}</span>
            <span className="sr-only">{i.ok ? " — configured" : " — not configured"}</span>
            <span className="block text-xs text-[var(--muted)]">{i.detail}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

export default function SetupPage() {
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Setup status</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">What is configured on this server. Values are never shown.</p>
      </div>
      <section className={card}>
        <Suspense fallback={<div className="h-48 animate-pulse rounded-xl bg-[var(--surface-2)]" />}>
          <Status />
        </Suspense>
      </section>
      <section className={`${card} text-sm`}>
        <h2 className="font-semibold">Getting PayPal sandbox keys</h2>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-[var(--muted)]">
          <li>Sign in at developer.paypal.com → Apps &amp; Credentials → Sandbox → Create App.</li>
          <li>Copy the Client ID into PAYPAL_CLIENT_ID and NEXT_PUBLIC_PAYPAL_CLIENT_ID, and the Secret into PAYPAL_CLIENT_SECRET (in .env.local or your host).</li>
          <li>Use a sandbox personal account (Testing Tools → Sandbox Accounts) to pay in the PayPal window.</li>
          <li>Restart the server. This page turns green when checkout is ready.</li>
        </ol>
      </section>
      <Link href="/" className={btn.ghost}>
        ← Home
      </Link>
    </div>
  );
}
