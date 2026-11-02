// Deterministic plain-English summary of permission terms ("Screen 2").
// Generated from the validated terms only — never by an AI model.
import { DELIVERY_REFS, type TermsInput } from "./terms.ts";

const NUMBER_WORDS = ["ZERO", "ONE", "TWO", "THREE", "FOUR", "FIVE", "SIX", "SEVEN", "EIGHT", "NINE", "TEN"];

export function formatDeadline(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
  }).format(new Date(iso));
}

export function formatMoney(value: string, currency: string): string {
  return `$${Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

export function summarizeTerms(terms: TermsInput, merchantNames: Record<string, string>): string {
  const qty = NUMBER_WORDS[terms.quantity] ?? String(terms.quantity);
  const item = [
    terms.condition === "NEW_ONLY" ? "NEW" : undefined,
    terms.color?.toUpperCase(),
    terms.product_type.toUpperCase(),
  ]
    .filter(Boolean)
    .join(" ");
  const details = [terms.size && `SIZE ${terms.size.toUpperCase()}`, terms.brand && `BRAND ${terms.brand.toUpperCase()}`]
    .filter(Boolean)
    .join(", ");
  const sellers = terms.merchant_ids.map((id) => (merchantNames[id] ?? id).toUpperCase());
  const sellerText = sellers.length === 1 ? sellers[0] : `${sellers.slice(0, -1).join(", ")} or ${sellers.at(-1)}`;

  const parts = [
    `I allow CartWitness to help me find ${qty} ${item}${details ? `, ${details},` : ""} from ${sellerText},`,
    `costing NO MORE THAN ${formatMoney(terms.max_total, terms.currency)} TOTAL including shipping, taxes and fees,`,
    `before ${formatDeadline(terms.expires_at, terms.display_timezone)}.`,
    terms.substitutions === "NOT_ALLOWED"
      ? "No substitutions."
      : "Any substitution must be shown to me for a separate decision first.",
    "No subscriptions, extra items, or repeat purchases.",
    terms.delivery_ref ? `Deliver to: ${DELIVERY_REFS[terms.delivery_ref]}.` : undefined,
    "I will approve the final checkout separately in PayPal.",
  ];
  return parts.filter(Boolean).join(" ");
}
