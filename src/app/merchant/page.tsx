// Merchant workspace: every cart checked against this merchant's store, plus sample disputes.
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { OpenSampleDisputeForm } from "@/components/DisputeForms";
import { badge, card } from "@/components/ui";
import { VerdictBadge } from "@/components/verdict";
import { getSessionUser } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { DISPUTE_REASONS, listDisputes, listMerchantActivity } from "@/server/services/disputes";

async function Workspace() {
  const session = await getSessionUser();
  if (!session) redirect("/login?next=/merchant");
  if (session.user.role !== "MERCHANT") redirect("/permissions");
  const db = await getDb();
  const [activity, disputes] = await Promise.all([listMerchantActivity(db, session.user.id), listDisputes(db, session.user.id)]);
  const counts = { ALLOW: 0, REVIEW: 0, BLOCK: 0 };
  for (const a of activity) counts[a.verdict]++;

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs font-bold uppercase tracking-wider text-[var(--accent)]">Merchant workspace · {session.user.display_name}</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Agent purchases checked against buyer permissions</h1>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        {(Object.keys(counts) as (keyof typeof counts)[]).map((v) => (
          <div key={v} className={`${card} p-5`}>
            <VerdictBadge verdict={v} />
            <p className="mt-2 text-2xl font-semibold">{counts[v]}</p>
            <p className="text-xs text-[var(--muted)]">cart checks</p>
          </div>
        ))}
      </div>

      <section className={card}>
        <h2 className="text-base font-semibold">Cart checks</h2>
        <p className="mt-1 text-sm text-[var(--muted)]">Blocked attempts never reached checkout. Payments appear once PayPal checkout is connected.</p>
        {activity.length === 0 ? (
          <p className="mt-4 text-sm text-[var(--muted)]">No carts have been checked against your store yet.</p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-[var(--muted)]">
                <tr>
                  <th className="py-2 pr-3 font-semibold">Verdict</th>
                  <th className="py-2 pr-3 font-semibold">Item</th>
                  <th className="py-2 pr-3 font-semibold">Total</th>
                  <th className="py-2 pr-3 font-semibold">Permission</th>
                  <th className="py-2 pr-3 font-semibold">Payment</th>
                  <th className="py-2 font-semibold">Dispute</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--line)]">
                {activity.map((a) => (
                  <tr key={a.id}>
                    <td className="py-2.5 pr-3">
                      <VerdictBadge verdict={a.verdict} />
                      {a.mismatch_codes.length > 0 && <p className="mt-1 text-xs text-[var(--muted)]">{a.mismatch_codes.join(", ")}</p>}
                    </td>
                    <td className="py-2.5 pr-3">{a.title}</td>
                    <td className="py-2.5 pr-3">${a.total}</td>
                    <td className="py-2.5 pr-3 font-mono text-xs">
                      {a.policy_id} v{a.version}
                    </td>
                    <td className="py-2.5 pr-3 text-xs">
                      {a.passport_id ? (
                        <Link href={`/verify/${a.passport_id}`} className="font-semibold text-[var(--accent)] hover:underline">
                          {a.passport_id}
                        </Link>
                      ) : (
                        (a.payment_status ?? (a.buyer_cart_approved_at ? "Cart approved, unpaid" : "—"))
                      )}
                    </td>
                    <td className="py-2.5">
                      {a.dispute_id ? (
                        <Link href={`/merchant/disputes/${a.dispute_id}`} className="text-xs font-semibold text-[var(--accent)] hover:underline">
                          View case
                        </Link>
                      ) : (
                        <OpenSampleDisputeForm attemptId={a.id} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className={card}>
        <h2 className="text-base font-semibold">Cases</h2>
        {disputes.length === 0 ? (
          <p className="mt-2 text-sm text-[var(--muted)]">No cases yet. Open a sample dispute on any cart above to generate an evidence packet.</p>
        ) : (
          <ul className="mt-3 divide-y divide-[var(--line)] text-sm">
            {disputes.map((d) => (
              <li key={d.id}>
                <Link href={`/merchant/disputes/${d.id}`} className="flex flex-wrap items-center justify-between gap-2 py-2.5 hover:text-[var(--accent)]">
                  <span className="flex items-center gap-3">
                    <span className="font-mono text-xs font-semibold">{d.public_id}</span>
                    <span className={`${badge} bg-amber-100 text-amber-900 ring-amber-200`}>{d.source}</span>
                    {DISPUTE_REASONS[d.reason]}
                  </span>
                  <span className="text-xs text-[var(--muted)]">{d.status}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export default function MerchantPage() {
  return (
    <Suspense fallback={<div className="h-96 animate-pulse rounded-2xl bg-[var(--surface-2)]" />}>
      <Workspace />
    </Suspense>
  );
}
