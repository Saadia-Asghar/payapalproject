// Database side of checkout — the ONLY code that changes payment state.
// The PayPal adapter (Phase 3, see docs/PAYPAL_INTEGRATION.md) talks to PayPal and calls
// these functions; it never writes payment tables itself. Every step re-checks the
// permission and the cart on the server, and nothing here trusts the browser.
import { randomUUID } from "node:crypto";
import type { Cart } from "../../lib/policy/engine.ts";
import { appendEvidence } from "../audit.ts";
import { canonicalHash } from "../crypto/hash.ts";
import type { SigningKey } from "../crypto/signing.ts";
import type { Db, Queryable } from "../db/client.ts";
import { recheckAttempt, type AttemptRow } from "./carts.ts";
import { issuePassport } from "./passports.ts";
import { assertVersionUsable, ServiceError } from "./permissions.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PaymentStatus = "CREATING" | "PAYPAL_CREATED" | "CAPTURED" | "FAILED" | "CANCELLED";

export interface PaymentOrderRow {
  id: string;
  cart_attempt_id: string;
  user_id: string;
  merchant_id: string;
  reconciliation_key: string;
  paypal_request_id: string;
  paypal_order_id: string | null;
  amount: string;
  currency: string;
  status: PaymentStatus;
  created_at: Date;
  updated_at: Date;
}

/** Everything the PayPal adapter needs to call POST /v2/checkout/orders. */
export interface CheckoutReservation {
  paymentOrderId: string;
  /** Put in purchase_units[0].custom_id — compact and opaque, never the full hashes. */
  reconciliationKey: string;
  /** Send as the PayPal-Request-Id header so retries never create a second order. */
  paypalRequestId: string;
  amount: string;
  currency: string;
  merchantId: string;
  item: { sku: string; name: string; quantity: number; unitPrice: string };
  breakdown: { itemTotal: string; shipping: string; tax: string };
  status: PaymentStatus;
  paypalOrderId: string | null;
}

const ORDER_SQL = "SELECT *, amount::text AS amount FROM payment_orders";

function toReservation(o: PaymentOrderRow, cart: Cart): CheckoutReservation {
  const line = cart.lines[0];
  return {
    paymentOrderId: o.id,
    reconciliationKey: o.reconciliation_key,
    paypalRequestId: o.paypal_request_id,
    amount: o.amount,
    currency: o.currency,
    merchantId: o.merchant_id,
    item: { sku: line.sku, name: line.title, quantity: line.quantity, unitPrice: line.unit_price },
    breakdown: { itemTotal: cart.subtotal, shipping: cart.shipping, tax: cart.tax },
    status: o.status,
    paypalOrderId: o.paypal_order_id,
  };
}

async function lockAttempt(q: Queryable, userId: string, attemptId: string) {
  if (!UUID_RE.test(attemptId)) throw new ServiceError("NOT_FOUND", 404, "Cart not found.");
  const [a] = await q.query<AttemptRow>("SELECT * FROM cart_attempts WHERE id = $1 FOR UPDATE", [attemptId]);
  if (!a || a.user_id !== userId) throw new ServiceError("NOT_FOUND", 404, "Cart not found.");
  return a;
}

/**
 * Step 1 — policy gate before PayPal Create Order. Idempotent per cart attempt.
 * Refuses unless: verdict ALLOW, buyer approved this exact cart, the catalog still produces
 * the same cart hash, the item is in stock, and the permission is active/unexpired/unused.
 * Any older unpaid reservation under the same permission is cancelled (single use).
 */
export async function reserveCheckout(db: Db, input: { userId: string; attemptId: string; now?: Date }): Promise<CheckoutReservation> {
  const now = input.now ?? new Date();
  return db.tx(async (q) => {
    const a = await lockAttempt(q, input.userId, input.attemptId);
    if (a.verdict !== "ALLOW") throw new ServiceError("NOT_ALLOWED", 409, "This cart does not match your permission.");
    if (!a.buyer_cart_approved_at) throw new ServiceError("CART_NOT_APPROVED", 409, "Approve this exact cart before checkout.");

    const [version] = await q.query<{ permission_id: string }>("SELECT permission_id FROM permission_versions WHERE id = $1", [a.permission_version_id]);
    // Serialize checkouts per permission.
    await q.query("SELECT id FROM permissions WHERE id = $1 FOR UPDATE", [version.permission_id]);
    await assertVersionUsable(q, a.permission_version_id, now);

    const recheck = await recheckAttempt(q, a);
    if (!recheck.sameCart) throw new ServiceError("CART_CHANGED", 409, "The seller changed this cart since you approved it. Run a new check.");
    if (!recheck.inStock) throw new ServiceError("OUT_OF_STOCK", 409, "The item is no longer in stock.");

    const cart = JSON.parse(a.cart_json) as Cart;
    const [existing] = await q.query<PaymentOrderRow>(`${ORDER_SQL} WHERE cart_attempt_id = $1`, [a.id]);
    if (existing) {
      if (existing.status === "CAPTURED") throw new ServiceError("ALREADY_PAID", 409, "This cart has already been paid.");
      if (existing.status === "CREATING" || existing.status === "PAYPAL_CREATED") return toReservation(existing, cart);
      throw new ServiceError("CHECKOUT_CLOSED", 409, "This checkout was cancelled or failed. Run a new cart check.");
    }

    const cancelled = await q.query<{ id: string }>(
      `UPDATE payment_orders o SET status = 'CANCELLED', updated_at = now()
         FROM cart_attempts c JOIN permission_versions v ON v.id = c.permission_version_id
        WHERE o.cart_attempt_id = c.id AND v.permission_id = $1 AND o.status IN ('CREATING', 'PAYPAL_CREATED')
        RETURNING o.id`,
      [version.permission_id],
    );

    const [{ key }] = await q.query<{ key: string }>("SELECT 'CW-CASE-' || lpad(nextval('reconciliation_seq')::text, 5, '0') AS key");
    const [order] = await q.query<PaymentOrderRow>(
      `INSERT INTO payment_orders (cart_attempt_id, user_id, merchant_id, reconciliation_key, paypal_request_id, amount, currency, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'CREATING') RETURNING *, amount::text AS amount`,
      [a.id, input.userId, cart.merchant.id, key, randomUUID(), cart.total, cart.currency],
    );
    await appendEvidence(q, {
      subjectType: "payment",
      subjectId: order.id,
      eventType: "CHECKOUT_RESERVED",
      actorId: input.userId,
      payload: {
        reconciliation_key: key,
        cart_attempt_id: a.id,
        cart_hash: a.cart_hash,
        amount: cart.total,
        currency: cart.currency,
        cancelled_previous: cancelled.map((c) => c.id),
      },
      at: now,
    });
    return toReservation(order, cart);
  });
}

async function lockOrder(q: Queryable, paymentOrderId: string) {
  if (!UUID_RE.test(paymentOrderId)) throw new ServiceError("NOT_FOUND", 404, "Payment order not found.");
  const [o] = await q.query<PaymentOrderRow>(`${ORDER_SQL} WHERE id = $1 FOR UPDATE`, [paymentOrderId]);
  if (!o) throw new ServiceError("NOT_FOUND", 404, "Payment order not found.");
  return o;
}

/** Step 2 — record the id PayPal returned from Create Order. Idempotent for the same id. */
export async function attachPayPalOrder(db: Db, input: { paymentOrderId: string; paypalOrderId: string; now?: Date }) {
  const now = input.now ?? new Date();
  if (!/^[A-Z0-9]{8,32}$/.test(input.paypalOrderId)) throw new ServiceError("BAD_REQUEST", 400, "Unexpected PayPal order id format.");
  return db.tx(async (q) => {
    const o = await lockOrder(q, input.paymentOrderId);
    if (o.paypal_order_id) {
      if (o.paypal_order_id === input.paypalOrderId) return { status: o.status };
      throw new ServiceError("ORDER_MISMATCH", 409, "A different PayPal order is already linked.");
    }
    if (o.status !== "CREATING") throw new ServiceError("CHECKOUT_CLOSED", 409, `Payment order is ${o.status}.`);
    await q.query("UPDATE payment_orders SET paypal_order_id = $2, status = 'PAYPAL_CREATED', updated_at = now() WHERE id = $1", [
      o.id,
      input.paypalOrderId,
    ]);
    await appendEvidence(q, {
      subjectType: "payment",
      subjectId: o.id,
      eventType: "PAYPAL_ORDER_CREATED",
      payload: { paypal_order_id: input.paypalOrderId, reconciliation_key: o.reconciliation_key },
      at: now,
    });
    return { status: "PAYPAL_CREATED" as const };
  });
}

/** Re-check immediately before calling PayPal capture. Throws if capture must not happen. */
export async function assertCapturable(db: Db, input: { paymentOrderId: string; paypalOrderId: string; now?: Date }) {
  const now = input.now ?? new Date();
  return db.tx(async (q) => {
    const o = await lockOrder(q, input.paymentOrderId);
    if (o.status !== "PAYPAL_CREATED" || o.paypal_order_id !== input.paypalOrderId) {
      throw new ServiceError("NOT_CAPTURABLE", 409, `Payment order is ${o.status}.`);
    }
    const [a] = await q.query<AttemptRow>("SELECT * FROM cart_attempts WHERE id = $1", [o.cart_attempt_id]);
    await assertVersionUsable(q, a.permission_version_id, now);
    return { amount: o.amount, currency: o.currency, paypalRequestId: o.paypal_request_id };
  });
}

export interface CaptureInput {
  paymentOrderId: string;
  /** All values below must come from PayPal's server-side capture (or GET order) response. */
  paypalOrderId: string;
  captureId: string;
  captureStatus: string;
  amount: string;
  currency: string;
  /** The full PayPal response body; only its hash is stored. */
  rawResponse: unknown;
  now?: Date;
  signingKey?: SigningKey;
}

/**
 * Step 3 — record a capture verified against PayPal's server response, consume the
 * single-use permission and issue the Purchase Passport, atomically.
 * Idempotent: the same capture id returns the existing passport.
 */
export async function recordCapture(db: Db, input: CaptureInput) {
  const now = input.now ?? new Date();
  return db.tx(async (q) => {
    const o = await lockOrder(q, input.paymentOrderId);
    if (o.status === "CAPTURED") {
      const [cap] = await q.query<{ paypal_capture_id: string }>("SELECT paypal_capture_id FROM payment_captures WHERE payment_order_id = $1", [o.id]);
      if (cap?.paypal_capture_id !== input.captureId) throw new ServiceError("ALREADY_PAID", 409, "This order already has a different capture.");
      const [pp] = await q.query<{ id: string }>("SELECT id FROM passports WHERE payment_order_id = $1", [o.id]);
      return { passportId: pp.id, duplicate: true };
    }
    if (o.status !== "PAYPAL_CREATED") throw new ServiceError("NOT_CAPTURABLE", 409, `Payment order is ${o.status}.`);
    if (input.paypalOrderId !== o.paypal_order_id) throw new ServiceError("ORDER_MISMATCH", 409, "Capture is for a different PayPal order.");
    if (input.captureStatus !== "COMPLETED") throw new ServiceError("CAPTURE_NOT_COMPLETED", 409, `PayPal capture status is ${input.captureStatus}.`);
    if (input.amount !== o.amount || input.currency !== o.currency) {
      throw new ServiceError("AMOUNT_MISMATCH", 409, `Captured ${input.amount} ${input.currency}, expected ${o.amount} ${o.currency}.`);
    }

    const [a] = await q.query<AttemptRow>("SELECT * FROM cart_attempts WHERE id = $1", [o.cart_attempt_id]);
    const [version] = await q.query<{ permission_id: string }>("SELECT permission_id FROM permission_versions WHERE id = $1", [a.permission_version_id]);
    await q.query("SELECT id FROM permissions WHERE id = $1 FOR UPDATE", [version.permission_id]);
    await assertVersionUsable(q, a.permission_version_id, now);

    await q.query(
      `INSERT INTO payment_captures (payment_order_id, paypal_capture_id, status, amount, currency, response_hash, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [o.id, input.captureId, input.captureStatus, input.amount, input.currency, canonicalHash(input.rawResponse ?? null), now.toISOString()],
    );
    await q.query("UPDATE payment_orders SET status = 'CAPTURED', updated_at = now() WHERE id = $1", [o.id]);
    await q.query("UPDATE permissions SET status = 'CONSUMED', used_at = $2, updated_at = now() WHERE id = $1", [version.permission_id, now.toISOString()]);
    await appendEvidence(q, {
      subjectType: "payment",
      subjectId: o.id,
      eventType: "PAYMENT_CAPTURED",
      actorId: o.user_id,
      payload: { paypal_order_id: o.paypal_order_id, paypal_capture_id: input.captureId, amount: input.amount, currency: input.currency },
      at: now,
    });
    const passportId = await issuePassport(q, o.id, now, input.signingKey);
    return { passportId, duplicate: false };
  });
}

/** Marks an unpaid order cancelled (buyer closed PayPal) or failed (PayPal error). */
export async function closeCheckout(db: Db, input: { paymentOrderId: string; status: "CANCELLED" | "FAILED"; reason: string; now?: Date }) {
  const now = input.now ?? new Date();
  return db.tx(async (q) => {
    const o = await lockOrder(q, input.paymentOrderId);
    if (o.status === "CAPTURED") throw new ServiceError("ALREADY_PAID", 409, "A captured payment cannot be cancelled here; use a merchant refund.");
    if (o.status === "CANCELLED" || o.status === "FAILED") return { status: o.status };
    await q.query("UPDATE payment_orders SET status = $2, updated_at = now() WHERE id = $1", [o.id, input.status]);
    await appendEvidence(q, {
      subjectType: "payment",
      subjectId: o.id,
      eventType: input.status === "FAILED" ? "CHECKOUT_FAILED" : "CHECKOUT_CANCELLED",
      payload: { reason: input.reason.slice(0, 200) },
      at: now,
    });
    return { status: input.status };
  });
}

export async function getPaymentForAttempt(q: Queryable, attemptId: string) {
  const [o] = await q.query<PaymentOrderRow & { passport_id: string | null; paypal_capture_id: string | null }>(
    `SELECT o.*, o.amount::text AS amount, p.id AS passport_id, c.paypal_capture_id
       FROM payment_orders o
       LEFT JOIN passports p ON p.payment_order_id = o.id
       LEFT JOIN payment_captures c ON c.payment_order_id = o.id
      WHERE o.cart_attempt_id = $1`,
    [attemptId],
  );
  return o ?? null;
}
