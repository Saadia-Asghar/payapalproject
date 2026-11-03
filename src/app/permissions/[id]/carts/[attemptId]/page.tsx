// Recorded cart check: "What you allowed / What AI selected", verdict, and next step.
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { CartApproveButton } from "@/components/CartApproveButton";
import { PayPalCheckout } from "@/components/PayPalCheckout";
import { btn, card } from "@/components/ui";
import { RuleStatusIcon, VERDICT_STYLE } from "@/components/verdict";
import { formatDeadline } from "@/lib/permissions/summary";
import { getSessionUser } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { getAttemptDetail } from "@/server/services/carts";
import { getPaymentForAttempt } from "@/server/services/payments";
import { ServiceError } from "@/server/services/permissions";

function Check({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${ok ? "text-emerald-700" : "text-red-700"}`}>
      <span aria-hidden>{ok ? "✓" : "✗"}</span>
      {label}
    </span>
  );
}

async function CartCheck({ params }: { params: Promise<{ id: string; attemptId: string }> }) {
  const { id, attemptId } = await params;
  const session = await getSessionUser();
  if (!session) redirect(`/login?next=/permissions/${id}/carts/${attemptId}`);
  const db = await getDb();
  const d = await getAttemptDetail(db, session.user.id, attemptId).catch((e) => {
    if (e instanceof ServiceError && e.code === "NOT_FOUND") notFound();
    throw e;
  });
  if (d.permissionId !== id) notFound();
  const payment = await getPaymentForAttempt(db, attemptId);

  const { attempt: a, cart, terms, rules } = d;
  const style = VERDICT_STYLE[a.verdict];
  const line = cart.lines[0];
  const intact = d.integrity.cartIntact && d.integrity.evaluationIntact && d.integrity.signatureValid;
  const approvedAt = a.buyer_cart_approved_at ? new Date(a.buyer_cart_approved_at).toISOString() : null;
  const canApprove = a.verdict === "ALLOW" && !approvedAt && d.stillCurrent && d.permissionUsable.ok;

  return (
    <div className="space-y-6">
      <div className={`rounded-2xl border-2 p-6 ${style.panel}`}>
        <p className="text-xs font-bold uppercase tracking-wider text-[var(--muted)]">
          Cart check · {terms.policy_id} v{terms.version} · {a.source === "AGENT" ? "proposed by agent" : "picked by you"}
        </p>
        <h1 className="mt-2 text-xl font-semibold">{style.title}</h1>
        <p className="mt-1 text-sm">{style.body}</p>
      </div>

      <section className={card}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">{line.title}</h2>
            <p className="text-sm text-[var(--muted)]">
              {cart.merchant.display_name} · <span className="font-mono text-xs">{cart.merchant.id}</span> · qty {line.quantity}
            </p>
          </div>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
            <dt className="text-[var(--muted)]">Item</dt>
            <dd className="text-right">${cart.subtotal}</dd>
            <dt className="text-[var(--muted)]">Shipping</dt>
            <dd className="text-right">${cart.shipping}</dd>
            <dt className="text-[var(--muted)]">Tax</dt>
            <dd className="text-right">${cart.tax}</dd>
            <dt className="font-semibold">Final total</dt>
            <dd className="text-right font-semibold">
              ${cart.total} {cart.currency}
            </dd>
          </dl>
        </div>

        <div className="mt-6 overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-[var(--muted)]">
              <tr>
                <th className="py-2 pr-3 font-semibold">Rule</th>
                <th className="py-2 pr-3 font-semibold">What you allowed</th>
                <th className="py-2 pr-3 font-semibold">What AI selected</th>
                <th className="py-2 font-semibold">Result</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--line)]">
              {rules.map((r) => (
                <tr key={r.code} className={r.status === "FAIL" ? "bg-red-50/60" : r.status === "REVIEW" ? "bg-amber-50/60" : ""}>
                  <td className="py-2.5 pr-3 font-medium">{r.label}</td>
                  <td className="py-2.5 pr-3">{r.allowed}</td>
                  <td className="py-2.5 pr-3">{r.actual}</td>
                  <td className="py-2.5">
                    <RuleStatusIcon status={r.status} />
                    {r.status !== "PASS" && <p className="mt-0.5 text-xs">{r.message}</p>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {d.untrustedDescription && (
        <section className="rounded-2xl border border-dashed border-[var(--line)] bg-white p-5">
          <p className="text-xs font-bold uppercase tracking-wider text-[var(--muted)]">Seller&apos;s description · untrusted data</p>
          <p className="mt-2 font-mono text-xs text-[var(--muted)]">{d.untrustedDescription}</p>
          <p className="mt-2 text-xs text-[var(--muted)]">Shown for reference only. It is never read as instructions and never affects the verdict.</p>
        </section>
      )}

      <section className={card}>
        {a.verdict === "ALLOW" && approvedAt && (
          <div className="space-y-3">
            <p className="text-sm font-semibold text-emerald-800">
              You approved this exact cart on {formatDeadline(approvedAt, terms.display_timezone)}.
            </p>
            {payment?.passport_id ? (
              <Link href={`/passports/${payment.passport_id}`} className={btn.primary}>
                View Purchase Passport {payment.passport_id}
              </Link>
            ) : (
              <>
                {d.stillCurrent && d.permissionUsable.ok ? (
                  <PayPalCheckout attemptId={a.id} clientId={process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID || null} total={cart.total} />
                ) : (
                  <p className="text-sm text-amber-800">
                    {d.permissionUsable.ok
                      ? "The seller changed this cart since you approved it, so it can't be paid. Run a new check."
                      : `This cart can no longer be paid: ${d.permissionUsable.reason}`}
                  </p>
                )}
                {payment && (
                  <p className="text-xs text-[var(--muted)]">
                    Checkout {payment.reconciliation_key}: {payment.status}.
                  </p>
                )}
              </>
            )}
          </div>
        )}
        {canApprove && (
          <div className="space-y-3">
            <p className="text-sm">
              Approving records that you saw and accepted this exact cart (fingerprint below). You will still approve payment in PayPal.
            </p>
            <CartApproveButton attemptId={a.id} cartHash={a.cart_hash} total={cart.total} />
          </div>
        )}
        {a.verdict === "ALLOW" && !approvedAt && !canApprove && (
          <p className="text-sm text-amber-800">
            {d.permissionUsable.ok
              ? "The seller's price or details changed since this check, so this result no longer applies. Run a new check."
              : `This cart can no longer be approved: ${d.permissionUsable.reason}`}
          </p>
        )}
        {a.verdict === "REVIEW" && (
          <p className="text-sm">
            To accept this difference, edit your permission and approve a new version, then check again. Your current version stays unchanged.
          </p>
        )}
        {a.verdict === "BLOCK" && <p className="text-sm">No order will be created. Choose another product, or change your permission if your needs changed.</p>}
        <div className="mt-4 flex flex-wrap gap-3">
          <Link href={`/permissions/${id}/shop`} className={btn.secondary}>
            Find another product
          </Link>
          {a.verdict !== "ALLOW" && (
            <Link href={`/permissions/${id}/edit`} className={btn.secondary}>
              Change permission
            </Link>
          )}
        </div>
      </section>

      <section className={`${card} text-xs`}>
        <div className="flex flex-wrap gap-x-5 gap-y-1">
          <Check ok={d.integrity.cartIntact} label="Cart matches its fingerprint" />
          <Check ok={d.integrity.evaluationIntact} label="Verdict and rules unchanged" />
          <Check ok={d.integrity.signatureValid} label="Evaluation signature valid (application-signed)" />
        </div>
        {!intact && <p className="mt-2 font-semibold text-red-700">Tamper detected: this record no longer matches what was evaluated.</p>}
        <p className="mt-3 text-[var(--muted)]">Cart fingerprint</p>
        <p className="break-all font-mono">{a.cart_hash}</p>
      </section>
    </div>
  );
}

export default function CartPage({ params }: PageProps<"/permissions/[id]/carts/[attemptId]">) {
  return (
    <div className="mx-auto max-w-4xl">
      <Suspense fallback={<div className="h-96 animate-pulse rounded-2xl bg-[var(--surface-2)]" />}>
        <CartCheck params={params} />
      </Suspense>
    </div>
  );
}
