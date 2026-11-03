import { z } from "zod";
import { createSession } from "@/server/auth/session";
import {
  passkeyAssertionSchema,
  registrationOptions,
  relyingPartyFrom,
  signInOptions,
  toPasskeyInput,
  verifyRegistration,
  verifySignIn,
} from "@/server/auth/webauthn";
import { getDb } from "@/server/db/client";
import { api, readJson, requireUser } from "@/server/http";
import { clientIp, rateLimit } from "@/server/ratelimit";
import { ServiceError } from "@/server/services/permissions";

const b64url = z.string().max(16_384).regex(/^[A-Za-z0-9_-]*$/);
const registerBody = z.strictObject({
  challenge_id: z.string().uuid(),
  label: z.string().max(60).optional(),
  response: z.object({
    id: b64url,
    rawId: b64url,
    type: z.literal("public-key"),
    response: z
      .object({ clientDataJSON: b64url, attestationObject: b64url, transports: z.array(z.string().max(20)).max(10).optional() })
      .passthrough(),
    clientExtensionResults: z.record(z.string(), z.unknown()),
    authenticatorAttachment: z.string().optional(),
  }),
});

/**
 * POST /api/passkeys/register-options | register    — add a passkey to the signed-in account
 * POST /api/passkeys/sign-in-options  | sign-in     — usernameless passkey sign-in
 */
export const POST = api(async (req, ctx: RouteContext<"/api/passkeys/[action]">) => {
  const { action } = await ctx.params;
  const db = await getDb();
  const rp = relyingPartyFrom(req);
  switch (action) {
    case "register-options": {
      const { user } = await requireUser();
      return db.tx((q) => registrationOptions(q, user, rp));
    }
    case "register": {
      const { user } = await requireUser();
      const parsed = registerBody.safeParse(await readJson(req));
      if (!parsed.success) throw new ServiceError("BAD_REQUEST", 400, "Invalid passkey registration.");
      return db.tx((q) =>
        verifyRegistration(q, user.id, { challengeId: parsed.data.challenge_id, response: parsed.data.response as never, rp, label: parsed.data.label }),
      );
    }
    case "sign-in-options": {
      if (!rateLimit(`passkey:ip:${clientIp(req)}`, 30, 15 * 60_000).ok) throw new ServiceError("RATE_LIMITED", 429, "Too many attempts. Try again later.");
      return db.tx((q) => signInOptions(q, rp));
    }
    case "sign-in": {
      const parsed = passkeyAssertionSchema.strict().safeParse(await readJson(req));
      if (!parsed.success) throw new ServiceError("BAD_REQUEST", 400, "Invalid passkey sign-in.");
      const userId = await db.tx((q) => verifySignIn(q, toPasskeyInput(parsed.data, rp)));
      const [user] = await db.query<{ role: string }>("SELECT role FROM users WHERE id = $1", [userId]);
      await createSession(userId);
      return { ok: true, role: user.role };
    }
    default:
      throw new ServiceError("NOT_FOUND", 404, "Unknown passkey action.");
  }
});
