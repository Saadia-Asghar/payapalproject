import type { TermsFormValues } from "../src/lib/permissions/terms.ts";

export const NOW = new Date("2026-11-02T10:00:00Z");

/** The spec's worked example: white running shoes, US size 10, $150 total, Demo Sneaker Store. */
export function validForm(): TermsFormValues {
  return {
    request_text: "Find one pair of white running shoes in US size 10. My total budget is $150.",
    product_type: "running shoes",
    color: "white",
    size: "US M 10",
    condition: "NEW_ONLY",
    quantity: 1,
    max_total: "150.00",
    currency: "USD",
    merchant_ids: ["DEMO-SNEAKER-STORE"],
    delivery_ref: "SAVED_ADDRESS_A",
    expires_at: "2026-11-06T18:59:00Z",
    display_timezone: "Asia/Karachi",
    substitutions: "ASK_FIRST",
    recurring: false,
    review_mode: "APPROVE_FINAL_CART",
    single_use: true,
    notes: "No used or refurbished items",
  };
}
