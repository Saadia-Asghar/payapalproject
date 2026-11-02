// Agent shopping screen: the demo agent suggests products; every check is decided by the server.
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { CheckCartButton } from "@/components/CheckCartButton";
import { btn, card } from "@/components/ui";
import { VerdictBadge } from "@/components/verdict";
import { suggestProducts } from "@/lib/policy/agent";
import { formatMoney } from "@/lib/permissions/summary";
import { getSessionUser } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { listCatalog, loadActiveVersion, previewEvaluations } from "@/server/services/carts";
import { ServiceError } from "@/server/services/permissions";

async function Shop({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSessionUser();
  if (!session) redirect(`/login?next=/permissions/${id}/shop`);
  const db = await getDb();
  const active = await loadActiveVersion(db, session.user.id, id).catch((e) => {
    if (e instanceof ServiceError && e.code === "NOT_FOUND") notFound();
    throw e;
  });
  const { terms } = active;
  const catalog = await listCatalog(db);
  const previews = await previewEvaluations(db, active.versionId, terms, catalog);
  const picks = suggestProducts(terms, catalog);
  const bySku = Object.fromEntries(catalog.map((p) => [p.sku, p]));
  const usable = !previews[catalog[0]?.sku]?.mismatchCodes.includes("PERMISSION_STATUS");

  return (
    <div className="space-y-8">
      <div>
        <p className="text-xs font-bold uppercase tracking-wider text-[var(--accent)]">
          Agent shopping · {terms.policy_id} v{terms.version}
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Find {terms.product.type} within your permission</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          The agent only suggests products. The server builds each cart from the trusted catalog and checks it against the
          version you approved — limit {formatMoney(terms.max_total.value, terms.max_total.currency)} total.
        </p>
      </div>

      {!usable && (
        <p role="alert" className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-800">
          This permission can no longer be used, so every cart will be blocked.{" "}
          <Link href={`/permissions/${id}`} className="font-semibold underline">
            View permission
          </Link>
        </p>
      )}

      <section className="space-y-3">
        <div>
          <h2 className="text-base font-semibold">Agent&apos;s picks</h2>
          <p className="text-sm text-[var(--muted)]">
            Demo agent (rule-based ranking on structured attributes). Like any agent it can be wrong — that is what the check is for.
          </p>
        </div>
        <ol className="grid gap-3 md:grid-cols-2">
          {picks.map((s, i) => {
            const p = bySku[s.sku];
            return (
              <li key={s.sku} className={`${card} flex flex-col gap-3 p-5`}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold text-[var(--muted)]">#{i + 1}</p>
                    <p className="font-semibold">{p.title}</p>
                    <p className="text-xs text-[var(--muted)]">
                      {p.merchant_name} · <span className="font-mono">{p.merchant_id}</span>
                    </p>
                  </div>
                  <VerdictBadge verdict={previews[s.sku].verdict} preview />
                </div>
                <ul className="flex flex-wrap gap-1.5">
                  {s.reasons.map((r) => (
                    <li key={r} className="rounded-full bg-[var(--surface-2)] px-2 py-0.5 text-xs">
                      {r}
                    </li>
                  ))}
                </ul>
                <div className="mt-auto flex items-center justify-between gap-3">
                  <span className="text-sm font-semibold">${previews[s.sku].total} total</span>
                  <CheckCartButton permissionId={id} sku={s.sku} source="AGENT" primary={i === 0} />
                </div>
              </li>
            );
          })}
        </ol>
      </section>

      <section className={card}>
        <h2 className="text-base font-semibold">Whole demo catalog</h2>
        <p className="mt-1 text-sm text-[var(--muted)]">Try any cart the agent could propose — wrong size, over budget, look-alike seller, subscription…</p>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-[var(--muted)]">
              <tr>
                <th className="py-2 pr-3 font-semibold">Product</th>
                <th className="py-2 pr-3 font-semibold">Seller ID</th>
                <th className="py-2 pr-3 font-semibold">Final total</th>
                <th className="py-2 pr-3 font-semibold">Preview</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--line)]">
              {catalog.map((p) => (
                <tr key={p.sku}>
                  <td className="py-2.5 pr-3">{p.title}</td>
                  <td className="py-2.5 pr-3 font-mono text-xs">{p.merchant_id}</td>
                  <td className="py-2.5 pr-3">${previews[p.sku].total}</td>
                  <td className="py-2.5 pr-3">
                    <VerdictBadge verdict={previews[p.sku].verdict} preview />
                  </td>
                  <td className="py-2.5 text-right">
                    <CheckCartButton permissionId={id} sku={p.sku} source="BUYER_PICK" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <Link href={`/permissions/${id}`} className={btn.ghost}>
        ← Back to permission
      </Link>
    </div>
  );
}

export default function ShopPage({ params }: PageProps<"/permissions/[id]/shop">) {
  return (
    <Suspense fallback={<div className="h-96 animate-pulse rounded-2xl bg-[var(--surface-2)]" />}>
      <Shop params={params} />
    </Suspense>
  );
}
