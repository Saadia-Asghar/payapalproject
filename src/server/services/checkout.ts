// Phase 3: PayPal checkout orchestration. Talks to PayPal through PayPalClient and changes
// payment state only through services/payments.ts (policy gate, idempotency, single use).
// Nothing is marked paid because the browser said so: only PayPal's server response counts.
import type { Db } from "../db/client.ts";
import { PayPalError, type PayPalCapture, type PayPalClient } from "../paypal/client.ts";
import { attachPayPalOrder, assertCapturable, closeCheckout, recordCapture, reserveCheckout, type PaymentOrderRow } from "./payments.ts";
import { ServiceError } from "./permissions.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requirePayPal(pp: PayPalClient | null): PayPalClient {
  if (!pp) throw new ServiceError("PAYPAL_NOT_CONFIGURED", 503, "PayPal checkout is not configured yet. Add the sandbox keys (see README).");
  return pp;
}

function fromPayPal(err: unknown): never {
  if (err instanceof PayPalError) {
    console.warn(`[paypal] ${err.status} ${err.issue ?? ""} debug_id=${err.debugId ?? "-"}`);
    if (err.issue === "INSTRUMENT_DECLINED") throw new ServiceError("PAYMENT_DECLINED", 402, "PayPal declined that payment method. Please choose another one in PayPal.");
    if (err.issue === "ORDER_NOT_APPROVED") throw new ServiceError("NOT_APPROVED_IN_PAYPAL", 409, "The payment was not approved in PayPal yet.");
    throw new ServiceError("PAYPAL_ERROR", 502, "PayPal could not complete the request. Please try again.");
  }
  throw err;
}

async function ownedOrder(db: Db, userId: string, paymentOrderId: string) {
  if (!UUID_RE.test(paymentOrderId)) throw new ServiceError("NOT_FOUND", 404, "Payment not found.");
  const [o] = await db.query<PaymentOrderRow>("SELECT *, amount::text AS amount FROM payment_orders WHERE id = $1", [paymentOrderId]);
  if (!o || o.user_id !== userId) throw new ServiceError("NOT_FOUND", 404, "Payment not found.");
  return o;
}

/** Create (or resume) the PayPal order for an approved cart. Safe to call repeatedly. */
export async function startCheckout(db: Db, pp: PayPalClient | null, input: { userId: string; attemptId: string }) {
  const paypal = requirePayPal(pp);
  const reservation = await reserveCheckout(db, input);
  if (reservation.paypalOrderId) return { paymentOrderId: reservation.paymentOrderId, paypalOrderId: reservation.paypalOrderId };
  // Same PayPal-Request-Id on every retry, so PayPal returns the same order instead of a new one.
  const order = await paypal.createOrder(reservation).catch(fromPayPal);
  await attachPayPalOrder(db, { paymentOrderId: reservation.paymentOrderId, paypalOrderId: order.id });
  return { paymentOrderId: reservation.paymentOrderId, paypalOrderId: order.id };
}

async function settle(db: Db, paymentOrderId: string, c: PayPalCapture) {
  if (c.captureStatus === "COMPLETED" && c.captureId && c.amount && c.currency) {
    const r = await recordCapture(db, {
      paymentOrderId,
      paypalOrderId: c.orderId,
      captureId: c.captureId,
      captureStatus: c.captureStatus,
      amount: c.amount,
      currency: c.currency,
      rawResponse: c.raw,
    });
    return { status: "CAPTURED" as const, passportId: r.passportId };
  }
  if (c.captureStatus === "DECLINED" || c.captureStatus === "FAILED") {
    await closeCheckout(db, { paymentOrderId, status: "FAILED", reason: `PayPal capture ${c.captureStatus}` });
    throw new ServiceError("PAYMENT_DECLINED", 402, "PayPal declined the payment.");
  }
  // PENDING (e.g. under review): leave the order open; a webhook or a later retry settles it.
  return { status: "PENDING" as const, passportId: null };
}

/** Capture after the buyer approved in PayPal. Re-checks the permission first. */
export async function captureCheckout(db: Db, pp: PayPalClient | null, input: { userId: string; paymentOrderId: string }) {
  const paypal = requirePayPal(pp);
  const order = await ownedOrder(db, input.userId, input.paymentOrderId);
  if (order.status === "CAPTURED") {
    const [p] = await db.query<{ id: string }>("SELECT id FROM passports WHERE payment_order_id = $1", [order.id]);
    return { status: "CAPTURED" as const, passportId: p?.id ?? null };
  }
  if (!order.paypal_order_id) throw new ServiceError("NOT_CAPTURABLE", 409, "This checkout has no PayPal order yet.");
  const { paypalRequestId } = await assertCapturable(db, { paymentOrderId: order.id, paypalOrderId: order.paypal_order_id });
  let capture: PayPalCapture;
  try {
    capture = await paypal.captureOrder(order.paypal_order_id, `${paypalRequestId}-capture`);
  } catch (err) {
    // Already captured (e.g. a retry after a lost response): read the order and reconcile.
    if (err instanceof PayPalError && err.issue === "ORDER_ALREADY_CAPTURED") capture = await paypal.getOrder(order.paypal_order_id).catch(fromPayPal);
    else fromPayPal(err);
  }
  return settle(db, order.id, capture);
}

/** Buyer closed the PayPal window. A cancelled checkout can be restarted with a fresh cart check. */
export async function cancelCheckout(db: Db, input: { userId: string; paymentOrderId: string }) {
  const order = await ownedOrder(db, input.userId, input.paymentOrderId);
  return closeCheckout(db, { paymentOrderId: order.id, status: "CANCELLED", reason: "Buyer closed PayPal" });
}

interface WebhookEvent {
  id?: string;
  event_type?: string;
  resource?: { id?: string; supplementary_data?: { related_ids?: { order_id?: string } } };
}

/**
 * PayPal webhook: verify the signature with PayPal, dedupe by event id, then reconcile
 * captures by re-reading the order from PayPal. Unverified events change nothing.
 */
export async function handleWebhook(db: Db, pp: PayPalClient | null, input: { headers: Headers; rawBody: string }) {
  const paypal = requirePayPal(pp);
  let event: WebhookEvent;
  try {
    event = JSON.parse(input.rawBody) as WebhookEvent;
  } catch {
    throw new ServiceError("BAD_REQUEST", 400, "Invalid webhook body.");
  }
  if (!event.id || !event.event_type) throw new ServiceError("BAD_REQUEST", 400, "Invalid webhook event.");
  const verified = await paypal.verifyWebhook(input.headers, event).catch(() => false);
  if (!verified) throw new ServiceError("BAD_SIGNATURE", 400, "Webhook signature could not be verified.");

  const [inserted] = await db.query<{ id: string }>(
    `INSERT INTO webhook_events (paypal_event_id, event_type, verified, payload) VALUES ($1, $2, true, $3)
     ON CONFLICT (paypal_event_id) DO NOTHING RETURNING id`,
    [event.id, event.event_type, JSON.stringify(event)],
  );
  if (!inserted) return { handled: false, duplicate: true };

  if (event.event_type === "PAYMENT.CAPTURE.COMPLETED" || event.event_type === "CHECKOUT.ORDER.COMPLETED") {
    const orderId =
      event.resource?.supplementary_data?.related_ids?.order_id ?? (event.event_type === "CHECKOUT.ORDER.COMPLETED" ? event.resource?.id : undefined);
    if (!orderId) return { handled: false, duplicate: false };
    const [o] = await db.query<{ id: string; status: string }>("SELECT id, status FROM payment_orders WHERE paypal_order_id = $1", [orderId]);
    if (!o || o.status !== "PAYPAL_CREATED") return { handled: false, duplicate: false };
    // Trust PayPal's API, not the webhook body: re-read the order before recording anything.
    const capture = await paypal.getOrder(orderId).catch(fromPayPal);
    const r = await settle(db, o.id, capture).catch((e) => {
      if (e instanceof ServiceError) return { status: "REJECTED" as const, passportId: null, reason: e.code };
      throw e;
    });
    return { handled: true, duplicate: false, ...r };
  }
  return { handled: false, duplicate: false };
}
