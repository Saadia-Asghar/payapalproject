# CartWitness — Architecture

> The customer defines the permission. AI interprets the request. Code enforces the rules.
> PayPal handles the payment. Evidence preserves what happened.

## 1. System overview

```
 ┌──────────────┐   ┌───────────────┐
 │ Buyer portal │   │Merchant portal│        Next.js App Router (server components + client forms)
 └──────┬───────┘   └──────┬────────┘
        │  same-origin JSON (session cookie, Origin check)
 ┌──────▼──────────────────▼─────────────────────────────────────────────┐
 │ Route handlers  /api/*            (thin: auth → validate → service)    │
 ├────────────────────────────────────────────────────────────────────────┤
 │ Services (src/server/services)                                         │
 │   permissions  — draft, review, approve (versioned), revoke            │
 │   policy       — deterministic ALLOW / REVIEW / BLOCK  (Phase 2)       │
 │   checkout     — server-side policy gate + PayPal adapter (Phase 3)    │
 │   passports    — proof bundle + verification (Phase 4)                 │
 │   disputes     — sample cases + evidence packets (Phase 5)             │
 ├──────────────┬───────────────┬──────────────┬──────────────────────────┤
 │ AI parser    │ Proof service │ PayPal       │ Audit log                │
 │ (suggests    │ canonical JSON│ adapter      │ append-only hash chain   │
 │  only)       │ SHA-256,      │ Orders v2,   │ (evidence_events)        │
 │              │ Ed25519       │ webhooks     │                          │
 └──────────────┴───────────────┴──────────────┴──────────────────────────┘
                         │
                 PostgreSQL (Supabase in deploy; embedded PGlite for local dev/tests)
```

Trust boundaries:

| Source                         | Trusted for                                   |
|--------------------------------|-----------------------------------------------|
| Buyer (authenticated session)  | Permission terms they explicitly approve       |
| AI model output                | **Nothing.** Suggestions shown for human edit |
| Product text / descriptions    | **Nothing.** Treated as untrusted data         |
| `catalog_products` (server DB) | SKU, merchant id, price, shipping, tax, stock  |
| PayPal server API responses    | Order / capture state and amounts              |
| Browser redirects from PayPal  | **Nothing** until reconciled server-side       |

## 2. Folder structure

```
src/
  app/                        Next.js routes (UI pages + /api route handlers)
    api/auth/{login,logout}
    api/permissions/...       create / draft / review / approve / revoke
    api/keys                  public verification keys
    login/  permissions/...   screens
  components/                 UI components (client + server)
  lib/
    permissions/terms.ts      Zod schema for permission terms (shared client/server)
    permissions/summary.ts    deterministic plain-English summary (shared)
    crypto/canonical.ts       canonical JSON serialization (shared)
  server/                     server-only code
    db/client.ts              Postgres (DATABASE_URL) or embedded PGlite; thin typed SQL layer
    db/migrate.ts             ordered SQL migration runner
    crypto/{hash,signing}.ts  SHA-256, Ed25519 sign/verify, key loading
    auth/                     password hashing, sessions, request guards
    audit.ts                  append-only hash-chained evidence log
    services/permissions.ts   permission lifecycle (the core of Phase 1)
db/migrations/*.sql           schema source of truth (append-only migrations)
scripts/                      migrate, seed, key generation
tests/                        vitest unit + integration (PGlite in-memory)
docs/                         architecture, phases, PayPal permission notes
```

## 3. Permission lifecycle (Phase 1)

```
create ──► DRAFT (draft_json editable)
             │ PUT /draft          (any edit clears the reviewed hash)
             ▼
          POST /review  → server validates, canonicalizes, returns
             │            {canonical terms, terms_hash, summary}
             ▼            and stores reviewed_terms_hash
          POST /approve { terms_hash, consents[3] }
             │  server recomputes hash from stored draft;
             │  must equal reviewed hash AND posted hash (else 409)
             ▼
          INSERT permission_versions (immutable; DB trigger blocks UPDATE/DELETE)
          sign approval record with Ed25519 ("application-signed")
          append evidence_events (hash chain)
          permissions.status = ACTIVE, active_version = n
             │
   edit ──► new draft → review → approve ⇒ version n+1 (version n stays read-only)
   revoke ─► REVOKED  (future attempts rejected; captured payments untouched)
   expiry ─► EXPIRED  (computed from active version's expires_at, enforced server-side)
   use    ─► CONSUMED (single-use; set when a payment is captured — Phase 3)
```

Why the hash round-trip: the review screen displays exactly the server-produced canonical
terms and their SHA-256. Approval is accepted only if the buyer posts back that same hash and
the stored draft still produces it. That makes "the stored approved hash matches the shown
terms" a checked invariant rather than an assumption.

### Canonicalization
`canonicalJson()` = JSON with object keys sorted by UTF-16 code unit order, no insignificant
whitespace, arrays kept in order, `undefined` members dropped, only finite numbers allowed.
Money is always a decimal **string** (`"150.00"`) so no float formatting can change a hash.
This matches RFC 8785 (JCS) for the value shapes CartWitness produces.

### Signatures
Approval records are signed with Ed25519 over a domain-separated message
`"cartwitness/permission-approval/v1\n" + canonicalJson(record)`. Public keys are exposed at
`GET /api/keys`. This is an **application signature**: it proves the record has not changed
since CartWitness signed it — not that a specific human personally saw the terms.

### Passkey (WebAuthn) approvals — buyer-bound
`src/server/auth/webauthn.ts`. For an approval the WebAuthn challenge is
`base64url(SHA-256(canonicalJson({domain: "cartwitness/passkey-approval/v1", purpose, ..., nonce})))`, where
`...` is `policy_id, version, terms_hash` (permission) or `cart_attempt_id, cart_hash` (cart). The challenge is
stored single-use (5 min) in `webauthn_challenges`. On approve the server re-derives the expected binding
from the database, checks the stored challenge commits to it, then verifies the assertion (origin, RP ID,
UP+UV flags, signature counter) against the registered public key in `webauthn_credentials`. The proof
(`credential_id, public_key, rp_id, origin, challenge_inputs, authenticator_data, client_data_json, signature`)
is embedded in the approval record (permission) or `cart_attempts.buyer_cart_approval` (cart) and copied into
the Purchase Passport, whose verifier recomputes the challenge from the data and checks the signature with
the embedded key — no database needed. Once an account has a passkey, session-only approval is refused
(`PASSKEY_REQUIRED`), so assurance cannot be downgraded. Passkeys also allow usernameless sign-in.

## 4. Security controls in Phase 1
- Session cookie: random 32-byte token, only its SHA-256 stored server-side; `HttpOnly`,
  `SameSite=Lax`, `Secure` in production; 12h expiry.
- Passwords: `scrypt` (N=16384, r=8, p=1) with per-user salt, timing-safe compare.
- Every mutating API checks `Origin` against the app origin (CSRF defence in depth).
- Ownership check on every permission access (buyer can't read/approve another account's).
- All inputs validated by Zod; merchant ids validated against `merchants` table (not names).
- `permission_versions` and `evidence_events` are append-only, enforced by DB triggers.
- No secrets in the repo: `.env*` is git-ignored; `.env.example` documents every variable.
