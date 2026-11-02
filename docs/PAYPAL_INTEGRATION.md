# Phase 3 — PayPal integration guide (for the PayPal teammate)

Everything around PayPal is already built and tested: the policy gate, idempotency, single-use
consumption, the Purchase Passport, verification and dispute packets. The PayPal adapter only
has to **talk to PayPal** and call the functions in
[`src/server/services/payments.ts`](../src/server/services/payments.ts). It must never write
payment tables directly.

```
Buyer approves exact cart (done)                       CartWitness DB side (done)
        │
        ▼
POST /api/checkout/create {attempt_id}     ──► reserveCheckout()      policy gate + reservation
        │  PayPal POST /v2/checkout/orders  ◄──   returns amount, breakdown, custom_id, request id
        ▼
                                           ──► attachPayPalOrder()    stores PayPal order id
Buyer approves in PayPal popup (JS SDK)
        ▼
POST /api/checkout/{paymentOrderId}/capture ──► assertCapturable()    re-checks permission
        │  PayPal POST /v2/checkout/orders/{id}/capture
        ▼
                                           ──► recordCapture()        verifies + consumes + issues Passport
        ▼
redirect to /passports/{passportId}
```

## What you build (your files)

| File | Purpose |
|---|---|
| `src/server/paypal/client.ts` | OAuth2 token (client credentials, cached until expiry), `createOrder`, `captureOrder`, `getOrder`, `verifyWebhookSignature`. Base URL from `PAYPAL_API_BASE`. Server-only. |
| `src/app/api/checkout/create/route.ts` | Body `{ attempt_id }`. `requireUser("BUYER")` → `reserveCheckout` → if `paypalOrderId` is already set return it, else `createOrder` → `attachPayPalOrder` → return `{ id: paypalOrderId, paymentOrderId }`. |
| `src/app/api/checkout/[paymentOrderId]/capture/route.ts` | `requireUser("BUYER")`, check the payment order's `user_id` is the user → `assertCapturable` → `captureOrder` → `recordCapture` → return `{ passportId }`. |
| `src/app/api/paypal/webhooks/route.ts` | Verify the signature with `PAYPAL_WEBHOOK_ID`; dedupe in `webhook_events`; on `PAYMENT.CAPTURE.COMPLETED` call `getOrder`, then `recordCapture` (idempotent). Reject unverified events with no state change. |
| `src/components/PayPalCheckout.tsx` | PayPal JS SDK Buttons (`NEXT_PUBLIC_PAYPAL_CLIENT_ID`, `currency=USD`, `intent=capture`). `createOrder` → our create route; `onApprove` → our capture route → `router.push('/passports/' + passportId)`; `onCancel`/`onError` → show a message. |
| Cart page | Replace the disabled “Continue to PayPal” button in `src/app/permissions/[id]/carts/[attemptId]/page.tsx` (marked with a comment) with `<PayPalCheckout attemptId=… />`. |

All routes should use the existing `api()` wrapper from `src/server/http.ts` (same-origin check,
uniform errors) and `z.strictObject` request schemas, like the other routes.

## Exact PayPal calls

**Create order** — headers `Authorization: Bearer …` and `PayPal-Request-Id: reservation.paypalRequestId`.

```json
{
  "intent": "CAPTURE",
  "purchase_units": [{
    "custom_id": "<reservation.reconciliationKey>",
    "amount": {
      "currency_code": "<reservation.currency>",
      "value": "<reservation.amount>",
      "breakdown": {
        "item_total": { "currency_code": "USD", "value": "<breakdown.itemTotal>" },
        "shipping":   { "currency_code": "USD", "value": "<breakdown.shipping>" },
        "tax_total":  { "currency_code": "USD", "value": "<breakdown.tax>" }
      }
    },
    "items": [{
      "name": "<item.name>", "sku": "<item.sku>", "quantity": "<item.quantity>",
      "unit_amount": { "currency_code": "USD", "value": "<item.unitPrice>" }
    }]
  }]
}
```

Use only values returned by `reserveCheckout()`, never amounts from the browser.

**Capture** — `POST /v2/checkout/orders/{paypalOrderId}/capture` with header
`PayPal-Request-Id: <paypalRequestId>-capture`. From the response take
`purchase_units[0].payments.captures[0]` and call:

```ts
await recordCapture(db, {
  paymentOrderId,
  paypalOrderId: response.id,
  captureId: capture.id,
  captureStatus: capture.status,            // must be "COMPLETED"
  amount: capture.amount.value,             // must equal the reserved amount exactly, e.g. "120.00"
  currency: capture.amount.currency_code,
  rawResponse: response,                    // only its SHA-256 is stored
});
```

`recordCapture` refuses (and stores nothing) on a non-COMPLETED status, an amount, currency or
order mismatch, or a revoked, expired or already-used permission. It is idempotent for the same capture id.

## Error handling

| Situation | Call |
|---|---|
| Buyer closes the PayPal popup | `closeCheckout({ status: "CANCELLED", reason })` |
| PayPal returns a hard error on create/capture | `closeCheckout({ status: "FAILED", reason })` |
| Capture returns `PENDING` | Don't close; let the webhook or `getOrder` reconcile later |
| `ServiceError` from our functions | Return it as-is (the `api()` wrapper does this) |

## Environment variables (already in `.env.example`)

`PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_API_BASE=https://api-m.sandbox.paypal.com`,
`PAYPAL_WEBHOOK_ID`, `NEXT_PUBLIC_PAYPAL_CLIENT_ID`. Never commit values.

## Done when

- [ ] A real sandbox buyer completes checkout and lands on a Passport that verifies.
- [ ] Paying twice or retrying capture creates no second order or capture.
- [ ] Revoking the permission between create and capture blocks the capture.
- [ ] A webhook with a bad signature changes nothing.
- [ ] The full flow is recorded for the demo video.

Tests for the database side are in `tests/passports.test.ts` (they use fixed fake PayPal IDs as
test doubles). Please add route-level tests with a mocked PayPal HTTP client.
