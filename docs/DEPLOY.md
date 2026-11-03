# Deploying to Vercel

The repo is deploy-ready: on Vercel, `npm run vercel-build` applies database migrations and
creates the demo accounts automatically, then builds the app. You only add environment variables.
Verified end to end: production build + PostgreSQL code path + `npm run smoke` (24/24) on a fresh copy.

## 1. Database (Supabase, free tier is fine)

1. Create a Supabase project.
2. **Connect** → copy the **Transaction pooler** connection string (port 6543, `postgresql://postgres.<ref>:<password>@…pooler.supabase.com:6543/postgres`).
   The pooler suits serverless functions; SSL is handled automatically.

## 2. Secrets to generate once (on your machine)

```bash
npm run keys:generate
```

Copy the printed `CW_SIGNING_PRIVATE_KEY=…` value. Keep it for the whole judging period — passports
signed with it must keep verifying. Pick a demo password (10+ characters) for the judges.

## 3. Vercel project

1. vercel.com → **Add New → Project** → import `Saadia-Asghar/payapalproject`.
2. **Production Branch**: Settings → Git → set to **`final`** (the stable branch).
3. Framework preset: Next.js (auto-detected). Leave the build command as is — Vercel runs `vercel-build`.
4. **Environment Variables** (Production and Preview):

| Variable | Required | Value |
|---|---|---|
| `DATABASE_URL` | ✅ | Supabase transaction-pooler string from step 1 |
| `CW_SIGNING_PRIVATE_KEY` | ✅ | from step 2 |
| `SEED_DEMO_PASSWORD` | ✅ for the demo | the judge password; the build creates/refreshes the demo accounts with it |
| `PAYPAL_CLIENT_ID` / `NEXT_PUBLIC_PAYPAL_CLIENT_ID` | for payments | sandbox app Client ID (same value in both) |
| `PAYPAL_CLIENT_SECRET` | for payments | sandbox app Secret |
| `PAYPAL_API_BASE` | optional | `https://api-m.sandbox.paypal.com` (default) |
| `PAYPAL_WEBHOOK_ID` | optional | after step 6 |
| `ANTHROPIC_API_KEY` | optional | turns on Claude form suggestions (rule-based parser without it) |
| `CW_AI_MODEL` | optional | defaults to `claude-opus-5-5` |

5. **Deploy.** The build log shows `[deploy-prepare] applied migrations…` and `demo accounts ready`.
   Warnings there say exactly which variable is missing.
6. Optional webhooks: in the PayPal sandbox app add `https://<your-domain>/api/paypal/webhooks`
   (events `PAYMENT.CAPTURE.COMPLETED`, `CHECKOUT.ORDER.COMPLETED`), put its id in
   `PAYPAL_WEBHOOK_ID`, redeploy.

Adding or changing any `NEXT_PUBLIC_*` variable requires a redeploy (it is baked into the browser bundle).

## 4. Check the deployment

- Open `https://<your-domain>/setup` — every required row should be ✓.
- From your machine, run the full end-to-end check against the live site:

```bash
BASE_URL=https://<your-domain> SEED_DEMO_PASSWORD='<judge password>' npm run smoke
```

- Then buy once by hand with a PayPal **sandbox personal account** and open the resulting
  Purchase Passport → `/verify/CW-PP-…` should be ✓, and an edited bundle pasted into `/verify` ✗.

## Notes

- Production refuses to start without `DATABASE_URL` (serverless hosts have no persistent disk).
- Migrations are append-only and idempotent; every deploy re-checks them safely.
- Rate limits (login throttling, AI suggestions) are per serverless instance — fine for the demo.
- Judge access: put the demo emails and password in Devpost's testing-instructions field, never in the repo.
