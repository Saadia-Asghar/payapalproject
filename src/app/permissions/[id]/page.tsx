// Screen 3 — permission receipt: status, limits, integrity checks and version history.
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { PermissionActions } from "@/components/PermissionActions";
import { badge, btn, card, statusBadge } from "@/components/ui";
import { termRows } from "@/lib/permissions/present";
import { formatDeadline, formatMoney } from "@/lib/permissions/summary";
import { getSessionUser } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { getPermissionDetail, listMerchants, ServiceError } from "@/server/services/permissions";

const headline: Record<string, string> = {
  ACTIVE: "Permission active",
  EXPIRED: "Permission expired",
  REVOKED: "Permission revoked",
  CONSUMED: "Permission used",
  DRAFT: "Draft — not approved",
};

function Check({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${ok ? "text-emerald-700" : "text-red-700"}`}>
      <span aria-hidden>{ok ? "✓" : "✗"}</span>
      {label}
    </span>
  );
}

const iso = (d: Date | string) => new Date(d).toISOString();

async function Receipt({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const session = await getSessionUser();
  if (!session) redirect(`/login?next=/permissions/${id}`);
  const db = await getDb();
  const detail = await getPermissionDetail(db, session.user.id, id).catch((e) => {
    if (e instanceof ServiceError && e.code === "NOT_FOUND") notFound();
    throw e;
  });
  const { permission: p, active, versions, effectiveStatus } = detail;
  if (!active) redirect(`/permissions/${id}/edit`);

  const merchants = Object.fromEntries((await listMerchants(db)).map((m) => [m.id, m.display_name]));
  const t = active.terms;
  const tz = t.display_timezone;
  const intact = active.integrity.termsIntact && active.integrity.signatureValid;
  const justApproved = typeof sp.approved === "string" ? sp.approved : undefined;

  return (
    <div className="space-y-6">
      {justApproved && (
        <p role="status" className="rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          Version {justApproved} approved and recorded. Your AI can only shop within these terms.
        </p>
      )}

      <div className={`${card} border-2 ${effectiveStatus === "ACTIVE" ? "border-emerald-300" : "border-[var(--line)]"}`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-bold uppercase tracking-wider text-[var(--muted)]">
              {headline[effectiveStatus]} • {p.public_id}
            </p>
            <p className="mt-2 text-3xl font-semibold tracking-tight">≤ {formatMoney(t.max_total.value, t.max_total.currency)}</p>
            <p className="text-sm text-[var(--muted)]">total, including shipping, taxes and fees · one purchase only</p>
          </div>
          <span className={`${badge} ${statusBadge[effectiveStatus]}`}>{effectiveStatus}</span>
        </div>

        <dl className="mt-6 grid gap-4 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-[var(--muted)]">Created</dt>
            <dd className="font-medium">{formatDeadline(iso(p.created_at), tz)}</dd>
          </div>
          <div>
            <dt className="text-[var(--muted)]">Approved (v{active.version})</dt>
            <dd className="font-medium">{formatDeadline(iso(active.approved_at), tz)}</dd>
          </div>
          <div>
            <dt className="text-[var(--muted)]">Expires</dt>
            <dd className="font-medium">{formatDeadline(t.expires_at, tz)}</dd>
          </div>
        </dl>

        {p.revoked_at && <p className="mt-4 text-sm text-red-700">Revoked {formatDeadline(iso(p.revoked_at), tz)}. Future purchases are blocked.</p>}

        <div className="mt-6 flex flex-wrap gap-x-5 gap-y-1 rounded-lg bg-[var(--surface)] px-4 py-3">
          <Check ok={active.integrity.termsIntact} label="Stored terms match their fingerprint" />
          <Check ok={active.integrity.signatureValid} label="Approval signature valid (application-signed)" />
        </div>
        {!intact && <p className="mt-2 text-sm font-semibold text-red-700">Tamper detected: this record no longer matches what was approved.</p>}

        <div className="mt-6">
          <PermissionActions permissionId={p.id} policyId={p.public_id} canRevoke={effectiveStatus === "ACTIVE"} canEdit={p.status === "ACTIVE"} />
        </div>
        {p.draft_json && p.status === "ACTIVE" && (
          <p className="mt-4 text-sm text-amber-800">
            You have unapproved edits for version {(p.active_version ?? 0) + 1}.{" "}
            <Link href={`/permissions/${p.id}/review`} className="font-semibold underline">
              Review them
            </Link>{" "}
            — version {p.active_version} stays in force until you approve.
          </p>
        )}
      </div>

      <section id="full-permission" className={card}>
        <h2 className="text-base font-semibold">Full permission · version {active.version}</h2>
        <p className="mt-3 rounded-lg bg-[var(--surface)] p-4 text-sm leading-relaxed">{active.summary_text}</p>
        <dl className="mt-4 divide-y divide-[var(--line)]">
          {termRows(t, merchants).map((r) => (
            <div key={r.label} className="grid gap-1 py-2.5 text-sm sm:grid-cols-[200px_1fr]">
              <dt className="text-[var(--muted)]">{r.label}</dt>
              <dd className={r.emphasis ? "font-semibold" : ""}>{r.value}</dd>
            </div>
          ))}
        </dl>
        <details className="mt-4 text-sm">
          <summary className="cursor-pointer font-medium text-[var(--accent)]">Approval evidence</summary>
          <dl className="mt-3 space-y-2 text-xs">
            <div>
              <dt className="text-[var(--muted)]">Terms fingerprint</dt>
              <dd className="break-all font-mono">{active.terms_hash}</dd>
            </div>
            <div>
              <dt className="text-[var(--muted)]">Signing key</dt>
              <dd className="font-mono">{active.signing_key_id} (Ed25519, public key at /api/keys)</dd>
            </div>
            <div>
              <dt className="text-[var(--muted)]">Signature</dt>
              <dd className="break-all font-mono">{active.signature}</dd>
            </div>
            <div>
              <dt className="text-[var(--muted)]">Signed approval record</dt>
              <dd>
                <pre className="mt-1 max-h-64 overflow-auto rounded-lg bg-[var(--surface-2)] p-3">{JSON.stringify(JSON.parse(active.approval_record), null, 2)}</pre>
              </dd>
            </div>
          </dl>
          <p className="mt-3 text-xs text-[var(--muted)]">
            Assurance level: application-signed. This shows the record is unchanged since CartWitness signed it after an authenticated
            session approved it; it is not, by itself, cryptographic proof of which person clicked approve.
          </p>
        </details>
      </section>

      {versions.length > 1 && (
        <section className={card}>
          <h2 className="text-base font-semibold">Version history</h2>
          <p className="mt-1 text-sm text-[var(--muted)]">Earlier versions are read-only and remain linked to any shopping attempts made under them.</p>
          <ol className="mt-4 space-y-2 text-sm">
            {versions.map((v) => (
              <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--line)] px-4 py-3">
                <span>
                  <span className="font-semibold">v{v.version}</span> · approved {formatDeadline(iso(v.approved_at), tz)} · ≤{" "}
                  {formatMoney(v.terms.max_total.value, v.terms.max_total.currency)}
                  {v.version === active.version && <span className="ml-2 text-xs font-semibold text-emerald-700">current</span>}
                </span>
                <span className="font-mono text-xs text-[var(--muted)]">{v.terms_hash.slice(0, 23)}…</span>
              </li>
            ))}
          </ol>
        </section>
      )}

      <Link href="/permissions" className={btn.ghost}>
        ← All permissions
      </Link>
    </div>
  );
}

export default function PermissionPage({ params, searchParams }: PageProps<"/permissions/[id]">) {
  return (
    <div className="mx-auto max-w-3xl">
      <Suspense fallback={<div className="h-96 animate-pulse rounded-2xl bg-[var(--surface-2)]" />}>
        <Receipt params={params} searchParams={searchParams} />
      </Suspense>
    </div>
  );
}
