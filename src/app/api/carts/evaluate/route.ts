import { z } from "zod";
import { getDb } from "@/server/db/client";
import { api, readJson, requireUser } from "@/server/http";
import { evaluateAndRecord } from "@/server/services/carts";
import { ServiceError } from "@/server/services/permissions";

// The caller (agent or buyer) only names a product. Price, seller and attributes are
// always loaded server-side from the trusted catalog.
const body = z.strictObject({
  permission_id: z.string().uuid(),
  sku: z.string().regex(/^[A-Z0-9-]{3,64}$/),
  quantity: z.number().int().min(1).max(100).optional(),
  source: z.enum(["AGENT", "BUYER_PICK"]).optional(),
});

export const POST = api(async (req) => {
  const { user } = await requireUser("BUYER");
  const parsed = body.safeParse(await readJson(req));
  if (!parsed.success) throw new ServiceError("BAD_REQUEST", 400, "Invalid cart request.");
  return evaluateAndRecord(await getDb(), {
    userId: user.id,
    permissionId: parsed.data.permission_id,
    sku: parsed.data.sku,
    quantity: parsed.data.quantity,
    source: parsed.data.source,
  });
});
