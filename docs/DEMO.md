# Demo script (under 3 minutes) and submission text

Record against the deployed `final` branch. Two browser profiles help: one for the buyer
(**Try as buyer** on `/login` gives a fresh private account), one for the merchant (**Try as merchant**).
Use a device with a passkey method (Touch ID, Face ID, Windows Hello, or a phone via QR).

## Setup before recording

- [ ] `npm run db:seed` (fresh demo accounts); set `ANTHROPIC_API_KEY` if you want Claude suggestions
- [ ] Buyer window: `/login` → **Try as buyer**. Merchant window: `/login` → **Try as merchant**
- [ ] PayPal sandbox buyer account signed out, so the PayPal popup shows its sign-in

## Script

| Time | Screen and action | Say |
|---|---|---|
| 0:00–0:20 | Home page | “AI agents can now shop for us. But ‘buy me shoes’ doesn’t tell anyone which shoes, which seller or what total was actually allowed. CartWitness makes that permission explicit, enforced and provable.” |
| 0:20–0:55 | New permission → type the spec request → **Suggest fields** → fields fill with “AI-suggested” badges → fix one field → Review → **🔐 Create a passkey & approve** | “Claude turns my words into a form, but suggestions are never consent. I check every field, review a plain-English summary with a fingerprint of the exact terms, tick three confirmations — and approve with my passkey. My device signs that exact fingerprint, so the approval is provably mine, not just a click in a logged-in browser.” |
| 0:55–1:25 | Start shopping → agent picks → check size 9 (BLOCK, size), $149 + $12 (BLOCK, $11 over), the look-alike “Demo Sneaker Store” (BLOCK, seller ID) | “The agent suggests; code decides. Every cart is rebuilt from the trusted catalog. The wrong size, the hidden shipping fee and a look-alike seller are all blocked — even the product that tells the AI to ignore its rules.” |
| 1:25–2:05 | Check the white size-10 ($120) → ALLOW → approve the exact cart with the passkey → PayPal sandbox checkout → Passport | “Only an exact allowed cart reaches PayPal, and I still approve payment in PayPal. The capture is verified server-side and the single-use permission is consumed.” *(needs PayPal sandbox keys — see /setup)* |
| 2:05–2:30 | Passport → download bundle → `/verify` → paste → ✓ → change the amount → ✗ | “The Purchase Passport links my approved terms, the cart, my cart approval and the PayPal IDs. Change one character and verification fails.” |
| 2:30–2:55 | Merchant window → catalog: raise the price → the buyer’s approved cart now says it no longer applies → merchant opens a SAMPLE “I didn’t approve this” dispute → packet | “If a price changes after approval, the old approval stops working. And when a buyer disputes, the merchant gets facts — what was approved, what’s missing — clearly labelled as a sample.” |

If PayPal isn’t ready, skip 1:25–2:05 and show the approved cart page instead. Never show a fake payment.

## Devpost text (draft)

**Tagline:** Proof of human permission for AI-powered purchases.

**What it does.** Before an AI agent shops, the buyer fills out a Purchase Permission Form —
optionally pre-filled by Claude from plain English — and explicitly approves an exact, versioned
set of terms. Every cart the agent proposes is rebuilt from trusted catalog data and checked by a
deterministic policy engine (ALLOW / REVIEW / BLOCK, rule by rule). Only an exact, buyer-approved
cart can reach a real PayPal sandbox checkout. The resulting Purchase Passport links the signed
approval, the evaluated cart and the PayPal capture, and anyone can verify it without seeing
personal data. Merchants get a dispute workspace with evidence packets that list what is proven
and what is missing.

**How we built it.** Next.js 16 and TypeScript, PostgreSQL (Supabase), PayPal Orders v2, Claude
structured outputs for form suggestions, Ed25519 signatures over canonical JSON, append-only
tables enforced by database triggers, and a hash-chained audit log. Automated tests cover the
spec’s demonstration matrix plus tampering, replay and price-change attacks.

**Buyer-bound approvals.** With a passkey, the buyer's device signs a WebAuthn challenge derived
from the exact terms hash and, separately, the exact cart hash (user verification required). The
assertions and public key travel inside the Purchase Passport, so anyone can re-verify them.

**Honest limits.** A passkey proves the holder of a passkey registered to that account approved the
exact terms and cart — not their legal identity. Accounts without a passkey get application-signed
approvals, labelled as such. Records are tamper-evident, not tamper-proof. Disputes in the demo are labelled samples. The design
is AP2-inspired, not AP2-compliant.

**Judge access (testing instructions).** Open the site → **Sign in** → **Try as buyer** (a fresh,
private account, no password) or **Try as merchant**. Payments are PayPal sandbox only; use a PayPal
sandbox *personal* account to approve checkout (put its email/password in the testing-instructions
field, never in the repo). The seeded `buyer@`/`merchant@demo.cartwitness.test` accounts also work
with the password given there.
