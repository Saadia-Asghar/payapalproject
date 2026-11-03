import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { CheckList } from "@/components/CheckList";
import { btn, card } from "@/components/ui";
import { getDb } from "@/server/db/client";
import { publicVerify } from "@/server/services/passports";

async function Result({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await connection();
  const r = await publicVerify(await getDb(), decodeURIComponent(id));
  if (!r.found) {
    return (
      <div className={card}>
        <p className="font-semibold">No Purchase Passport with ID {r.passport_id}.</p>
        <Link href="/verify" className={`${btn.secondary} mt-4`}>
          Try another
        </Link>
      </div>
    );
  }
  return (
    <div className="space-y-6">
      <div className={`rounded-2xl border-2 p-6 ${r.valid ? "border-emerald-300 bg-emerald-50" : "border-red-300 bg-red-50"}`}>
        <p className="text-xs font-bold uppercase tracking-wider text-[var(--muted)]">{r.passport_id} · server-verified</p>
        <h1 className="mt-2 text-xl font-semibold">{r.valid ? "✓ Valid — records are intact and consistent" : "✗ Verification failed — records do not match"}</h1>
      </div>
      <div className={card}>
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          {Object.entries({
            Issued: r.summary.issued_at,
            Permission: r.summary.policy,
            Merchant: r.summary.merchant,
            Amount: r.summary.amount,
            Payment: r.summary.payment,
            "Cart verdict": r.summary.verdict,
            "Buyer approval": r.summary.assurance === "PASSKEY_VERIFIED" ? "Signed with the buyer's passkey (terms and exact cart)" : "Application-signed (no passkey)",
          }).map(([k, v]) => (
            <div key={k}>
              <dt className="text-[var(--muted)]">{k}</dt>
              <dd className="font-medium">{v}</dd>
            </div>
          ))}
        </dl>
        <h2 className="mt-6 text-sm font-semibold">Checks</h2>
        <div className="mt-2">
          <CheckList checks={r.checks} />
        </div>
      </div>
      <p className="text-xs text-[var(--muted)]">Personal details, products and addresses are intentionally not shown on this public page.</p>
    </div>
  );
}

export default function PublicVerifyPage({ params }: PageProps<"/verify/[id]">) {
  return (
    <div className="mx-auto max-w-3xl">
      <Suspense fallback={<div className="h-64 animate-pulse rounded-2xl bg-[var(--surface-2)]" />}>
        <Result params={params} />
      </Suspense>
    </div>
  );
}
