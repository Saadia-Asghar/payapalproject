// Human-readable rows for showing approved terms (review screen, receipt, passport).
import { formatDeadline, formatMoney } from "./summary.ts";
import { DELIVERY_REFS, type ApprovedTerms } from "./terms.ts";

export interface TermRow {
  label: string;
  value: string;
  emphasis?: boolean;
}

export function termRows(t: ApprovedTerms, merchantNames: Record<string, string>): TermRow[] {
  const mustHave = [
    t.product.color && `Colour: ${t.product.color}`,
    t.product.size && `Size: ${t.product.size}`,
    t.product.brand && `Brand: ${t.product.brand}`,
  ]
    .filter(Boolean)
    .join(" · ");
  return [
    { label: "Product type", value: t.product.type, emphasis: true },
    { label: "Must-have details", value: mustHave || "None specified" },
    { label: "Condition", value: t.product.condition === "NEW_ONLY" ? "New only" : "New or used" },
    { label: "Quantity", value: String(t.quantity) },
    {
      label: "Maximum TOTAL",
      value: `${formatMoney(t.max_total.value, t.max_total.currency)} — includes item price, shipping, taxes and fees`,
      emphasis: true,
    },
    { label: "Allowed sellers", value: t.merchant_ids.map((id) => `${merchantNames[id] ?? id} (${id})`).join(", "), emphasis: true },
    { label: "Delivery", value: t.delivery_ref ? DELIVERY_REFS[t.delivery_ref] : "Not specified" },
    { label: "Purchase deadline", value: `${formatDeadline(t.expires_at, t.display_timezone)} (${t.display_timezone})`, emphasis: true },
    { label: "Substitutions", value: t.substitutions === "ASK_FIRST" ? "Ask me first" : "Not allowed" },
    { label: "Recurring billing", value: "Not allowed" },
    { label: "Review mode", value: "Ask me to approve the final cart, then approve payment in PayPal" },
    { label: "Permission use", value: "One purchase only" },
    ...(t.notes ? [{ label: "Extra notes (recorded, not auto-enforced yet)", value: t.notes }] : []),
  ];
}
