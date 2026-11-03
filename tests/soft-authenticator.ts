// A software WebAuthn authenticator (ES256, "none" attestation, user verified) for tests and the
// smoke script. It produces the same JSON a browser returns from navigator.credentials.create/get.
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { isoBase64URL, isoCBOR } from "@simplewebauthn/server/helpers";

const sha256 = (data: Uint8Array | string) => new Uint8Array(createHash("sha256").update(data).digest());
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
};
const u32 = (n: number) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const json = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

export class SoftAuthenticator {
  readonly origin: string;
  readonly rpID: string;
  readonly credentialId = new Uint8Array(randomBytes(32));
  private readonly privateKey: KeyObject;
  private readonly cosePublicKey: Uint8Array;
  private counter = 0;
  /** Set to false to simulate an authenticator that skipped user verification. */
  userVerified = true;

  constructor(origin: string) {
    this.origin = new URL(origin).origin;
    this.rpID = new URL(origin).hostname;
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = privateKey;
    const jwk = publicKey.export({ format: "jwk" });
    const cose = new Map<number, number | Uint8Array>([
      [1, 2], // kty: EC2
      [3, -7], // alg: ES256
      [-1, 1], // crv: P-256
      [-2, isoBase64URL.toBuffer(jwk.x!)],
      [-3, isoBase64URL.toBuffer(jwk.y!)],
    ]);
    this.cosePublicKey = isoCBOR.encode(cose);
  }

  get id() {
    return isoBase64URL.fromBuffer(this.credentialId);
  }

  private flags() {
    return FLAG_UP | (this.userVerified ? FLAG_UV : 0);
  }

  /** Response to navigator.credentials.create() for the given server options. */
  register(options: { challenge: string; rp: { id?: string } }) {
    const clientDataJSON = json({ type: "webauthn.create", challenge: options.challenge, origin: this.origin, crossOrigin: false });
    const idLen = new Uint8Array([this.credentialId.length >> 8, this.credentialId.length & 255]);
    const authData = concat(
      sha256(options.rp.id ?? this.rpID),
      new Uint8Array([this.flags() | FLAG_AT]),
      u32(this.counter),
      new Uint8Array(16), // AAGUID
      idLen,
      this.credentialId,
      this.cosePublicKey,
    );
    const attestationObject = isoCBOR.encode(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]) as never);
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key" as const,
      response: {
        clientDataJSON: isoBase64URL.fromBuffer(clientDataJSON),
        attestationObject: isoBase64URL.fromBuffer(attestationObject),
        transports: ["internal"],
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }

  /** Response to navigator.credentials.get(): signs authenticatorData || SHA-256(clientDataJSON). */
  assert(options: { challenge: string; rpId?: string }) {
    this.counter += 1;
    const clientDataJSON = json({ type: "webauthn.get", challenge: options.challenge, origin: this.origin, crossOrigin: false });
    const authData = concat(sha256(options.rpId ?? this.rpID), new Uint8Array([this.flags()]), u32(this.counter));
    const signature = sign("sha256", concat(authData, sha256(clientDataJSON)), this.privateKey);
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key" as const,
      response: {
        authenticatorData: isoBase64URL.fromBuffer(authData),
        clientDataJSON: isoBase64URL.fromBuffer(clientDataJSON),
        signature: isoBase64URL.fromBuffer(new Uint8Array(signature)),
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }
}
