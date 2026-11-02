// Dispute case: labelled evidence packet, provided vs missing evidence, and the reviewer step.
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { ReviewDisputeForm } from "@/components/DisputeForms";
import { PrintButton } from "@/components/PrintButton";
import { btn, card } from "@/components/ui";
import { getSessionUser } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { getDispute, type EvidenceStatus } from "@/server/services/disputes";
import { ServiceError } from "@/server/services/permissions";

const STATUS_STYLE: Record<EvidenceStatus, string> = {
  PROVIDED: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  MISSING: "bg-red-50 text-red-700 ring-red-200",
  NOT_APPLICABLE: "bg-slate-100 text-slate-600 ring-slate-200",
};

async function Case({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSessionUser();
  if (!session) redirect(`/login?next=/merchant/disputes/${id}`);
  if (session.user.role !== "MERCHANT") redirect("/permissions");
  const { dispute: d, packet: p, packetIntact } = await getDispute(await getDb(), session.user.id, id).catch((e) => {
    if (e instanceof ServiceError && e.code === "NOT_FOUND") notFound();
    throw e;
  });
  const missing = p.checklist.filter((c) => c.status === "MISSING").length;

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border-2 border-amber-300 bg-amber-50 p-5">
        <p className="text-sm font-bold text-amber-900">{p.notice}</p>
      </div>

      <div>
        <p className="text-xs font-bold uppercase tracking-wider text-[var(--accent)]">
          {p.case_id} · {d.status}
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{p.reason_label}</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          {p.merchant.display_name} · {p.subject.policy_id} v{p.subject.permission_version} · {p.subject.amount} {p.subject.currency} · buyer {p.subject.buyer_ref}
        </p>
      </div>

      <section className={card}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold">Evidence checklist</h2>
          <span className={`text-sm font-semibold ${missing ? "text-red-700" : "text-emerald-700"}`}>
            {missing ? `${missing} item(s) missing` : "All listed evidence provided"}
          </span>
        </div>
        <ul className="mt-4 space-y-3">
          {p.checklist.map((c) => (
            <li key={c.label} className="flex flex-wrap items-start gap-3 text-sm">
              <span className={`inline-flex w-28 shrink-0 justify-center rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset ${STATUS_STYLE[c.status]}`}>
                {c.status}
              </span>
              <span className="min-w-0 flex-1">
                <span className="font-medium">{c.label}</span>
                <span className="block text-xs text-[var(--muted)]">{c.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className={card}>
        <h2 className="text-base font-semibold">Findings</h2>
        <ul className="mt-3 list-disc space-y-1.5 pl-5 text-sm">
          {p.findings.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
        <h2 className="mt-6 text-base font-semibold">Summary</h2>
        <p className="mt-1 text-xs text-[var(--muted)]">Generated from stored records only.</p>
        <div className="mt-2 space-y-2 text-sm">
          {p.narrative.map((n) => (
            <p key={n}>{n}</p>
          ))}
        </div>
      </section>

      <section className={card}>
        <h2 className="text-base font-semibold">Timeline</h2>
        <ol className="mt-3 space-y-1.5 font-mono text-xs">
          {p.timeline.map((t, i) => (
            <li key={`${t.at}-${i}`}>
              <span className="text-[var(--muted)]">{t.at}</span> · {t.event}
            </li>
          ))}
        </ol>
      </section>

      <section className={card}>
        <h2 className="text-base font-semibold">Limitations</h2>
        <ul className="mt-3 list-disc space-y-1.5 pl-5 text-sm text-[var(--muted)]">
          {p.limitations.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
        <p className={`mt-4 text-xs font-medium ${packetIntact ? "text-emerald-700" : "text-red-700"}`}>
          {packetIntact ? "✓ Packet matches its stored fingerprint" : "✗ Packet does not match its stored fingerprint"}
        </p>
      </section>

      <section className={card}>
        <h2 className="text-base font-semibold">Merchant review</h2>
        {d.status === "REVIEWED" ? (
          <p className="mt-2 text-sm">
            Reviewed {d.reviewed_at ? new Date(d.reviewed_at).toISOString() : ""}: {d.reviewer_note}
          </p>
        ) : (
          <div className="mt-3">
            <ReviewDisputeForm caseId={d.id} />
          </div>
        )}
        <div className="no-print mt-5 flex flex-wrap gap-3">
          <PrintButton label="Print / save as PDF" />
          <a href={`/api/disputes/${d.id}/packet`} className={btn.secondary}>
            Export packet (JSON)
          </a>
          <Link href="/merchant" className={btn.ghost}>
            ← Workspace
          </Link>
        </div>
        <p className="mt-3 text-xs text-[var(--muted)]">Nothing is submitted to PayPal from CartWitness.</p>
      </section>
    </div>
  );
}

export default function DisputePage({ params }: PageProps<"/merchant/disputes/[id]">) {
  return (
    <div className="mx-auto max-w-4xl">
      <Suspense fallback={<div className="h-96 animate-pulse rounded-2xl bg-[var(--surface-2)]" />}>
        <Case params={params} />
      </Suspense>
    </div>
  );
}
