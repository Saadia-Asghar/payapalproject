import { destroySession } from "@/server/auth/session";
import { api } from "@/server/http";

export const POST = api(async () => {
  await destroySession();
  return { ok: true };
});
