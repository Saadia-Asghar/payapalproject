// PayPal → CartWitness webhooks. Called by PayPal's servers, so there is no browser Origin or
// session: authenticity comes only from PayPal's signature verification (see handleWebhook).
import { connection } from "next/server";
import { getDb } from "@/server/db/client";
import { getPayPal } from "@/server/paypal/client";
import { handleWebhook } from "@/server/services/checkout";
import { ServiceError } from "@/server/services/permissions";

const MAX_BYTES = 256_000;

export async function POST(req: Request) {
  await connection();
  try {
    const rawBody = await req.text();
    if (rawBody.length > MAX_BYTES) return Response.json({ error: "too large" }, { status: 413 });
    const result = await handleWebhook(await getDb(), getPayPal(), { headers: req.headers, rawBody });
    return Response.json(result);
  } catch (err) {
    if (err instanceof ServiceError) return Response.json({ error: err.code }, { status: err.status });
    console.error("[paypal webhook] unexpected error", err);
    // 500 makes PayPal retry later, which is what we want for transient failures.
    return Response.json({ error: "INTERNAL" }, { status: 500 });
  }
}
