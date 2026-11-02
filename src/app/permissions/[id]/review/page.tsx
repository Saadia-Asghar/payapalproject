import { Suspense } from "react";
import { ReviewPanel } from "@/components/ReviewPanel";

async function Panel({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ReviewPanel permissionId={id} />;
}

export default function ReviewPermissionPage({ params }: PageProps<"/permissions/[id]/review">) {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <p className="text-xs font-bold uppercase tracking-wider text-[var(--accent)]">Step 2 of 2 · Review and approve</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Review exactly what you are allowing</h1>
      </div>
      <Suspense fallback={<div className="h-96 animate-pulse rounded-2xl bg-[var(--surface-2)]" />}>
        <Panel params={params} />
      </Suspense>
    </div>
  );
}
