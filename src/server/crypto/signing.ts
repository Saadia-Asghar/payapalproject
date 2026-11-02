// Ed25519 application signatures over domain-separated canonical JSON.
// These are "application-signed" records: they show a record has not changed since
// CartWitness signed it. They do not, alone, prove which human saw the terms.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { canonicalJson } from "../../lib/crypto/canonical.ts";
import { sha256Hex } from "./hash.ts";

export const SIGNING_DOMAINS = {
  permissionApproval: "cartwitness/permission-approval/v1",
  cart: "cartwitness/cart/v1",
  passport: "cartwitness/passport/v1",
} as const;
export type SigningDomain = (typeof SIGNING_DOMAINS)[keyof typeof SIGNING_DOMAINS];

export interface SigningKey {
  keyId: string;
  privateKey: KeyObject;
  publicKeyPem: string;
}

export function signingMessage(domain: SigningDomain, record: unknown): Buffer {
  return Buffer.from(`${domain}\n${canonicalJson(record)}`, "utf8");
}

export function keyFromPrivatePem(pem: string): SigningKey {
  const privateKey = createPrivateKey(pem);
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("Signing key must be Ed25519");
  const publicKey = createPublicKey(privateKey);
  const spki = publicKey.export({ format: "der", type: "spki" });
  return {
    keyId: `cw-ed25519-${sha256Hex(spki).slice(0, 16)}`,
    privateKey,
    publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
  };
}

export function generatePrivatePem(): string {
  const { privateKey } = generateKeyPairSync("ed25519");
  return privateKey.export({ format: "pem", type: "pkcs8" }).toString();
}

/** Accepts a raw PEM or a base64-encoded PEM (handy for single-line env vars). */
export function decodePemEnv(value: string): string {
  const v = value.trim();
  return v.startsWith("-----BEGIN") ? v.replace(/\\n/g, "\n") : Buffer.from(v, "base64").toString("utf8");
}

let cached: SigningKey | undefined;

export function getSigningKey(): SigningKey {
  if (cached) return cached;
  const env = process.env.CW_SIGNING_PRIVATE_KEY;
  if (env) {
    cached = keyFromPrivatePem(decodePemEnv(env));
  } else if (process.env.NODE_ENV === "production") {
    throw new Error("CW_SIGNING_PRIVATE_KEY is required in production (run `npm run keys:generate`).");
  } else {
    // Local development only: persist a generated key under the git-ignored .data/ folder.
    const file = path.join(process.cwd(), ".data", "dev-signing-key.pem");
    if (!existsSync(file)) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, generatePrivatePem(), { mode: 0o600 });
    }
    cached = keyFromPrivatePem(readFileSync(file, "utf8"));
  }
  return cached;
}

export function signRecord(domain: SigningDomain, record: unknown, key: SigningKey = getSigningKey()) {
  const signature = sign(null, signingMessage(domain, record), key.privateKey).toString("base64");
  return { signature, keyId: key.keyId };
}

export function verifyRecord(domain: SigningDomain, record: unknown, signatureB64: string, publicKeyPem: string): boolean {
  try {
    return verify(null, signingMessage(domain, record), createPublicKey(publicKeyPem), Buffer.from(signatureB64, "base64"));
  } catch {
    return false;
  }
}
