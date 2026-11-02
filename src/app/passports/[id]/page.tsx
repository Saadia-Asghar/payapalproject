// Buyer's Purchase Passport: what was approved, what was paid, and every integrity check.
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { CheckList } from "@/components/CheckList";
import { btn, card } from "@/components/ui";
import { getSessionUser } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { getPassportForOwner } from "@/server/services/passports";
import { ServiceError } from "@/server/services/permissions";

async function Passport({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSessionUser();
  if (!session) redirect(`/login?next=/passports/${id}`);
  const p = await getPassportForOwner(await getDb(), session.user.id, id).catch((e) => {
    if (e instanceof ServiceError && e.code === "NOT_FOUND") notFound();
    throw e;
  });
  const b = p.bundle;
  const rows: [string, string][] = [
    ["Passport ID", b.passport_id],
    ["Permission", `${b.permission.policy_id} / v${b.permission.version}`],
    ["Terms fingerprint", b.permission.terms_hash],
    ["Cart fingerprint", b.cart.cart_hash],
    ["Policy verdict", b.cart.verdict],
    ["Buyer approved this cart", b.cart.buyer_cart_approved_at],
    ["Merchant", `${b.merchant.display_name} (${b.merchant.id})`],
    ["PayPal order", b.payment.paypal_order_id],
    ["PayPal capture", b.payment.paypal_capture_id],
    ["Captured amount", `${b.payment.amount} ${b.payment.currency} (${b.payment.environment})`],
    ["Reconciliation key", b.payment.reconciliation_key],
    ["Issued", b.issued_at],
  ];
  return (
    <div className="space-y-6">
      <div className={`rounded-2xl border-2 p-6 ${p.valid ? "border-emerald-300 bg-emerald-50" : "border-red-300 bg-red-50"}`}>
        <p className="text-xs font-bold uppercase tracking-wider text-[var(--muted)]">Purchase Passport · application-signed</p>
        <h1 className="mt-2 text-xl font-semibold">{p.valid ? `✓ ${b.passport_id} verifies` : `✗ ${b.passport_id} failed verification`}</h1>
      </div>
      <section className={card}>
        <dl className="divide-y divide-[var(--line)] text-sm">
          {rows.map(([k, v]) => (
            <div key={k} className="grid gap-1 py-2 sm:grid-cols-[200px_1fr]">
              <dt className="text-[var(--muted)]">{k}</dt>
              <dd className="break-all font-medium">{v}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section className={card}>
        <h2 className="text-base font-semibold">Proof checks</h2>
        <div className="mt-3">
          <CheckList checks={p.checks} />
        </div>
        <div className="mt-5 flex flex-wrap gap-3">
          <a href={`/api/passports/${b.passport_id}?download=1`} className={btn.secondary}>
            Download proof bundle (JSON)
          </a>
          <Link href={`/verify/${b.passport_id}`} className={btn.secondary}>
            Public verification page
          </Link>
          <Link href="/verify" className={btn.ghost}>
            Tamper test: paste an edited bundle →
          </Link>
        </div>
      </section>
    </div>
  );
}

export default function PassportPage({ params }: PageProps<"/passports/[id]">) {
  return (
    <div className="mx-auto max-w-3xl">
      <Suspense fallback={<div className="h-96 animate-pulse rounded-2xl bg-[var(--surface-2)]" />}>
        <Passport params={params} />
      </Suspense>
    </div>
  );
}
