// End-to-end smoke test over HTTP against a running server: `npm run smoke`.
// Drives every API and loads every page as the demo buyer and merchant, like a real user.
// Usage: BASE_URL=http://localhost:3000 npm run smoke   (password from SEED_DEMO_PASSWORD or .env.local)
// Creates demo records (a permission, cart checks, a sample dispute); changes no prices permanently.
import { existsSync, readFileSync } from "node:fs";
import { SoftAuthenticator } from "../tests/soft-authenticator.ts";

const BASE = (process.env.BASE_URL || "http://localhost:3000").replace(/\/$/, "");

function demoPassword() {
  if (process.env.SEED_DEMO_PASSWORD) return process.env.SEED_DEMO_PASSWORD;
  if (existsSync(".env.local")) {
    const m = /^SEED_DEMO_PASSWORD=(.+)$/m.exec(readFileSync(".env.local", "utf8"));
    if (m?.[1].trim()) return m[1].trim();
  }
  throw new Error("Set SEED_DEMO_PASSWORD or run `npm run setup` first.");
}

let passed = 0;
const failures: string[] = [];
async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  ✗ ${name}\n      ${err instanceof Error ? err.message : String(err)}`);
  }
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

class Client {
  cookie = "";
  async req(method: string, path: string, body?: unknown, raw?: string) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      redirect: "manual",
      headers: {
        ...(this.cookie ? { Cookie: this.cookie } : {}),
        ...(method !== "GET" ? { Origin: BASE, "Content-Type": "application/json" } : {}),
      },
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    const set = res.headers.get("set-cookie");
    const m = set && /cw_session=([^;]*)/.exec(set);
    if (m) this.cookie = m[1] ? `cw_session=${m[1]}` : "";
    const text = await res.text();
    // Response JSON is loosely typed test data; each step asserts the fields it relies on.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let json: Record<string, any> = {};
    try {
      json = JSON.parse(text);
    } catch {
      /* page HTML */
    }
    return { status: res.status, text, json };
  }
  async page(path: string, mustContain: string) {
    const r = await this.req("GET", path);
    assert(r.status === 200, `GET ${path} → ${r.status}`);
    assert(r.text.includes(mustContain), `GET ${path}: expected text "${mustContain}"`);
  }
}

const now = new Date();
const localDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
const deadline = new Date(Date.now() + 3 * 86_400_000).toISOString();
const CONSENTS = { checked_terms: true, ai_may_err: true, no_charge_yet: true };
const DRAFT = {
  request_text: "Smoke test",
  product_type: "running shoes",
  color: "white",
  size: "US M 10",
  condition: "NEW_ONLY",
  quantity: 1,
  max_total: "150",
  currency: "USD",
  merchant_ids: ["DEMO-SNEAKER-STORE"],
  expires_at: deadline,
  display_timezone: "UTC",
  substitutions: "ASK_FIRST",
  recurring: false,
  review_mode: "APPROVE_FINAL_CART",
  single_use: true,
  ai_suggested_fields: ["max_total"],
};

async function main() {
  console.log(`CartWitness smoke test → ${BASE}\n`);
  const password = demoPassword();
  const buyer = new Client();
  const merchant = new Client();
  const anon = new Client();
  const s: Record<string, string> = {};

  console.log("Public");
  await step("home, login, verify and setup pages load", async () => {
    await anon.page("/", "Decide what your AI may buy");
    await anon.page("/login", "Sign in");
    await anon.page("/verify", "Verify a Purchase Passport");
    await anon.page("/setup", "Setup status");
  });
  await step("protected pages redirect to sign-in", async () => {
    const r = await anon.req("GET", "/permissions");
    assert(r.status === 307 || r.status === 302, `expected redirect, got ${r.status}`);
  });
  await step("public signing keys are published", async () => {
    const r = await anon.req("GET", "/api/keys");
    assert(r.status === 200 && r.json.keys?.length >= 1, "no keys");
  });
  await step("cross-origin and unauthenticated API calls are refused", async () => {
    const res = await fetch(`${BASE}/api/permissions`, { method: "POST", headers: { Origin: "https://evil.example" } });
    assert(res.status === 403, `cross-origin → ${res.status}`);
    assert((await anon.req("POST", "/api/permissions")).status === 401, "unauthenticated create allowed");
  });
  await step("wrong password is rejected", async () => {
    const r = await anon.req("POST", "/api/auth/login", { email: "buyer@demo.cartwitness.test", password: "definitely-wrong" });
    assert(r.status === 401, `→ ${r.status}`);
  });

  console.log("\nBuyer: Purchase Permission Form");
  await step("buyer signs in", async () => {
    const r = await buyer.req("POST", "/api/auth/login", { email: "buyer@demo.cartwitness.test", password });
    assert(r.status === 200 && r.json.role === "BUYER", `login → ${r.status} ${r.text.slice(0, 120)}`);
  });
  await step("create permission and get field suggestions from plain English", async () => {
    const c = await buyer.req("POST", "/api/permissions");
    assert(c.status === 200 && c.json.id, "create failed");
    s.pid = c.json.id;
    const g = await buyer.req("POST", "/api/permissions/draft", {
      request_text: "Find one pair of white running shoes in US size 10 from Demo Sneaker Store. My total budget is $150.",
      today: localDate,
    });
    assert(g.status === 200 && g.json.suggestion?.max_total === "150.00" && g.json.suggestion?.product_type, `suggest → ${g.status} ${g.text.slice(0, 200)}`);
  });
  await step("incomplete form cannot be reviewed", async () => {
    await buyer.req("PUT", `/api/permissions/${s.pid}/draft`, { product_type: "anything" });
    const r = await buyer.req("POST", `/api/permissions/${s.pid}/review`);
    assert(r.status === 422, `→ ${r.status}`);
  });
  await step("save, review and approve the permission (forged hash refused)", async () => {
    const draft = DRAFT;
    const d = await buyer.req("PUT", `/api/permissions/${s.pid}/draft`, draft);
    assert(d.status === 200 && Object.keys(d.json.errors ?? {}).length === 0, `draft errors ${JSON.stringify(d.json?.errors)}`);
    const r = await buyer.req("POST", `/api/permissions/${s.pid}/review`);
    assert(r.status === 200 && String(r.json.summary).includes("NO MORE THAN $150.00"), `review → ${r.status}`);
    const forged = await buyer.req("POST", `/api/permissions/${s.pid}/approve`, { terms_hash: `sha256:${"0".repeat(64)}`, consents: CONSENTS });
    assert(forged.status === 409, `forged hash → ${forged.status}`);
    const a = await buyer.req("POST", `/api/permissions/${s.pid}/approve`, { terms_hash: r.json.termsHash, consents: CONSENTS });
    assert(a.status === 200 && a.json.version === 1, `approve → ${a.status} ${a.text.slice(0, 200)}`);
    s.policyId = a.json.policyId;
  });
  await step("permission receipt verifies and records AI-suggested fields", async () => {
    const r = await buyer.req("GET", `/api/permissions/${s.pid}`);
    assert(r.json.active?.integrity?.signatureValid && r.json.active?.integrity?.termsIntact, "integrity failed");
    assert(JSON.stringify(r.json.active?.approval_evidence?.ai_suggested_fields) === '["max_total"]', "ai_suggested_fields missing");
  });

  console.log("\nBuyer: shopping, policy engine, cart approval, checkout");
  const check = async (sku: string) => {
    const r = await buyer.req("POST", "/api/carts/evaluate", { permission_id: s.pid, sku, source: "AGENT" });
    assert(r.status === 200, `evaluate ${sku} → ${r.status} ${r.text.slice(0, 160)}`);
    return r.json as { id: string; verdict: string; cartHash: string; mismatchCodes: string[] };
  };
  await step("allowed cart is ALLOWed ($120 total)", async () => {
    const r = await check("CW-SNK-RUN-WHT-M10");
    assert(r.verdict === "ALLOW", `got ${r.verdict}`);
    s.allowId = r.id;
    s.allowHash = r.cartHash;
  });
  await step("wrong size, over-budget, look-alike seller and prompt injection are BLOCKed", async () => {
    for (const [sku, code] of [
      ["CW-SNK-RUN-WHT-M9", "SIZE"],
      ["CW-SNK-RUN-WHT-M10-PRO", "TOTAL"],
      ["CW-LKA-RUN-WHT-M10", "SELLER"],
      ["CW-SNK-RUN-WHT-M10-INJ", "TOTAL"],
    ]) {
      const r = await check(sku);
      assert(r.verdict === "BLOCK" && r.mismatchCodes.includes(code), `${sku}: ${r.verdict} ${r.mismatchCodes}`);
      s.blockId = r.id;
    }
  });
  await step("ambiguous colour needs REVIEW", async () => {
    const r = await check("CW-SNK-RUN-OFW-M10");
    assert(r.verdict === "REVIEW", `got ${r.verdict}`);
  });
  await step("client-supplied prices are rejected", async () => {
    const r = await buyer.req("POST", "/api/carts/evaluate", { permission_id: s.pid, sku: "CW-SNK-RUN-WHT-M10", total: "1.00" });
    assert(r.status === 400, `→ ${r.status}`);
  });
  await step("buyer approves the exact allowed cart; blocked carts cannot be approved", async () => {
    const b = await buyer.req("POST", `/api/carts/${s.blockId}/approve`, { cart_hash: `sha256:${"0".repeat(64)}` });
    assert(b.status === 409, `blocked approve → ${b.status}`);
    const a = await buyer.req("POST", `/api/carts/${s.allowId}/approve`, { cart_hash: s.allowHash });
    assert(a.status === 200, `approve → ${a.status} ${a.text.slice(0, 160)}`);
  });
  await step("checkout reports PayPal status honestly", async () => {
    const r = await buyer.req("POST", "/api/checkout/create", { attempt_id: s.allowId });
    if (r.status === 503) {
      assert(r.json.error?.code === "PAYPAL_NOT_CONFIGURED", "unexpected 503");
      console.log("      (PayPal keys not set: checkout correctly unavailable — add keys to test a real sandbox payment)");
    } else {
      assert(r.status === 200 && r.json.paypalOrderId, `checkout → ${r.status} ${r.text.slice(0, 200)}`);
      console.log(`      (PayPal sandbox order ${r.json.paypalOrderId} created — approve it in the browser to finish)`);
    }
  });
  await step("buyer pages render", async () => {
    await buyer.page("/permissions", "My purchase permissions");
    await buyer.page(`/permissions/${s.pid}`, s.policyId);
    await buyer.page(`/permissions/${s.pid}/edit`, "What can your AI buy?");
    await buyer.page(`/permissions/${s.pid}/review`, "Review exactly what you are allowing");
    await buyer.page(`/permissions/${s.pid}/shop`, "Agent");
    await buyer.page(`/permissions/${s.pid}/carts/${s.allowId}`, "matches the permission you approved");
    await buyer.page(`/permissions/${s.pid}/carts/${s.blockId}`, "violates your permission");
  });
  await step("buyer cannot use merchant APIs", async () => {
    const r = await buyer.req("POST", "/api/disputes/sample", { attempt_id: s.allowId, reason: "WRONG_ITEM" });
    assert(r.status === 403, `→ ${r.status}`);
  });

  console.log("\nMerchant: workspace, catalog, disputes");
  await step("merchant signs in", async () => {
    const r = await merchant.req("POST", "/api/auth/login", { email: "merchant@demo.cartwitness.test", password });
    assert(r.status === 200 && r.json.role === "MERCHANT", `login → ${r.status}`);
  });
  await step("price change after approval invalidates the buyer's approval (then restored)", async () => {
    const up = await merchant.req("PUT", "/api/merchant/catalog/CW-SNK-RUN-WHT-M10", { price: "139", shipping: "8.70", stock: 12 });
    assert(up.status === 200, `price up → ${up.status} ${up.text.slice(0, 160)}`);
    try {
      const r = await buyer.req("POST", "/api/checkout/create", { attempt_id: s.allowId });
      assert(r.status === 409 || r.status === 503, `checkout after price change → ${r.status}`);
      const again = await buyer.req("GET", `/api/carts/${s.allowId}`);
      assert(again.json.stillCurrent === false, "cart still marked current");
    } finally {
      const back = await merchant.req("PUT", "/api/merchant/catalog/CW-SNK-RUN-WHT-M10", up.json.before);
      assert(back.status === 200, "price restore failed");
    }
  });
  await step("sample dispute builds a labelled evidence packet; review once; export", async () => {
    const d = await merchant.req("POST", "/api/disputes/sample", { attempt_id: s.allowId, reason: "NOT_RECEIVED", complaint: "Smoke test" });
    assert(d.status === 200 && d.json.id, `dispute → ${d.status} ${d.text.slice(0, 160)}`);
    s.caseId = d.json.id;
    const p = await merchant.req("GET", `/api/disputes/${s.caseId}/packet`);
    assert(p.status === 200 && String(p.json.packet?.notice).startsWith("SAMPLE CASE") && p.json.packet_intact, "packet invalid");
    const r1 = await merchant.req("POST", `/api/disputes/${s.caseId}/review`, { note: "Smoke test review" });
    const r2 = await merchant.req("POST", `/api/disputes/${s.caseId}/review`, { note: "again" });
    assert(r1.status === 200 && r2.status === 409, `review → ${r1.status}/${r2.status}`);
  });
  await step("merchant pages render", async () => {
    await merchant.page("/merchant", "Agent purchases checked against buyer permissions");
    await merchant.page("/merchant/catalog", "Trusted prices and stock");
    await merchant.page(`/merchant/disputes/${s.caseId}`, "SAMPLE CASE");
  });

  console.log("\nNew user: sign-up, sign-in, account security");
  const newbie = new Client();
  const email = `smoke-${Date.now().toString(36)}@example.com`;
  const pw1 = "smoke test passphrase one";
  const pw2 = "smoke test passphrase two";
  await step("sign-up page loads; a new buyer account is created and signed in", async () => {
    await anon.page("/signup", "Create your account");
    const weak = await newbie.req("POST", "/api/auth/signup", { email, display_name: "Smoke User", password: "short" });
    assert(weak.status === 422 && weak.json.error?.details?.password, `weak password → ${weak.status}`);
    const r = await newbie.req("POST", "/api/auth/signup", { email, display_name: "Smoke User", password: pw1 });
    assert(r.status === 200 && r.json.role === "BUYER", `sign-up → ${r.status} ${r.text.slice(0, 160)}`);
    await newbie.page("/account?welcome=1", "Welcome");
    await newbie.page("/permissions", "Get started in four steps");
    const dup = await new Client().req("POST", "/api/auth/signup", { email: email.toUpperCase(), display_name: "Again", password: pw1 });
    assert(dup.status === 409 && dup.json.error?.code === "EMAIL_TAKEN", `duplicate → ${dup.status}`);
  });
  await step("the new user signs out and back in with email and password", async () => {
    await newbie.req("POST", "/api/auth/logout");
    assert((await newbie.req("GET", "/api/permissions")).status === 401, "still signed in after logout");
    const r = await newbie.req("POST", "/api/auth/login", { email, password: pw1 });
    assert(r.status === 200 && r.json.role === "BUYER", `login → ${r.status}`);
  });
  await step("password change needs the current password and ends other sessions", async () => {
    const other = new Client();
    assert((await other.req("POST", "/api/auth/login", { email, password: pw1 })).status === 200, "second session login failed");
    const bad = await newbie.req("POST", "/api/account/password", { current: "not my password", next: pw2 });
    assert(bad.status === 401, `wrong current → ${bad.status}`);
    const ok = await newbie.req("POST", "/api/account/password", { current: pw1, next: pw2 });
    assert(ok.status === 200 && ok.json.otherSessionsEnded >= 1, `change → ${ok.status} ${ok.text.slice(0, 160)}`);
    assert((await other.req("GET", "/api/permissions")).status === 401, "other session survived the password change");
    assert((await new Client().req("POST", "/api/auth/login", { email, password: pw1 })).status === 401, "old password still works");
    assert((await new Client().req("POST", "/api/auth/login", { email, password: pw2 })).status === 200, "new password does not work");
  });

  console.log("\nOne-click demo and passkeys");
  const judge = new Client();
  const device = new SoftAuthenticator(BASE);
  await step("one-click demo: a fresh private buyer and the demo merchant sign in without a password", async () => {
    const b = await judge.req("POST", "/api/auth/demo", { role: "BUYER" });
    assert(b.status === 200 && b.json.role === "BUYER", `demo buyer → ${b.status} ${b.text.slice(0, 160)}`);
    const list = await judge.req("GET", "/api/permissions");
    assert(list.status === 200 && list.text.trim() === "[]", `demo buyer is not fresh: ${list.text.slice(0, 160)}`);
    const m = new Client();
    const r = await m.req("POST", "/api/auth/demo", { role: "MERCHANT" });
    assert(r.status === 200 && r.json.role === "MERCHANT", `demo merchant → ${r.status}`);
    await m.page("/merchant", "Demo Sneaker Store");
    await anon.page("/login", "Try as buyer");
  });
  await step("buyer registers a passkey (WebAuthn, user-verified)", async () => {
    const o = await judge.req("POST", "/api/passkeys/register-options");
    assert(o.status === 200 && o.json.options?.challenge, `options → ${o.status} ${o.text.slice(0, 160)}`);
    const r = await judge.req("POST", "/api/passkeys/register", { challenge_id: o.json.challengeId, response: device.register(o.json.options) });
    assert(r.status === 200 && r.json.id === device.id, `register → ${r.status} ${r.text.slice(0, 200)}`);
    await judge.page("/account", "Passkeys");
  });
  await step("permission approval is passkey-signed over the exact terms hash (session-only approval refused)", async () => {
    const c = await judge.req("POST", "/api/permissions");
    s.ppid = c.json.id;
    await judge.req("PUT", `/api/permissions/${s.ppid}/draft`, DRAFT);
    const r = await judge.req("POST", `/api/permissions/${s.ppid}/review`);
    assert(r.status === 200 && r.json.hasPasskey === true, "review should report the passkey");
    const plain = await judge.req("POST", `/api/permissions/${s.ppid}/approve`, { terms_hash: r.json.termsHash, consents: CONSENTS });
    assert(plain.status === 409 && plain.json.error?.code === "PASSKEY_REQUIRED", `session-only approve → ${plain.status}`);
    const o = await judge.req("POST", `/api/permissions/${s.ppid}/approve/options`, { terms_hash: r.json.termsHash });
    assert(o.status === 200, `approve options → ${o.status} ${o.text.slice(0, 160)}`);
    const a = await judge.req("POST", `/api/permissions/${s.ppid}/approve`, {
      terms_hash: r.json.termsHash,
      consents: CONSENTS,
      passkey: { challenge_id: o.json.challengeId, response: device.assert(o.json.options) },
    });
    assert(a.status === 200 && a.json.assurance === "PASSKEY_VERIFIED", `approve → ${a.status} ${a.text.slice(0, 200)}`);
    const d = await judge.req("GET", `/api/permissions/${s.ppid}`);
    assert(d.json.active?.integrity?.passkeyValid === true, "stored passkey proof does not verify");
  });
  await step("exact-cart approval is passkey-signed over the cart hash", async () => {
    const e = await judge.req("POST", "/api/carts/evaluate", { permission_id: s.ppid, sku: "CW-SNK-RUN-WHT-M10", source: "AGENT" });
    assert(e.status === 200 && e.json.verdict === "ALLOW", `evaluate → ${e.status}`);
    const o = await judge.req("POST", `/api/carts/${e.json.id}/approve/options`, { cart_hash: e.json.cartHash });
    assert(o.status === 200, `cart options → ${o.status} ${o.text.slice(0, 160)}`);
    const a = await judge.req("POST", `/api/carts/${e.json.id}/approve`, {
      cart_hash: e.json.cartHash,
      passkey: { challenge_id: o.json.challengeId, response: device.assert(o.json.options) },
    });
    assert(a.status === 200 && a.json.assurance === "PASSKEY_VERIFIED", `cart approve → ${a.status} ${a.text.slice(0, 200)}`);
    await judge.page(`/permissions/${s.ppid}/carts/${e.json.id}`, "with your passkey");
  });
  await step("passkey sign-in works without a password; a foreign passkey is refused", async () => {
    const fresh = new Client();
    const o = await fresh.req("POST", "/api/passkeys/sign-in-options");
    const stranger = new SoftAuthenticator(BASE);
    const bad = await fresh.req("POST", "/api/passkeys/sign-in", { challenge_id: o.json.challengeId, response: stranger.assert(o.json.options) });
    assert(bad.status === 401, `foreign passkey → ${bad.status}`);
    const o2 = await fresh.req("POST", "/api/passkeys/sign-in-options");
    const ok = await fresh.req("POST", "/api/passkeys/sign-in", { challenge_id: o2.json.challengeId, response: device.assert(o2.json.options) });
    assert(ok.status === 200 && ok.json.role === "BUYER", `sign-in → ${ok.status} ${ok.text.slice(0, 160)}`);
    assert((await fresh.req("GET", `/api/permissions/${s.ppid}`)).status === 200, "signed in to a different account");
  });

  console.log("\nVerification");
  await step("unknown passport is reported, tampered bundle fails", async () => {
    const r = await anon.req("GET", "/api/verify/CW-PP-99999");
    assert(r.status === 200 && r.json.found === false, "lookup failed");
    await anon.page("/verify/CW-PP-99999", "No Purchase Passport");
    const bad = await anon.req(
      "POST",
      "/api/verify",
      undefined,
      JSON.stringify({ bundle: { schema: "cartwitness.passport.v1", passport_id: "CW-PP-00001" }, signature: "AAAA", signing_key_id: "x" }),
    );
    assert(bad.status === 200 && bad.json.valid === false, "tampered bundle passed");
  });
  await step("sign out ends the session", async () => {
    await buyer.req("POST", "/api/auth/logout");
    const r = await buyer.req("GET", "/api/permissions");
    assert(r.status === 401, `→ ${r.status}`);
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
