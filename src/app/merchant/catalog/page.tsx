// Merchant catalog: edit trusted prices, fees and stock. Changes invalidate earlier cart checks.
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { ProductEditor } from "@/components/ProductEditor";
import { btn, card } from "@/components/ui";
import { getSessionUser } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { listOwnCatalog } from "@/server/services/catalog";

async function Catalog() {
  const session = await getSessionUser();
  if (!session) redirect("/login?next=/merchant/catalog");
  if (session.user.role !== "MERCHANT") redirect("/permissions");
  const products = await listOwnCatalog(await getDb(), session.user.id);
  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs font-bold uppercase tracking-wider text-[var(--accent)]">Merchant catalog</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Trusted prices and stock</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          CartWitness builds every cart from these values. If you change a price, fee or stock level after a buyer approved a cart, that
          approval no longer matches and the buyer must check again before paying.
        </p>
      </div>
      <section className={card}>
        <ul className="divide-y divide-[var(--line)]">
          {products.map((p) => (
            <li key={p.sku} className="flex flex-wrap items-end justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">{p.title}</p>
                <p className="font-mono text-xs text-[var(--muted)]">
                  {p.sku} · tax {(p.tax_rate_bps / 100).toFixed(2)}%
                </p>
              </div>
              <ProductEditor sku={p.sku} price={p.price} shipping={p.shipping} stock={p.stock} />
            </li>
          ))}
        </ul>
      </section>
      <Link href="/merchant" className={btn.ghost}>
        ← Workspace
      </Link>
    </div>
  );
}

export default function CatalogPage() {
  return (
    <Suspense fallback={<div className="h-96 animate-pulse rounded-2xl bg-[var(--surface-2)]" />}>
      <Catalog />
    </Suspense>
  );
}
