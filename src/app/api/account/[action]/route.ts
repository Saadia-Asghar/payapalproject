import { z } from "zod";
import { getDb } from "@/server/db/client";
import { api, readJson, requireUser } from "@/server/http";
import { clientIp, rateLimit } from "@/server/ratelimit";
import { changePassword, signOutOtherSessions } from "@/server/services/accounts";
import { ServiceError } from "@/server/services/permissions";

const passwordBody = z.strictObject({ current: z.string().max(200).optional(), next: z.string().max(200) });

/**
 * POST /api/account/password          — change (or first-time set) the password; ends other sessions
 * POST /api/account/sign-out-others   — end every other session of this account
 */
export const POST = api(async (req, ctx: RouteContext<"/api/account/[action]">) => {
  const session = await requireUser();
  const { action } = await ctx.params;
  const db = await getDb();
  switch (action) {
    case "password": {
      const parsed = passwordBody.safeParse(await readJson(req));
      if (!parsed.success) throw new ServiceError("BAD_REQUEST", 400, "Invalid request.");
      if (!rateLimit(`pwchange:${session.user.id}:${clientIp(req)}`, 5, 15 * 60_000).ok) {
        throw new ServiceError("RATE_LIMITED", 429, "Too many attempts. Try again in a few minutes.");
      }
      return changePassword(db, { userId: session.user.id, sessionId: session.sessionId, current: parsed.data.current, next: parsed.data.next });
    }
    case "sign-out-others":
      return signOutOtherSessions(db, session.user.id, session.sessionId);
    default:
      throw new ServiceError("NOT_FOUND", 404, "Unknown account action.");
  }
});
