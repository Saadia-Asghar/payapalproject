// Shared Tailwind class recipes so pages stay visually consistent.
export const btn = {
  primary:
    "inline-flex items-center justify-center gap-2 rounded-lg bg-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-[var(--accent-strong)] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]",
  secondary:
    "inline-flex items-center justify-center gap-2 rounded-lg border border-[var(--line)] bg-white px-4 py-2.5 text-sm font-semibold text-[var(--ink)] hover:bg-[var(--surface-2)] disabled:cursor-not-allowed disabled:opacity-50",
  danger:
    "inline-flex items-center justify-center gap-2 rounded-lg border border-red-200 bg-white px-4 py-2.5 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50",
  ghost: "inline-flex items-center gap-1 text-sm font-medium text-[var(--accent)] hover:underline",
};

export const card = "rounded-2xl border border-[var(--line)] bg-white p-6 shadow-[0_1px_2px_rgba(16,24,40,0.04)]";
export const input =
  "block w-full rounded-lg border border-[var(--line)] bg-white px-3 py-2 text-sm text-[var(--ink)] placeholder:text-[var(--muted-2)] focus:border-[var(--accent)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/20 aria-[invalid=true]:border-red-400";
export const label = "block text-sm font-medium text-[var(--ink)]";
export const hint = "mt-1 text-xs text-[var(--muted)]";
export const fieldError = "mt-1 text-xs font-medium text-red-700";

export const statusBadge: Record<string, string> = {
  DRAFT: "bg-slate-100 text-slate-700 ring-slate-200",
  ACTIVE: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  EXPIRED: "bg-amber-50 text-amber-800 ring-amber-200",
  REVOKED: "bg-red-50 text-red-700 ring-red-200",
  CONSUMED: "bg-sky-50 text-sky-800 ring-sky-200",
};
export const badge = "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset";
