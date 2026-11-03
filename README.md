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

Nothing in this repo simulates a payment. Without PayPal keys the checkout button is disabled and says why.

## Quick start (no external services needed)

Requirements: **Node.js ≥ 22.18** (runs the TypeScript scripts natively) and npm.

```bash
npm install
npm run setup      # creates .env.local, a signing key, the database and demo accounts
npm run dev
```

Open http://localhost:3000 and sign in as `buyer@demo.cartwitness.test` (or `merchant@demo.cartwitness.test`).
The password is `SEED_DEMO_PASSWORD` in `.env.local`. Visit **/setup** to see which keys are still missing.

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

## Deploying (Supabase + Vercel/Render)

1. Create a Supabase project, copy its Postgres connection string into `DATABASE_URL`.
2. `npm run keys:generate` → set `CW_SIGNING_PRIVATE_KEY` on the host (keep it secret).
3. `npm run db:migrate` and `npm run db:seed` with those env vars set.
4. Deploy with the same env vars.

Full guide with smoke-test checklist: [docs/DEPLOY.md](docs/DEPLOY.md). Production refuses to run without `DATABASE_URL`.

## Branches

- `dev` — active development; every commit passes typecheck, lint, tests and build (CI enforces this).
- `final` — tested, stable features only; promoted from `dev` after a phase is verified end to end in a browser.

## How approval integrity works

1. **Review** — the server validates the draft, builds the canonical terms (sorted-key JSON, money as
   strings, `policy_id` + `version` included), computes `sha256:` of it and shows the buyer the summary and fingerprint.
2. **Approve** — the browser posts back that fingerprint plus the three consent checkboxes. The server
   recomputes the hash from the stored draft; if it differs from what was reviewed (or the posted one), approval is refused.
3. **Record** — an immutable `permission_versions` row (DB trigger blocks UPDATE/DELETE), an Ed25519
   signature over the approval record (public key at `GET /api/keys`), and a hash-chained `evidence_events` entry.
4. **Edit** — creates version *n+1*; version *n* is never rewritten. **Revoke** stops future use only.

Assurance is labelled **application-signed**: it proves the record has not changed since CartWitness signed it
after an authenticated session approved it. It is *not* cryptographic proof of which human clicked approve —
the WebAuthn/passkey upgrade is a stretch goal. CartWitness is AP2-*inspired*, not AP2-certified.

More: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [docs/PHASES.md](docs/PHASES.md) · [docs/DEPLOY.md](docs/DEPLOY.md) · [docs/DEMO.md](docs/DEMO.md) (demo script + Devpost text) · [docs/PAYPAL_INTEGRATION.md](docs/PAYPAL_INTEGRATION.md)

## License

[MIT](LICENSE)
