import "server-only";
import { connection } from "next/server";
import { getSessionUser, type SessionUser } from "./auth/session.ts";
import { ServiceError } from "./services/permissions.ts";

/** Rejects cross-site state-changing requests (defence in depth on top of SameSite cookies). */
export function assertSameOrigin(req: Request) {
  const origin = req.headers.get("origin");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (!origin || !host || new URL(origin).host !== host) {
    throw new ServiceError("BAD_ORIGIN", 403, "Cross-origin request rejected.");
  }
}

export async function requireUser(role?: "BUYER" | "MERCHANT"): Promise<SessionUser> {
  const s = await getSessionUser();
  if (!s) throw new ServiceError("UNAUTHENTICATED", 401, "Please sign in.");
  if (role && s.user.role !== role) throw new ServiceError("FORBIDDEN", 403, "Not allowed for this account.");
  return s;
}

export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new ServiceError("BAD_REQUEST", 400, "Request body must be JSON.");
  }
}

/** Wraps a route handler: same-origin check for mutations, uniform JSON errors. */
export function api<Ctx>(fn: (req: Request, ctx: Ctx) => Promise<unknown>) {
  return async (req: Request, ctx: Ctx) => {
    // All API responses are request-time. Outside the try so Next's prerender signal isn't swallowed.
    await connection();
    try {
      if (req.method !== "GET" && req.method !== "HEAD") assertSameOrigin(req);
      const body = await fn(req, ctx);
      return Response.json(body ?? { ok: true }, { headers: { "Cache-Control": "no-store" } });
    } catch (err) {
      if (err instanceof ServiceError) {
        return Response.json({ error: { code: err.code, message: err.message, details: err.details } }, { status: err.status });
      }
      console.error("[api] unexpected error", err);
      return Response.json({ error: { code: "INTERNAL", message: "Something went wrong." } }, { status: 500 });
    }
  };
}
