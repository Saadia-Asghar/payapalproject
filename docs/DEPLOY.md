# Deploying the judge demo

Target: a public HTTPS URL that stays up through judging (1–15 Dec 2026), backed by Supabase
Postgres. Vercel is the simplest host; Render works the same way with `npm run build` /
`npm start`.

## 1. Database (Supabase)

1. Create a Supabase project.
2. Project Settings → Database → copy the **Session pooler** connection string (port 5432).
3. From your machine, with that string in `.env.local` as `DATABASE_URL`:

```bash
npm run db:migrate
SEED_DEMO_PASSWORD='choose-a-judge-password' npm run db:seed
```

Migrations are append-only SQL; each file applies once, so re-running is safe.

## 2. Signing key

```bash
npm run keys:generate
```

Copy the printed `CW_SIGNING_PRIVATE_KEY=…` line into the host's environment variables only.
Keep the same key for the whole judging period so passports keep verifying. If you rotate it,
the old public key stays in `signing_keys`, so older records still verify.

## 3. Host (Vercel)

1. Import the GitHub repo, branch **`final`**.
2. Environment variables (Production):

| Variable | Value |
|---|---|
| `DATABASE_URL` | Supabase connection string |
| `CW_SIGNING_PRIVATE_KEY` | from step 2 |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `NEXT_PUBLIC_PAYPAL_CLIENT_ID`, `PAYPAL_WEBHOOK_ID` | sandbox app (Phase 3) |
| `PAYPAL_API_BASE` | `https://api-m.sandbox.paypal.com` |

3. Deploy. Production refuses to start without `DATABASE_URL`: the embedded database is for
   local development only, because serverless hosts have no persistent disk.
4. If using webhooks, register `https://<your-domain>/api/paypal/webhooks` on the sandbox app and
   put its id in `PAYPAL_WEBHOOK_ID`.

## 4. Smoke test after each deploy

- [ ] `/login` → `buyer@demo.cartwitness.test` signs in
- [ ] Create and approve a permission; the receipt shows both integrity checks ✓
- [ ] Shop → size 9 is BLOCK, white size 10 is ALLOW → approve the cart
- [ ] `merchant@demo.cartwitness.test` → `/merchant` lists the checks; open a sample dispute
- [ ] `/merchant/catalog` → raise the price → the buyer's approved cart says it no longer applies
- [ ] `/api/keys` lists the signing key
- [ ] (Phase 3) Sandbox checkout → Passport → `/verify/CW-PP-…` is ✓ and an edited bundle is ✗

## Judge access

Give judges the two demo emails and the seeded password in the Devpost testing-instructions
field, never in the repository. Re-run `npm run db:seed` to reset passwords.
