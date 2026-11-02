import { getDb } from "@/server/db/client";
import { getSigningKey } from "@/server/crypto/signing";
import { api } from "@/server/http";

/** Public Ed25519 keys for verifying CartWitness application signatures. */
export const GET = api(async () => {
  const db = await getDb();
  const current = getSigningKey();
  const keys = await db.query<{ key_id: string; algorithm: string; public_key_pem: string; created_at: Date }>(
    "SELECT key_id, algorithm, public_key_pem, created_at FROM signing_keys ORDER BY created_at",
  );
  return {
    assurance: "APPLICATION_SIGNED",
    signing_message: "<domain>\n<canonical JSON of record>",
    current_key_id: current.keyId,
    keys: keys.some((k) => k.key_id === current.keyId)
      ? keys
      : [...keys, { key_id: current.keyId, algorithm: "Ed25519", public_key_pem: current.publicKeyPem }],
  };
});
