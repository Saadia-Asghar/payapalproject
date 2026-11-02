// Merchant catalog editing. Changing a price, fee or stock after a buyer approved a cart
// changes that cart's hash, so earlier checks and approvals stop applying — buyers must
// re-check. Every change is recorded in the evidence log.
import { z } from "zod";
import { appendEvidence } from "../audit.ts";
import type { Db, Queryable } from "../db/client.ts";
import { ServiceError } from "./permissions.ts";

const money = z
  .string()
  .trim()
  .regex(/^\d{1,5}(\.\d{1,2})?$/, "Enter an amount like 105 or 105.00.")
  .transform((v) => Number(v).toFixed(2));

export const productUpdateSchema = z.strictObject({
  price: money,
  shipping: money,
  stock: z.coerce.number().int().min(0).max(100_000),
});

export async function listOwnCatalog(q: Queryable, userId: string) {
  return q.query<{ sku: string; title: string; merchant_id: string; price: string; shipping: string; tax_rate_bps: number; stock: number; updated_at: Date }>(
    `SELECT p.sku, p.title, p.merchant_id, p.price::text AS price, p.shipping::text AS shipping, p.tax_rate_bps, p.stock, p.updated_at
       FROM catalog_products p JOIN merchants m ON m.id = p.merchant_id
      WHERE m.owner_user_id = $1
      ORDER BY p.title`,
    [userId],
  );
}

export async function updateProduct(db: Db, input: { userId: string; sku: string; update: unknown; now?: Date }) {
  const now = input.now ?? new Date();
  const parsed = productUpdateSchema.safeParse(input.update);
  if (!parsed.success) throw new ServiceError("BAD_REQUEST", 400, parsed.error.issues[0]?.message ?? "Invalid product update.");
  const next = parsed.data;
  return db.tx(async (q) => {
    const [p] = await q.query<{ sku: string; price: string; shipping: string; stock: number; owner_user_id: string | null }>(
      `SELECT p.sku, p.price::text AS price, p.shipping::text AS shipping, p.stock, m.owner_user_id
         FROM catalog_products p JOIN merchants m ON m.id = p.merchant_id
        WHERE p.sku = $1 FOR UPDATE OF p`,
      [input.sku],
    );
    if (!p || p.owner_user_id !== input.userId) throw new ServiceError("NOT_FOUND", 404, "Product not found.");
    const before = { price: p.price, shipping: p.shipping, stock: p.stock };
    if (before.price === next.price && before.shipping === next.shipping && before.stock === next.stock) {
      return { changed: false, before, after: before };
    }
    await q.query("UPDATE catalog_products SET price = $2, shipping = $3, stock = $4, updated_at = $5 WHERE sku = $1", [
      p.sku,
      next.price,
      next.shipping,
      next.stock,
      now.toISOString(),
    ]);
    await appendEvidence(q, {
      subjectType: "user",
      subjectId: p.sku,
      eventType: "CATALOG_PRODUCT_CHANGED",
      actorId: input.userId,
      payload: { sku: p.sku, before, after: next },
      at: now,
    });
    return { changed: true, before, after: next };
  });
}
