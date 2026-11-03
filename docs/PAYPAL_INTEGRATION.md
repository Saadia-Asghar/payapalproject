# PayPal integration (Phase 3)

PayPal sandbox checkout is implemented and tested against a mocked PayPal server. It switches on
as soon as sandbox keys are added; until then the app says so and takes no payment.

## Turn it on

1. developer.paypal.com → **Apps & Credentials → Sandbox → Create App**.
2. Put the values in `.env.local` (local) or your host's environment:

| Variable | Value |
|---|---|
| `PAYPAL_CLIENT_ID` | the app's Client ID |
| `NEXT_PUBLIC_PAYPAL_CLIENT_ID` | the same Client ID (used by the PayPal buttons in the browser) |
| `PAYPAL_CLIENT_SECRET` | the app's Secret — server only, never commit |
| `PAYPAL_API_BASE` | `https://api-m.sandbox.paypal.com` (default) |
| `PAYPAL_WEBHOOK_ID` | optional — see Webhooks below |

3. Restart the server. `/setup` shows **PayPal sandbox checkout ✓** when ready.
4. Pay with a **sandbox personal account** (Testing Tools → Sandbox Accounts), never a real one.

## How the flow works

```
Buyer approves exact cart ─► Pay with PayPal (JS SDK button)
  createOrder ─► POST /api/checkout/create        reserveCheckout(): policy gate + reservation
                    └─ PayPal POST /v2/checkout/orders  (PayPal-Request-Id = idempotency key,
                                                         custom_id = CW-CASE-xxxxx, trusted amounts)
  buyer approves in the PayPal window
  onApprove  ─► POST /api/checkout/{id}/capture    assertCapturable(): permission re-checked
                    └─ PayPal POST /v2/checkout/orders/{id}/capture
                    └─ recordCapture(): COMPLETED + exact amount/currency/order, consume permission,
                                        issue Purchase Passport (atomic)
  ─► /passports/CW-PP-xxxxx
```

| File | Role |
|---|---|
| `src/server/paypal/client.ts` | OAuth token (cached), create / capture / get order, webhook signature verification |
| `src/server/services/checkout.ts` | Orchestration, ownership checks, PayPal error mapping, webhook reconciliation |
| `src/server/services/payments.ts` | The only code that changes payment state (policy gate, idempotency, single use) |
| `src/app/api/checkout/create`, `…/[paymentOrderId]/capture`, `…/cancel` | Buyer routes (session + same-origin) |
| `src/app/api/paypal/webhooks` | PayPal → server; authenticity from PayPal signature verification only |
| `src/components/PayPalCheckout.tsx` | PayPal buttons; shows "not configured" without keys |

## Guarantees (covered by `tests/checkout.test.ts`)

- Double-clicking Pay or retrying never creates a second PayPal order or capture.
- A capture whose amount, currency or order differs from the reservation is refused; no Passport.
- Revoking or expiring the permission between PayPal approval and capture blocks the capture.
- A lost capture response is reconciled (`ORDER_ALREADY_CAPTURED` → read the order → record).
- Declines and pending captures are reported honestly; closing the PayPal window charges nothing,
  and the buyer can click Pay again.
- Another user cannot capture or cancel someone else's checkout.
- A webhook with a bad signature is rejected with no state change; verified webhooks are deduplicated
  and reconciled by re-reading the order from PayPal (the webhook body is never trusted).

## Webhooks (optional)

Captures are confirmed synchronously, so webhooks only matter if the buyer's browser disappears
mid-capture. To enable: deploy (public HTTPS), add a webhook on the sandbox app pointing to
`https://<your-domain>/api/paypal/webhooks` with events **PAYMENT.CAPTURE.COMPLETED** and
**CHECKOUT.ORDER.COMPLETED**, and put its id in `PAYPAL_WEBHOOK_ID`.

## Not done

- No refunds UI (a merchant refund via `/v2/payments/captures/{id}/refund` is a natural next step).
- Not yet run against the live PayPal sandbox — do the checklist in `docs/DEPLOY.md` once keys exist.
