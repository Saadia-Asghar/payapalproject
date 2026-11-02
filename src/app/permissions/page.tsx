import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { NewPermissionButton } from "@/components/NewPermissionButton";
import { badge, card, statusBadge } from "@/components/ui";
import { formatMoney } from "@/lib/permissions/summary";
import { getSessionUser } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { listPermissions } from "@/server/services/permissions";

async function PermissionList() {
  const session = await getSessionUser();
  if (!session) redirect("/login?next=/permissions");
  const rows = await listPermissions(await getDb(), session.user.id);

  if (!rows.length) {
    return (
      <div className={`${card} text-center`}>
        <h2 className="font-semibold">No permissions yet</h2>
        <p className="mt-1 text-sm text-[var(--muted)]">Create one to tell your AI shopping assistant exactly what it may buy.</p>
        <div className="mt-5">
          <NewPermissionButton label="Create your first permission" />
        </div>
      </div>
    );
  }

  return (
    <ul className="space-y-3">
      {rows.map((p) => {
        const href = p.status === "DRAFT" && !p.active_version ? `/permissions/${p.id}/edit` : `/permissions/${p.id}`;
        return (
          <li key={p.id}>
            <Link href={href} className={`${card} block p-5 transition hover:border-[var(--accent)]`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-3">
                  <span className="font-mono text-sm font-semibold">{p.public_id}</span>
                  <span className={`${badge} ${statusBadge[p.effective_status]}`}>{p.effective_status}</span>
                  {p.active_version && <span className="text-xs text-[var(--muted)]">v{p.active_version}</span>}
                  {p.draft_json && p.active_version && <span className="text-xs font-medium text-amber-700">unapproved edits</span>}
                </div>
                {p.max_total && <span className="text-sm font-semibold">≤ {formatMoney(p.max_total, "USD")}</span>}
              </div>
              <p className="mt-2 line-clamp-2 text-sm text-[var(--muted)]">{p.summary_text ?? "Draft — not approved. Continue filling out the form."}</p>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export default function PermissionsPage() {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">My purchase permissions</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">Each permission is versioned. Approved versions can never be rewritten.</p>
        </div>
        <NewPermissionButton />
      </div>
      <Suspense fallback={<div className="h-40 animate-pulse rounded-2xl bg-[var(--surface-2)]" />}>
        <PermissionList />
      </Suspense>
    </div>
  );
}
