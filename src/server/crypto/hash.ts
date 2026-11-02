import { createHash } from "node:crypto";
import { canonicalJson } from "../../lib/crypto/canonical.ts";

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** SHA-256 of the canonical JSON form, prefixed so the algorithm travels with the value. */
export function canonicalHash(value: unknown): string {
  return `sha256:${sha256Hex(canonicalJson(value))}`;
}
