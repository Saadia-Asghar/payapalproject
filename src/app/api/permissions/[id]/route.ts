import { getDb } from "@/server/db/client";
import { api, requireUser } from "@/server/http";
import { getPermissionDetail } from "@/server/services/permissions";

export const GET = api(async (_req, ctx: RouteContext<"/api/permissions/[id]">) => {
  const { user } = await requireUser("BUYER");
  const { id } = await ctx.params;
  const detail = await getPermissionDetail(await getDb(), user.id, id);
  return {
    ...detail,
    versions: detail.versions.map((v) => ({ ...v, public_key_pem: undefined })),
    active: detail.active && { ...detail.active, public_key_pem: undefined },
  };
});
