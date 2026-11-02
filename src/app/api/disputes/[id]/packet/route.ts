import { getDb } from "@/server/db/client";
import { api, requireUser } from "@/server/http";
import { getDispute } from "@/server/services/disputes";

/** Merchant-only export of the evidence packet as structured JSON. */
export const GET = api(async (_req, ctx: RouteContext<"/api/disputes/[id]/packet">) => {
  const { user } = await requireUser("MERCHANT");
  const { id } = await ctx.params;
  const { dispute, packet, packetIntact } = await getDispute(await getDb(), user.id, id);
  const body = {
    packet,
    packet_sha256: dispute.packet_hash,
    packet_intact: packetIntact,
    review: { status: dispute.status, note: dispute.reviewer_note, reviewed_at: dispute.reviewed_at },
  };
  return new Response(JSON.stringify(body, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="${dispute.public_id}-evidence-packet.json"`,
      "Cache-Control": "no-store",
    },
  });
});
