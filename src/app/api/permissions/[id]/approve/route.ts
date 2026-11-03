import { z } from "zod";
import { passkeyAssertionSchema, relyingPartyFrom, toPasskeyInput } from "@/server/auth/webauthn";
import { getDb } from "@/server/db/client";
import { api, readJson, requireUser } from "@/server/http";
import { approvePermission, ServiceError } from "@/server/services/permissions";

const body = z.strictObject({
  terms_hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  consents: z.object({
    checked_terms: z.boolean().optional(),
    ai_may_err: z.boolean().optional(),
    no_charge_yet: z.boolean().optional(),
  }),
  // Passkey assertion over this exact version (from POST ./options). Required once the account has a passkey.
  passkey: passkeyAssertionSchema.optional(),
});

export const POST = api(async (req, ctx: RouteContext<"/api/permissions/[id]/approve">) => {
  const session = await requireUser("BUYER");
  const { id } = await ctx.params;
  const parsed = body.safeParse(await readJson(req));
  if (!parsed.success) throw new ServiceError("BAD_REQUEST", 400, "Invalid approval request.");
  return approvePermission(await getDb(), {
    userId: session.user.id,
    sessionId: session.sessionId,
    permissionId: id,
    termsHash: parsed.data.terms_hash,
    consents: parsed.data.consents,
    passkey: parsed.data.passkey ? toPasskeyInput(parsed.data.passkey, relyingPartyFrom(req)) : undefined,
    userAgent: req.headers.get("user-agent"),
  });
});
