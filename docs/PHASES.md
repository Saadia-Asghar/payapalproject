# Implementation phases

Each phase ends with working, tested behaviour — no static mock screens.
`dev` receives work in progress; a phase is merged to `final` only after its tests pass and
the flow has been exercised end to end in a browser.

| Phase | Scope | Done when | Status |
|-------|-------|-----------|--------|
| **0 — Foundation** | Next.js + TS + Tailwind, DB layer (Postgres / PGlite), migrations, seed, sessions, Ed25519 keys, audit hash chain | `npm test` green, `npm run dev` boots on a fresh clone with zero external services | ✅ |
| **1 — Purchase Permission Form** | Screen 1 form, Screen 2 review + 3 consent checkboxes, Screen 3 receipt, versioning, revoke, expiry | Incomplete form can't be approved; approved hash = shown hash; v1 immutable after v2 | ✅ |
| **P0 gate — PayPal sandbox proof** | Create → buyer approve → capture against sandbox with real credentials | A real sandbox capture ID stored from PayPal's server response | ⏳ needs sandbox credentials |
| **2 — Catalog + policy engine** | Seeded trusted catalog, agent suggestion (AI optional), deterministic ALLOW/REVIEW/BLOCK with per-rule explanations, canonical cart hash, prompt-injection-safe | Demo test matrix rows 1–6 pass as automated tests | ⏳ |
| **3 — PayPal checkout** | `/api/checkout/create` policy gate → Orders v2 (custom_id, PayPal-Request-Id), JS SDK buyer approval, server capture + GET reconcile, single-use consume, webhooks w/ signature verification | Duplicate create/capture produce no second transaction; fake webhook rejected | ⏳ |
| **4 — Purchase Passport + verification** | Signed proof bundle (permission version + cart + PayPal IDs + audit chain), `/verify/{id}` redacted public check, tamper demo | Edited bundle fails verification | ⏳ |
| **5 — Merchant workspace + sample disputes** | Merchant role, attempts list, SAMPLE-labelled dispute intake, grounded evidence packet, reviewer step, JSON/PDF export | Missing evidence listed; sample never shown as real | ⏳ |
| **Stretch** | WebAuthn approval bound to terms hash; real Disputes API (if permitted); AG Studio dashboard | Only after P0–5 work end to end | — |

## PayPal permission dependencies (flagged)

| Feature | Needs | Fallback if unavailable |
|---------|-------|-------------------------|
| Orders v2 create/capture | Sandbox REST app (client id/secret) + sandbox buyer & business accounts | **None** — this is the P0 gate. If developer signup is blocked from Pakistan, ask organizers on the hackathon Discord (FAQ). |
| Webhooks | Webhook id registered on the sandbox app, public HTTPS URL (deploy or tunnel) | Server-side GET order reconciliation still verifies captures |
| Refunds `/v2/payments/captures/{id}/refund` | Standard sandbox merchant permission (usually present) | Show "refund not issued" |
| Disputes API `/v1/customer/disputes` | Dispute read scope on the app; sandbox disputes only exist if created from the buyer account | Clearly labelled SAMPLE disputes (spec-approved) |
| Unattended / vaulted charging | Vault / reference transactions approval | **Not used.** MVP always requires buyer approval in PayPal |
