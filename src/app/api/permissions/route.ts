import { getDb } from "@/server/db/client";
import { api, requireUser } from "@/server/http";
import { createPermission, listPermissions } from "@/server/services/permissions";

export const GET = api(async () => {
  const { user } = await requireUser("BUYER");
  const rows = await listPermissions(await getDb(), user.id);
  return rows.map((r) => ({ ...r, draft_json: undefined }));
});

/** Starts a new, unapproved permission draft. */
export const POST = api(async () => {
  const { user } = await requireUser("BUYER");
  return createPermission(await getDb(), user.id);
});
