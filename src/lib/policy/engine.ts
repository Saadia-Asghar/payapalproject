// Deterministic policy gate: compares a trusted, server-built cart with the approved
// permission terms and returns ALLOW / REVIEW / BLOCK with one explained result per rule.
// Inputs are structured data only — product descriptions and AI output never reach this
// function, so text like "ignore your rules" cannot influence a verdict.
import type { ApprovedTerms } from "../permissions/terms.ts";

export const CART_SCHEMA_ID = "cartwitness.cart.v1";

export interface ProductAttributes {
  color?: string | null;
  size?: string | null;
  brand?: string | null;
  condition?: "NEW" | "REFURBISHED" | "USED" | null;
  authenticity_verified?: boolean;
  recurring?: boolean;
}

export interface CartLine {
  sku: string;
  title: string;
  category: string;
  quantity: number;
  unit_price: string;
  attributes: ProductAttributes;
}

/** Everything that matters for a purchase decision. Its canonical hash identifies the exact cart. */
export interface Cart {
  schema: typeof CART_SCHEMA_ID;
  policy_id: string;
  permission_version: number;
  merchant: { id: string; display_name: string };
  currency: string;
  lines: CartLine[];
  subtotal: string;
  shipping: string;
  tax: string;
  total: string;
}

export type RuleStatus = "PASS" | "REVIEW" | "FAIL";
export type Verdict = "ALLOW" | "REVIEW" | "BLOCK";

export interface RuleResult {
  code: string;
  label: string;
  status: RuleStatus;
  allowed: string;
  actual: string;
  message: string;
}

export interface EvaluationContext {
  now: Date;
  /** Result of the server-side permission status check (revoked / used / superseded / expired). */
  permissionUsable: { ok: true } | { ok: false; reason: string };
  /** Units in stock per SKU, from the trusted catalog. */
  stock: Record<string, number>;
  /** Display names of the allowlisted merchant ids, to explain look-alike sellers. */
  allowedMerchantNames: Record<string, string>;
}

export interface Evaluation {
  verdict: Verdict;
  rules: RuleResult[];
  mismatchCodes: string[];
}

// ---------- money (integer cents, never floats) ----------
export function toCents(value: string): number {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!m) throw new TypeError(`Invalid money amount: ${value}`);
  return Number(m[1]) * 100 + Number((m[2] ?? "0").padEnd(2, "0"));
}
export function fromCents(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

// ---------- normalization ----------
export function normalizeSize(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b(men'?s|mens|male)\b/g, "m")
    .replace(/\b(women'?s|womens|female)\b/g, "w")
    .replace(/[^a-z0-9.]/g, "");
}
const words = (s: string) =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w));

/** Every word of the requested type must appear in the product category ("running shoes" ⊆ "trail running shoes"). */
export function productTypeMatches(requested: string, category: string): boolean {
  const have = new Set(words(category));
  return words(requested).every((w) => have.has(w));
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const money = (cents: number, currency: string) => `$${fromCents(cents)} ${currency}`;

// ---------- rules ----------
export function evaluateCart(terms: ApprovedTerms, cart: Cart, ctx: EvaluationContext): Evaluation {
  const rules: RuleResult[] = [];
  const add = (r: RuleResult) => rules.push(r);
  const line = cart.lines[0];
  const attrs = line?.attributes ?? {};
  const p = terms.product;

  add(
    ctx.permissionUsable.ok
      ? { code: "PERMISSION_STATUS", label: "Permission status", status: "PASS", allowed: "Active, unused", actual: "Active, unused", message: "Permission is active." }
      : { code: "PERMISSION_STATUS", label: "Permission status", status: "FAIL", allowed: "Active, unused", actual: ctx.permissionUsable.reason, message: ctx.permissionUsable.reason },
  );

  const deadlinePassed = ctx.now.getTime() >= new Date(terms.expires_at).getTime();
  add({
    code: "DEADLINE",
    label: "Purchase deadline",
    status: deadlinePassed ? "FAIL" : "PASS",
    allowed: `Before ${terms.expires_at}`,
    actual: ctx.now.toISOString(),
    message: deadlinePassed ? "The purchase deadline has passed." : "Within the purchase deadline.",
  });

  const sellerAllowed = terms.merchant_ids.includes(cart.merchant.id);
  const lookalike = !sellerAllowed && Object.values(ctx.allowedMerchantNames).some((n) => same(n, cart.merchant.display_name));
  add({
    code: "SELLER",
    label: "Seller",
    status: sellerAllowed ? "PASS" : "FAIL",
    allowed: terms.merchant_ids.join(", "),
    actual: `${cart.merchant.display_name} (${cart.merchant.id})`,
    message: sellerAllowed
      ? "Seller is on your allowlist (matched by verified ID)."
      : lookalike
        ? "Look-alike seller: the name matches an allowed seller but the verified seller ID does not."
        : "This seller is not on your allowlist.",
  });

  add({
    code: "CURRENCY",
    label: "Currency",
    status: cart.currency === terms.max_total.currency ? "PASS" : "FAIL",
    allowed: terms.max_total.currency,
    actual: cart.currency,
    message: cart.currency === terms.max_total.currency ? "Same currency as your limit." : "Currency differs from your limit; it is never converted silently.",
  });

  add({
    code: "SINGLE_PRODUCT",
    label: "Items in cart",
    status: cart.lines.length === 1 ? "PASS" : "FAIL",
    allowed: "One product line",
    actual: `${cart.lines.length} line(s)`,
    message: cart.lines.length === 1 ? "No extra items." : "Extra items are not allowed.",
  });

  const typeOk = !!line && productTypeMatches(p.type, line.category);
  add({
    code: "PRODUCT_TYPE",
    label: "Product type",
    status: typeOk ? "PASS" : "FAIL",
    allowed: p.type,
    actual: line?.category ?? "—",
    message: typeOk ? "Matches the product type you allowed." : "Different kind of product than you allowed.",
  });

  if (p.size) {
    const actual = attrs.size;
    const match = !!actual && normalizeSize(actual) === normalizeSize(p.size);
    add({
      code: "SIZE",
      label: "Size",
      status: !actual ? "REVIEW" : match ? "PASS" : "FAIL",
      allowed: p.size,
      actual: actual ?? "Not provided by seller",
      message: !actual ? "The seller did not provide a size — needs your decision." : match ? "Exact size match." : "Shoe size differs from what you allowed.",
    });
  }

  if (p.color) {
    const actual = attrs.color;
    const exact = !!actual && same(actual, p.color);
    const ambiguous = !!actual && !exact && words(actual).includes(p.color.toLowerCase());
    add({
      code: "COLOR",
      label: "Colour",
      status: !actual || ambiguous ? "REVIEW" : exact ? "PASS" : "FAIL",
      allowed: p.color,
      actual: actual ?? "Not provided by seller",
      message: !actual
        ? "The seller did not provide a colour — needs your decision."
        : exact
          ? "Exact colour match."
          : ambiguous
            ? `“${actual}” is close to “${p.color}” but not the same — needs your decision.`
            : "Colour differs from what you allowed.",
    });
  }

  if (p.brand) {
    const actual = attrs.brand;
    const exact = !!actual && same(actual, p.brand);
    const askFirst = terms.substitutions === "ASK_FIRST";
    add({
      code: "BRAND",
      label: "Brand",
      status: exact ? "PASS" : !actual || askFirst ? "REVIEW" : "FAIL",
      allowed: p.brand,
      actual: actual ?? "Not provided by seller",
      message: exact
        ? "Same brand."
        : !actual
          ? "Brand unknown — needs your decision."
          : askFirst
            ? "Different brand. You asked to be consulted about substitutions."
            : "Different brand, and you did not allow substitutions.",
    });
  } else {
    add({ code: "BRAND", label: "Brand", status: "PASS", allowed: "Any brand", actual: attrs.brand ?? "—", message: "You did not restrict the brand." });
  }

  if (p.condition === "NEW_ONLY") {
    const c = attrs.condition;
    add({
      code: "CONDITION",
      label: "Condition",
      status: !c ? "REVIEW" : c === "NEW" ? "PASS" : "FAIL",
      allowed: "New only",
      actual: c ?? "Not provided by seller",
      message: !c ? "Condition unknown — needs your decision." : c === "NEW" ? "New item." : `Item is ${c.toLowerCase()}; you allowed new only.`,
    });
  } else {
    add({ code: "CONDITION", label: "Condition", status: "PASS", allowed: "New or used", actual: attrs.condition ?? "—", message: "Any condition allowed." });
  }

  const authentic = attrs.authenticity_verified === true;
  add({
    code: "AUTHENTICITY",
    label: "Authenticity",
    status: authentic ? "PASS" : "REVIEW",
    allowed: "Verified by seller",
    actual: authentic ? "Verified" : "Unknown",
    message: authentic ? "Seller states the item is authentic." : "Authenticity unknown — never auto-allowed.",
  });

  const qty = line?.quantity ?? 0;
  const qtyOk = qty >= 1 && qty <= terms.quantity;
  add({
    code: "QUANTITY",
    label: "Quantity",
    status: qtyOk ? "PASS" : "FAIL",
    allowed: `Up to ${terms.quantity}`,
    actual: String(qty),
    message: qtyOk ? "Quantity within your limit." : "More items than you allowed.",
  });

  const inStock = !!line && (ctx.stock[line.sku] ?? 0) >= qty;
  add({
    code: "AVAILABILITY",
    label: "Availability",
    status: inStock ? "PASS" : "FAIL",
    allowed: "In stock",
    actual: inStock ? "In stock" : "Out of stock",
    message: inStock ? "Seller has stock." : "Out of stock — cannot be ordered.",
  });

  const recurring = cart.lines.some((l) => l.attributes.recurring === true);
  add({
    code: "RECURRING",
    label: "Recurring billing",
    status: recurring ? "FAIL" : "PASS",
    allowed: "Not allowed",
    actual: recurring ? "Subscription" : "One-time",
    message: recurring ? "Subscriptions and repeat billing are not allowed." : "One-time purchase.",
  });

  const total = toCents(cart.total);
  const max = toCents(terms.max_total.value);
  add({
    code: "TOTAL",
    label: "Final total (incl. shipping, tax, fees)",
    status: total <= max ? "PASS" : "FAIL",
    allowed: `≤ ${money(max, terms.max_total.currency)}`,
    actual: `${money(total, cart.currency)} = item ${cart.subtotal} + shipping ${cart.shipping} + tax ${cart.tax}`,
    message: total <= max ? "Final total is within your limit." : `Final total is ${money(total - max, cart.currency)} over your limit.`,
  });

  const verdict: Verdict = rules.some((r) => r.status === "FAIL") ? "BLOCK" : rules.some((r) => r.status === "REVIEW") ? "REVIEW" : "ALLOW";
  return { verdict, rules, mismatchCodes: rules.filter((r) => r.status !== "PASS").map((r) => r.code) };
}

/** Cart totals from trusted catalog values (integer cents, tax rounded half-up). */
export function priceCart(input: { unitPrice: string; quantity: number; shipping: string; taxRateBps: number }) {
  const subtotal = toCents(input.unitPrice) * input.quantity;
  const shipping = toCents(input.shipping);
  const tax = Math.round((subtotal * input.taxRateBps) / 10_000);
  return { subtotal: fromCents(subtotal), shipping: fromCents(shipping), tax: fromCents(tax), total: fromCents(subtotal + shipping + tax) };
}
