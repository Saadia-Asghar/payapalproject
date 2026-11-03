# CartWitness

**Proof of human permission for AI-powered purchases** — PayPal AI Hackathon 2026.

Before an AI agent may shop, the buyer fills out and explicitly approves a **Purchase Permission Form**.
CartWitness stores that exact approved version (hashed, signed, immutable), checks every proposed cart
against it on the server, sends only permitted carts to a real PayPal sandbox checkout, and links the
payment to a verifiable **Purchase Passport** for disputes.

> The customer defines the permission. AI interprets the request. Code enforces the rules.
> PayPal handles the payment. Evidence preserves what happened.

## Status

| Phase | What works | |
|---|---|---|
| 0 Foundation | Next.js 16 + TS, Postgres/PGlite, migrations, sessions, Ed25519 signing, hash-chained audit log | ✅ |
| 1 Purchase Permission Form | Form → review (plain-English summary + terms fingerprint + 3 consents) → signed immutable version → receipt; versioning; revoke; expiry; optional Claude-suggested fields from plain English (badged, never auto-approved, recorded in approval evidence) | ✅ |
| 2 Catalog + policy engine | Agent picks → server-built cart → ALLOW/REVIEW/BLOCK with "what you allowed vs. what AI selected" → buyer approves the exact cart (rejected if price changed) | ✅ |
| 3 PayPal checkout | Policy-gated Orders v2 create → PayPal buyer approval → server capture → Passport; idempotent, revocation-safe, verified webhooks | ✅ code + mocked tests · ⏳ live sandbox run once keys are added |
| 4 Purchase Passport | Signed proof bundle on verified capture, owner page + JSON download, public redacted `/verify`, paste-a-bundle tamper check | ✅ |
| 5 Merchant workspace | Store-scoped cart checks, SAMPLE disputes with grounded evidence packets (provided vs missing), reviewer step, JSON export | ✅ |
| 6 Buyer-bound approval | **Passkeys (WebAuthn)**: the buyer's device signs a challenge derived from the exact terms hash and the exact cart hash; proofs embedded in records and re-verified in the Passport; no downgrade once a passkey exists; passkey sign-in | ✅ |
| Judge access | **One-click demo**: "Try as buyer" (fresh private account) / "Try as merchant" on the sign-in page | ✅ |

Nothing in this repo simulates a payment. Without PayPal keys the checkout button is disabled and says why.

## Quick start (no external services needed)

Requirements: **Node.js ≥ 22.18** (runs the TypeScript scripts natively) and npm.

```bash
npm install
npm run setup      # creates .env.local, a signing key, the database and demo accounts
npm run dev
```

Open http://localhost:3000/login and click **Try as buyer** or **Try as merchant** — no password needed.
The seeded accounts `buyer@demo.cartwitness.test` / `merchant@demo.cartwitness.test` also work with `SEED_DEMO_PASSWORD`
from `.env.local`. Visit **/setup** to see which keys are still missing.

Add keys later in `.env.local` and restart: PayPal sandbox keys turn on checkout ([docs/PAYPAL_INTEGRATION.md](docs/PAYPAL_INTEGRATION.md));
`ANTHROPIC_API_KEY` turns on Claude form suggestions. Without them the app runs and says what is unavailable.

With `DATABASE_URL` empty, an embedded PostgreSQL (PGlite) is created in `.data/` and migrated
automatically, and a development signing key is generated in `.data/dev-signing-key.pem`.
`.data/` is git-ignored — delete it to reset everything.

## Scripts

| Command | Purpose |
|---|---|
| `npm run setup` | First run: `.env.local`, signing key, database, demo accounts |
| `npm run dev` | Dev server on :3000 |
| `npm run smoke` | End-to-end HTTP check of every API and page against a running server (`BASE_URL`) |
| `npm test` | Unit + integration tests (in-memory Postgres) |
| `npm run typecheck` / `npm run lint` | Static checks (run `npx next typegen` once on a fresh clone) |
| `npm run build` | Production build |
| `npm run db:migrate` | Apply `db/migrations/*.sql` to `DATABASE_URL` |
| `npm run db:seed` | Create/reset demo buyer + merchant accounts |
| `npm run keys:generate` | Print a new Ed25519 signing key for `CW_SIGNING_PRIVATE_KEY` |

## Environment variables

All documented in [.env.example](.env.example). **Never commit `.env.local` or real values.**

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | prod | Supabase/Postgres connection string. Empty → embedded PGlite |
| `DATABASE_SSL` | no | `disable` for local non-TLS Postgres |
| `CW_SIGNING_PRIVATE_KEY` | prod | Base64 PKCS#8 Ed25519 PEM from `npm run keys:generate` |
| `SEED_DEMO_PASSWORD` | no | Demo account password used by `db:seed` |
| `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` / `PAYPAL_API_BASE` / `PAYPAL_WEBHOOK_ID` / `NEXT_PUBLIC_PAYPAL_CLIENT_ID` | Phase 3 | Sandbox app credentials |
| `ANTHROPIC_API_KEY` / `CW_AI_MODEL` | optional | Claude pre-fills Permission Form fields for buyer review (default model `claude-opus-5-5`); without a key a rule-based parser is used |
| `CW_DEMO_LOGIN` | no | `off` hides one-click demo sign-in (on by default) |
| `CW_WEBAUTHN_RP_ID` | no | Passkey relying-party ID; defaults to the site's hostname (passkeys work on the domain they were created on) |

## Deploying (Vercel + Supabase)

Set `DATABASE_URL`, `CW_SIGNING_PRIVATE_KEY` and `SEED_DEMO_PASSWORD` (plus PayPal keys) in Vercel and deploy the `final` branch —
the build applies migrations and creates the demo accounts automatically. Step-by-step: [docs/DEPLOY.md](docs/DEPLOY.md).
Check a deployment end to end with `BASE_URL=https://<domain> npm run smoke`.

## Branches

- `dev` — active development; every commit passes typecheck, lint, tests and build (CI enforces this).
- `final` — tested, stable features only; promoted from `dev` after a phase is verified end to end in a browser.

## How approval integrity works

1. **Review** — the server validates the draft, builds the canonical terms (sorted-key JSON, money as
   strings, `policy_id` + `version` included), computes `sha256:` of it and shows the buyer the summary and fingerprint.
2. **Approve** — the browser posts back that fingerprint plus the three consent checkboxes. The server
   recomputes the hash from the stored draft; if it differs from what was reviewed (or the posted one), approval is refused.
3. **Passkey (buyer-bound)** — the server issues a WebAuthn challenge equal to
   `SHA-256(canonical{domain, purpose, policy_id, version, terms_hash, nonce})`. The buyer's authenticator signs
   `authenticatorData ‖ SHA-256(clientDataJSON)` with user verification (Face ID / Touch ID / Windows Hello / PIN).
   The server checks origin, RP ID, UV flag, counter and that the challenge commits to *these* terms. The same is done
   for the exact cart (`cart_attempt_id, cart_hash`). Once an account has a passkey, session-only approval is refused.
4. **Record** — an immutable `permission_versions` row (DB trigger blocks UPDATE/DELETE) containing the passkey
   assertion + public key, an Ed25519 application signature over the whole approval record (public key at
   `GET /api/keys`), and a hash-chained `evidence_events` entry.
5. **Edit** — creates version *n+1*; version *n* is never rewritten. **Revoke** stops future use only.

Assurance levels, stated exactly:
- **PASSKEY_VERIFIED** — the holder of a passkey registered to this account approved *these exact terms* and *this
  exact cart*, with user verification. Anyone can re-check it from the Passport bundle alone (challenge recomputed from
  the data, signature checked with the embedded public key). It does not prove the legal identity behind the account.
- **APPLICATION_SIGNED** — (accounts without a passkey) the record is unchanged since CartWitness signed it after an
  authenticated session approved it; not cryptographic proof of which human clicked approve.

CartWitness is AP2-*inspired*, not AP2-certified.

More: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [docs/PHASES.md](docs/PHASES.md) · [docs/DEPLOY.md](docs/DEPLOY.md) · [docs/DEMO.md](docs/DEMO.md) (demo script + Devpost text) · [docs/PAYPAL_INTEGRATION.md](docs/PAYPAL_INTEGRATION.md)

## License

[MIT](LICENSE)
