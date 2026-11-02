import { getDb } from "@/server/db/client";
import { api } from "@/server/http";
import { verifyUploaded } from "@/server/services/passports";
import { ServiceError } from "@/server/services/permissions";

const MAX_BYTES = 64_000;

/** Public: verify a pasted/uploaded signed passport bundle against published keys. */
export const POST = api(async (req) => {
  const text = await req.text();
  if (text.length > MAX_BYTES) throw new ServiceError("TOO_LARGE", 413, "Bundle too large.");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new ServiceError("BAD_REQUEST", 400, "That is not valid JSON.");
  }
  return verifyUploaded(await getDb(), body);
});
