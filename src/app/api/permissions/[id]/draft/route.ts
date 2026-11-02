import { getDb } from "@/server/db/client";
import { api, readJson, requireUser } from "@/server/http";
import { discardDraft, saveDraft } from "@/server/services/permissions";

/** Saves the editable form. Returns validation problems without blocking the save. */
export const PUT = api(async (req, ctx: RouteContext<"/api/permissions/[id]/draft">) => {
  const { user } = await requireUser("BUYER");
  const { id } = await ctx.params;
  return saveDraft(await getDb(), user.id, id, await readJson(req));
});

/** Cancel: discards unapproved edits (or the whole permission if it was never approved). */
export const DELETE = api(async (_req, ctx: RouteContext<"/api/permissions/[id]/draft">) => {
  const { user } = await requireUser("BUYER");
  const { id } = await ctx.params;
  return discardDraft(await getDb(), user.id, id);
});
