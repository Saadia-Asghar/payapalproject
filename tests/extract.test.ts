import { describe, expect, it } from "vitest";
import { extractWithRules, parseDeadline, sanitizeSuggestion } from "../src/lib/permissions/extract.ts";
import { suggestDraft } from "../src/server/ai/draft.ts";
import { generatePrivatePem, keyFromPrivatePem } from "../src/server/crypto/signing.ts";
import { createTestDb } from "../src/server/db/client.ts";
import { approvePermission, createPermission, getPermissionDetail, reviewPermission } from "../src/server/services/permissions.ts";
import { rateLimit } from "../src/server/ratelimit.ts";
import { NOW, validForm } from "./fixtures.ts";

const MERCHANTS = [
  { id: "DEMO-OUTLET-MARKET", display_name: "Demo Outlet Market" },
  { id: "DEMO-SNEAKER-STORE", display_name: "Demo Sneaker Store" },
];
const TODAY = "2026-11-02"; // a Monday
const SPEC_REQUEST = "Find one pair of white running shoes in US size 10. My total budget is $150. I need them before Friday.";

describe("rule-based extraction", () => {
  it("extracts the spec's example request", () => {
    expect(extractWithRules(SPEC_REQUEST, { today: TODAY, merchants: MERCHANTS })).toEqual({
      product_type: "running shoes",
      color: "white",
      size: "US 10",
      quantity: 1,
      max_total: "150.00",
      deadline_date: "2026-11-06",
    });
  });

  it("picks up sellers by name, condition and substitution preferences", () => {
    const s = extractWithRules("Buy two black hoodies from Demo Sneaker Store, size M, no used items, no substitutions, under 80 dollars", {
      today: TODAY,
      merchants: MERCHANTS,
    });
    expect(s).toMatchObject({ color: "black", merchant_ids: ["DEMO-SNEAKER-STORE"], condition: "NEW_ONLY", substitutions: "NOT_ALLOWED", max_total: "80.00" });
  });

  it.each([
    ["before Friday", "2026-11-06"],
    ["by monday", "2026-11-09"],
    ["by Nov 20", "2026-11-20"],
    ["before 1 March", "2027-03-01"],
    ["within 3 days", "2026-11-05"],
    ["tomorrow", "2026-11-03"],
    ["whenever", undefined],
  ])("resolves deadline %s", (text, expected) => {
    expect(parseDeadline(text, TODAY)).toBe(expected);
  });
});

describe("suggestion sanitizing", () => {
  it("drops unknown seller ids and malformed values", () => {
    expect(
      sanitizeSuggestion(
        {
          merchant_ids: ["DEMO-SNEAKER-ST0RE", "DEMO-SNEAKER-STORE"],
          max_total: "1e9",
          quantity: 50,
          deadline_date: "Friday",
          product_type: "  running   shoes ",
        },
        MERCHANTS.map((m) => m.id),
      ),
    ).toEqual({ merchant_ids: ["DEMO-SNEAKER-STORE"], product_type: "running shoes" });
  });
});

describe("AI suggestions", () => {
  const ctx = { today: TODAY, merchants: MERCHANTS };
  const fake = (impl: () => Promise<unknown>) => ({ messages: { parse: impl } }) as unknown as Parameters<typeof suggestDraft>[2];

  it("uses Claude's structured output, sanitized", async () => {
    const r = await suggestDraft(
      SPEC_REQUEST,
      ctx,
      fake(async () => ({
        stop_reason: "end_turn",
        parsed_output: {
          product_type: "running shoes",
          color: "white",
          size: "US M 10",
          brand: null,
          condition: null,
          quantity: 1,
          max_total: "150.00",
          merchant_ids: ["NOT-A-REAL-SELLER"],
          deadline_date: "2026-11-06",
          substitutions: null,
          notes: null,
        },
      })),
    );
    expect(r.source).toBe("CLAUDE");
    expect(r.suggestion).toEqual({
      product_type: "running shoes",
      color: "white",
      size: "US M 10",
      quantity: 1,
      max_total: "150.00",
      deadline_date: "2026-11-06",
    });
  });

  it("falls back to rules on refusal or API failure", async () => {
    const refused = await suggestDraft(SPEC_REQUEST, ctx, fake(async () => ({ stop_reason: "refusal", parsed_output: null })));
    expect(refused).toMatchObject({ source: "RULES", suggestion: { max_total: "150.00" } });
    const failed = await suggestDraft(
      SPEC_REQUEST,
      ctx,
      fake(async () => {
        throw new Error("network down");
      }),
    );
    expect(failed.source).toBe("RULES");
    expect(failed.notice).toMatch(/unavailable/);
  });

  it("uses rules when no API key is configured", async () => {
    const before = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    expect((await suggestDraft(SPEC_REQUEST, ctx)).source).toBe("RULES");
    if (before !== undefined) process.env.ANTHROPIC_API_KEY = before;
  });
});

describe("approval evidence", () => {
  it("records which fields were AI-suggested and kept, and ignores junk", async () => {
    const db = await createTestDb();
    const [u] = await db.query<{ id: string }>("INSERT INTO users (email, display_name, role) VALUES ('b@x.test', 'B', 'BUYER') RETURNING id");
    const { id } = await createPermission(db, u.id, { ...validForm(), ai_suggested_fields: ["max_total", "size", "password", "size"] });
    const r = await reviewPermission(db, u.id, id, NOW);
    await approvePermission(db, {
      userId: u.id,
      sessionId: "s",
      permissionId: id,
      termsHash: r.termsHash,
      consents: { checked_terms: true, ai_may_err: true, no_charge_yet: true },
      now: NOW,
      signingKey: keyFromPrivatePem(generatePrivatePem()),
    });
    const d = await getPermissionDetail(db, u.id, id, NOW);
    expect(d.active?.approval_evidence.ai_suggested_fields).toEqual(["max_total", "size"]);
    expect(d.active?.integrity.signatureValid).toBe(true);
    await db.close();
  });
});

describe("rate limiting", () => {
  it("allows up to the limit within the window, then blocks until it slides", () => {
    const key = `t:${Math.random()}`;
    for (let i = 0; i < 3; i++) expect(rateLimit(key, 3, 1000, 10_000 + i).ok).toBe(true);
    expect(rateLimit(key, 3, 1000, 10_500)).toMatchObject({ ok: false });
    expect(rateLimit(key, 3, 1000, 11_001).ok).toBe(true);
  });
});
