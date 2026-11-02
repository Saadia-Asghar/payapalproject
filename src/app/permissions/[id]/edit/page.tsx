import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { PermissionFormLoader } from "@/components/PermissionFormLoader";
import { btn, card } from "@/components/ui";
import type { TermsFormValues } from "@/lib/permissions/terms";
import { getSessionUser } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { formValuesFromApproved, getPermissionDetail, listMerchants, ServiceError } from "@/server/services/permissions";

async function EditForm({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSessionUser();
  if (!session) redirect(`/login?next=/permissions/${id}/edit`);
  const db = await getDb();
  const detail = await getPermissionDetail(db, session.user.id, id).catch((e) => {
    if (e instanceof ServiceError && e.code === "NOT_FOUND") notFound();
    throw e;
  });
  const { permission, active } = detail;

  if (permission.status === "REVOKED" || permission.status === "CONSUMED") {
    return (
      <div>
        <p className="text-sm">
          {permission.public_id} is {permission.status.toLowerCase()} and can’t be edited. Create a new permission instead.
        </p>
        <Link href="/permissions" className={`${btn.secondary} mt-4`}>
          Back to permissions
        </Link>
      </div>
    );
  }

  const initial = (permission.draft_json as Partial<TermsFormValues> | null) ?? (active ? formValuesFromApproved(active.terms) : null);
  return (
    <PermissionFormLoader
      permissionId={permission.id}
      policyId={permission.public_id}
      nextVersion={(permission.active_version ?? 0) + 1}
      initial={initial}
      merchants={await listMerchants(db)}
    />
  );
}

export default function EditPermissionPage({ params }: PageProps<"/permissions/[id]/edit">) {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <p className="text-xs font-bold uppercase tracking-wider text-[var(--accent)]">Step 1 of 2 · Your shopping rules</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">What can your AI buy?</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">Nothing here is active until you review and approve it on the next screen.</p>
      </div>
      <div className={card}>
        <Suspense fallback={<div className="h-96 animate-pulse rounded-2xl bg-[var(--surface-2)]" />}>
          <EditForm params={params} />
        </Suspense>
      </div>
    </div>
  );
}
