// Minimal PayPal REST client (Orders v2 + webhook verification) for the sandbox.
// Server-only: credentials come from environment variables and never reach the browser.
// `fetch` is injectable so tests can run without network access or real keys.
import type { CheckoutReservation } from "../services/payments.ts";

export interface PayPalConfig {
  clientId: string;
  clientSecret: string;
  apiBase: string;
  webhookId?: string;
  fetch?: typeof fetch;
}

export class PayPalError extends Error {
  status: number;
  issue?: string;
  debugId?: string;
  constructor(status: number, message: string, issue?: string, debugId?: string) {
    super(message);
    this.status = status;
    this.issue = issue;
    this.debugId = debugId;
  }
}

export interface PayPalCapture {
  orderId: string;
  orderStatus: string;
  captureId: string | null;
  captureStatus: string | null;
  amount: string | null;
  currency: string | null;
  raw: unknown;
}

export interface PayPalClient {
  createOrder(r: CheckoutReservation): Promise<{ id: string; status: string }>;
  captureOrder(orderId: string, requestId: string): Promise<PayPalCapture>;
  getOrder(orderId: string): Promise<PayPalCapture>;
  verifyWebhook(headers: Headers, event: unknown): Promise<boolean>;
}

const TIMEOUT_MS = 20_000;

/** Reads PayPal settings from the environment; null when checkout is not configured yet. */
export function paypalConfigFromEnv(): PayPalConfig | null {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return {
    clientId,
    clientSecret,
    apiBase: process.env.PAYPAL_API_BASE || "https://api-m.sandbox.paypal.com",
    webhookId: process.env.PAYPAL_WEBHOOK_ID || undefined,
  };
}

export function paypalConfigured() {
  return paypalConfigFromEnv() !== null && !!process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID;
}

/** Pulls the first capture out of a capture or GET-order response. */
export function readCapture(body: unknown): PayPalCapture {
  const b = body as {
    id?: string;
    status?: string;
    purchase_units?: { payments?: { captures?: { id?: string; status?: string; amount?: { value?: string; currency_code?: string } }[] } }[];
  };
  const c = b.purchase_units?.[0]?.payments?.captures?.[0];
  return {
    orderId: b.id ?? "",
    orderStatus: b.status ?? "",
    captureId: c?.id ?? null,
    captureStatus: c?.status ?? null,
    amount: c?.amount?.value ?? null,
    currency: c?.amount?.currency_code ?? null,
    raw: body,
  };
}

export function createPayPalClient(cfg: PayPalConfig): PayPalClient {
  const doFetch = cfg.fetch ?? fetch;
  let token: { value: string; expiresAt: number } | null = null;

  async function accessToken() {
    if (token && token.expiresAt > Date.now() + 60_000) return token.value;
    const res = await doFetch(`${cfg.apiBase}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
    if (!res.ok || !body.access_token) throw new PayPalError(res.status, `PayPal authentication failed: ${body.error_description ?? res.status}`);
    token = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 300) * 1000 };
    return token.value;
  }

  async function call(path: string, init: { method: string; body?: unknown; requestId?: string }) {
    const res = await doFetch(`${cfg.apiBase}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${await accessToken()}`,
        "Content-Type": "application/json",
        ...(init.requestId ? { "PayPal-Request-Id": init.requestId } : {}),
        Prefer: "return=representation",
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => ({}))) as { message?: string; debug_id?: string; details?: { issue?: string; description?: string }[] };
    if (!res.ok) {
      const issue = body.details?.[0]?.issue;
      throw new PayPalError(res.status, body.details?.[0]?.description ?? body.message ?? `PayPal request failed (${res.status})`, issue, body.debug_id);
    }
    return body as unknown;
  }

  return {
    async createOrder(r) {
      const usd = (value: string) => ({ currency_code: r.currency, value });
      const body = (await call("/v2/checkout/orders", {
        method: "POST",
        requestId: r.paypalRequestId,
        body: {
          intent: "CAPTURE",
          purchase_units: [
            {
              reference_id: r.reconciliationKey,
              custom_id: r.reconciliationKey,
              description: `CartWitness ${r.reconciliationKey}`,
              amount: {
                ...usd(r.amount),
                breakdown: { item_total: usd(r.breakdown.itemTotal), shipping: usd(r.breakdown.shipping), tax_total: usd(r.breakdown.tax) },
              },
              items: [{ name: r.item.name.slice(0, 127), sku: r.item.sku, quantity: String(r.item.quantity), unit_amount: usd(r.item.unitPrice) }],
            },
          ],
          payment_source: { paypal: { experience_context: { shipping_preference: "NO_SHIPPING", user_action: "PAY_NOW" } } },
        },
      })) as { id?: string; status?: string };
      if (!body.id) throw new PayPalError(502, "PayPal did not return an order id.");
      return { id: body.id, status: body.status ?? "" };
    },

    async captureOrder(orderId, requestId) {
      return readCapture(await call(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, { method: "POST", requestId, body: {} }));
    },

    async getOrder(orderId) {
      return readCapture(await call(`/v2/checkout/orders/${encodeURIComponent(orderId)}`, { method: "GET" }));
    },

    async verifyWebhook(headers, event) {
      if (!cfg.webhookId) return false;
      const h = (n: string) => headers.get(n) ?? "";
      if (!h("paypal-transmission-id") || !h("paypal-transmission-sig")) return false;
      const body = (await call("/v1/notifications/verify-webhook-signature", {
        method: "POST",
        body: {
          auth_algo: h("paypal-auth-algo"),
          cert_url: h("paypal-cert-url"),
          transmission_id: h("paypal-transmission-id"),
          transmission_sig: h("paypal-transmission-sig"),
          transmission_time: h("paypal-transmission-time"),
          webhook_id: cfg.webhookId,
          webhook_event: event,
        },
      })) as { verification_status?: string };
      return body.verification_status === "SUCCESS";
    },
  };
}

let shared: PayPalClient | null = null;

/** Process-wide client from env, or null when PayPal keys are not set yet. */
export function getPayPal(): PayPalClient | null {
  const cfg = paypalConfigFromEnv();
  if (!cfg) return null;
  shared ??= createPayPalClient(cfg);
  return shared;
}
