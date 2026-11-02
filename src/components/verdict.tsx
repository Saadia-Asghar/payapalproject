import type { RuleStatus, Verdict } from "@/lib/policy/engine";
import { badge } from "./ui";

export const VERDICT_STYLE: Record<Verdict, { badge: string; panel: string; title: string; body: string }> = {
  ALLOW: {
    badge: "bg-emerald-50 text-emerald-800 ring-emerald-200",
    panel: "border-emerald-300 bg-emerald-50",
    title: "ALLOW — matches the permission you approved",
    body: "Every rule passed. You can approve this exact cart, then pay separately in PayPal.",
  },
  REVIEW: {
    badge: "bg-amber-50 text-amber-800 ring-amber-200",
    panel: "border-amber-300 bg-amber-50",
    title: "REVIEW — we need your decision about this difference",
    body: "Nothing is purchased. Your current permission stays as it is; to accept this item you would approve a new version.",
  },
  BLOCK: {
    badge: "bg-red-50 text-red-700 ring-red-200",
    panel: "border-red-300 bg-red-50",
    title: "BLOCK — this purchase violates your permission",
    body: "No order can be created for this cart. The exact rules it breaks are listed below.",
  },
};

export function VerdictBadge({ verdict, preview }: { verdict: Verdict; preview?: boolean }) {
  return (
    <span className={`${badge} ${VERDICT_STYLE[verdict].badge}`} title={preview ? "Preview — run the check to record it" : undefined}>
      {verdict}
      {preview && <span className="ml-1 font-normal opacity-70">preview</span>}
    </span>
  );
}

const STATUS_ICON: Record<RuleStatus, { icon: string; cls: string; label: string }> = {
  PASS: { icon: "✓", cls: "text-emerald-700", label: "Pass" },
  REVIEW: { icon: "?", cls: "text-amber-700", label: "Needs your decision" },
  FAIL: { icon: "✗", cls: "text-red-700", label: "Violates permission" },
};

export function RuleStatusIcon({ status }: { status: RuleStatus }) {
  const s = STATUS_ICON[status];
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-semibold ${s.cls}`}>
      <span aria-hidden>{s.icon}</span>
      <span>{s.label}</span>
    </span>
  );
}
