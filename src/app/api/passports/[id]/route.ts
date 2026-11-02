import { getDb } from "@/server/db/client";
import { api, requireUser } from "@/server/http";
import { getPassportForOwner } from "@/server/services/passports";

/** Owner-only: the signed proof bundle. `?download=1` returns it as a file. */
export const GET = api(async (req, ctx: RouteContext<"/api/passports/[id]">) => {
  const { user } = await requireUser("BUYER");
  const { id } = await ctx.params;
  const { signed } = await getPassportForOwner(await getDb(), user.id, id);
  if (new URL(req.url).searchParams.get("download") === "1") {
    return new Response(JSON.stringify(signed, null, 2), {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="${signed.bundle.passport_id}.json"`,
        "Cache-Control": "no-store",
      },
    });
  }
  return signed;
});
