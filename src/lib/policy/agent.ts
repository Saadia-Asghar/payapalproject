// Demo shopping agent: ranks catalog products by how well they match the request and
// explains why. It is intentionally NOT the enforcement point — like a real agent it can
// be fooled (e.g. by a cheap look-alike seller) — so every pick still goes through the
// deterministic policy gate before the buyer can approve anything.
// It reads structured attributes only; product descriptions are never interpreted.
import type { ApprovedTerms } from "../permissions/terms.ts";
import { normalizeSize, priceCart, productTypeMatches, toCents, type ProductAttributes } from "./engine.ts";

export interface AgentProduct {
  sku: string;
  title: string;
  category: string;
  merchant_id: string;
  merchant_name: string;
  attributes: ProductAttributes;
  price: string;
  shipping: string;
  tax_rate_bps: number;
  stock: number;
}

export interface AgentSuggestion {
  sku: string;
  score: number;
  estimatedTotal: string;
  reasons: string[];
}

export function suggestProducts(terms: ApprovedTerms, products: AgentProduct[], limit = 5): AgentSuggestion[] {
  const p = terms.product;
  const scored: AgentSuggestion[] = [];
  for (const prod of products) {
    if (prod.stock < terms.quantity || !productTypeMatches(p.type, prod.category)) continue;
    const a = prod.attributes;
    const reasons = [`Matches “${p.type}”`];
    let score = 5;
    const credit = (points: number, reason: string) => {
      score += points;
      reasons.push(reason);
    };
    if (p.color && a.color) {
      if (a.color.toLowerCase() === p.color.toLowerCase()) credit(3, `Colour ${a.color}`);
      else if (a.color.toLowerCase().includes(p.color.toLowerCase())) credit(1, `Colour ${a.color} (close)`);
    }
    if (p.size && a.size && normalizeSize(a.size) === normalizeSize(p.size)) credit(3, `Size ${a.size}`);
    if (p.brand && a.brand?.toLowerCase() === p.brand.toLowerCase()) credit(2, `Brand ${a.brand}`);
    if (p.condition === "NEW_ONLY" && a.condition === "NEW") credit(1, "New");
    const { total } = priceCart({ unitPrice: prod.price, quantity: terms.quantity, shipping: prod.shipping, taxRateBps: prod.tax_rate_bps });
    if (toCents(total) <= toCents(terms.max_total.value)) credit(2, `Est. total $${total} within budget`);
    if (terms.merchant_ids.includes(prod.merchant_id)) credit(2, "Preferred seller");
    scored.push({ sku: prod.sku, score, estimatedTotal: total, reasons });
  }
  return scored.sort((x, y) => y.score - x.score || toCents(x.estimatedTotal) - toCents(y.estimatedTotal)).slice(0, limit);
}
