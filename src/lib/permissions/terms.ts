// Purchase Permission Form: field definitions and validation.
// Shared by the browser form (instant feedback) and the server (authoritative).
import { z } from "zod";

export const TERMS_SCHEMA_ID = "cartwitness.permission.v1";
export const MAX_TOTAL_LIMIT = 10_000;
export const MAX_PERMISSION_DAYS = 30;
export const MIN_LEAD_MINUTES = 5;

/** Requests too vague to check a cart against. */
const TOO_BROAD = new Set(["any", "anything", "everything", "stuff", "things", "items", "products", "whatever", "something", "shopping"]);

export const DELIVERY_REFS = {
  SAVED_ADDRESS_A: "Saved delivery address A",
  SAVED_ADDRESS_B: "Saved delivery address B",
} as const;
type DeliveryRef = keyof typeof DELIVERY_REFS;

const clean = (s: string) => s.trim().replace(/\s+/g, " ");
const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .optional()
    .transform((v) => (v && clean(v) ? clean(v) : undefined));

/** What the form submits. Every field is visible and editable by the buyer. */
export const termsInputSchema = z.object({
  request_text: optionalText(1000),
  product_type: z
    .string("Describe the product type.")
    .transform(clean)
    .pipe(
      z
        .string()
        .min(3, "Describe the product type (at least 3 characters).")
        .max(80)
        .refine((v) => !TOO_BROAD.has(v.toLowerCase()), "Too broad — name a specific product type, e.g. “running shoes”."),
    ),
  color: optionalText(40),
  size: optionalText(40),
  brand: optionalText(60),
  condition: z.enum(["NEW_ONLY", "ANY"]),
  quantity: z.coerce
    .number("Enter a quantity.")
    .int("Quantity must be a whole number.")
    .min(1, "Quantity must be at least 1.")
    .max(10, "At most 10 per permission."),
  max_total: z
    .string("Enter a maximum total.")
    .trim()
    .regex(/^\d{1,5}(\.\d{1,2})?$/, "Enter an amount like 150 or 150.00.")
    .transform((v) => Number(v).toFixed(2))
    .refine((v) => Number(v) > 0, "Maximum total must be more than $0.")
    .refine((v) => Number(v) <= MAX_TOTAL_LIMIT, `Maximum total can’t exceed $${MAX_TOTAL_LIMIT.toLocaleString("en-US")}.`),
  currency: z.literal("USD"),
  merchant_ids: z
    .array(z.string().regex(/^[A-Z0-9-]{3,64}$/), "Choose at least one allowed seller.")
    .min(1, "Choose at least one allowed seller.")
    .transform((ids) => [...new Set(ids)].sort()),
  delivery_ref: z
    .enum(Object.keys(DELIVERY_REFS) as [DeliveryRef, ...DeliveryRef[]])
    .optional(),
  expires_at: z.iso
    .datetime({ offset: true, message: "Choose a purchase deadline." })
    .transform((v) => new Date(v).toISOString()),
  display_timezone: z.string().min(1).max(64),
  substitutions: z.enum(["NOT_ALLOWED", "ASK_FIRST"]),
  recurring: z.literal(false, "Recurring billing is not allowed in this version."),
  review_mode: z.literal("APPROVE_FINAL_CART"),
  single_use: z.literal(true, "This version supports one purchase per permission."),
  notes: optionalText(500),
});

export type TermsInput = z.output<typeof termsInputSchema>;
export type TermsFormValues = z.input<typeof termsInputSchema>;

export type FieldErrors = Record<string, string>;
export type ValidationResult = { ok: true; terms: TermsInput } | { ok: false; errors: FieldErrors };

/** Full validation including time-relative rules. `now` is injectable for tests. */
export function validateTerms(input: unknown, now: Date = new Date()): ValidationResult {
  const parsed = termsInputSchema.safeParse(input);
  const errors: FieldErrors = {};
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? "_form");
      errors[key] ??= issue.message;
    }
    return { ok: false, errors };
  }
  const terms = parsed.data;
  const expires = new Date(terms.expires_at).getTime();
  if (expires < now.getTime() + MIN_LEAD_MINUTES * 60_000) {
    errors.expires_at = "The deadline must be in the future.";
  } else if (expires > now.getTime() + MAX_PERMISSION_DAYS * 86_400_000) {
    errors.expires_at = `Permissions can last at most ${MAX_PERMISSION_DAYS} days.`;
  }
  if (!isValidTimeZone(terms.display_timezone)) errors.display_timezone = "Unknown time zone.";
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, terms };
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * The exact object that is canonicalized, hashed and signed on approval.
 * Binding policy_id + version into the terms makes each version's hash unique.
 */
export function buildApprovedTerms(terms: TermsInput, policyId: string, version: number) {
  return {
    schema: TERMS_SCHEMA_ID,
    policy_id: policyId,
    version,
    request_text: terms.request_text,
    product: {
      type: terms.product_type,
      color: terms.color,
      size: terms.size,
      brand: terms.brand,
      condition: terms.condition,
    },
    quantity: terms.quantity,
    merchant_ids: terms.merchant_ids,
    max_total: { currency: terms.currency, value: terms.max_total },
    include_shipping_and_tax: true,
    delivery_ref: terms.delivery_ref,
    expires_at: terms.expires_at,
    display_timezone: terms.display_timezone,
    substitutions: terms.substitutions,
    recurring: false,
    single_use: true,
    review_mode: terms.review_mode,
    checkout_mode: "BUYER_APPROVES_PAYPAL",
    notes: terms.notes,
  } as const;
}

export type ApprovedTerms = ReturnType<typeof buildApprovedTerms>;

/** The three consent statements on the review screen. Their text is stored with each approval. */
export const CONSENT_STATEMENTS = {
  checked_terms: "I checked the product, size, seller, total price limit and expiry date.",
  ai_may_err: "I understand that AI suggestions may be incorrect and that I can revoke this permission before a purchase.",
  no_charge_yet: "I understand this approval does not itself charge me; I will still approve checkout in PayPal.",
} as const;
export type ConsentKey = keyof typeof CONSENT_STATEMENTS;
export const CONSENT_KEYS = Object.keys(CONSENT_STATEMENTS) as ConsentKey[];
