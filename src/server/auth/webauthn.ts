// Passkeys (WebAuthn): sign-in, and buyer-bound approval of exact permission terms and exact carts.
//
// For an approval the WebAuthn challenge is not random: it is SHA-256 of the canonical JSON
// { domain, purpose, <what is approved, incl. its hash>, nonce }. The authenticator signs
// authenticatorData || SHA-256(clientDataJSON), and clientDataJSON contains that challenge, so the
// signature covers the exact terms/cart. The assertion and the credential public key are stored
// in the approval record, so anyone can re-check it later without trusting CartWitness's database.
//
// Assurance: proves the holder of a passkey registered to this account (on this site) approved this
// exact data with user verification. The account-to-person link is as strong as account sign-up.
import { createHash, randomBytes } from "node:crypto";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { z } from "zod";
import { canonicalJson } from "../../lib/crypto/canonical.ts";
import { appendEvidence } from "../audit.ts";
import type { Queryable } from "../db/client.ts";
import { ServiceError } from "../errors.ts";

export const PASSKEY_DOMAIN = "cartwitness/passkey-approval/v1";
const RP_NAME = "CartWitness";
const CHALLENGE_TTL_MS = 5 * 60_000;

export interface RelyingParty {
  rpID: string;
  origin: string;
}

/** The site the browser is on. POST routes have already passed the same-origin check. */
export function relyingPartyFrom(req: Request): RelyingParty {
  const origin = req.headers.get("origin");
  if (!origin) throw new ServiceError("BAD_ORIGIN", 403, "Missing Origin header.");
  const url = new URL(origin);
  return { rpID: process.env.CW_WEBAUTHN_RP_ID || url.hostname, origin: url.origin };
}

export type ApprovalBinding =
  | { purpose: "PERMISSION_APPROVAL"; policy_id: string; version: number; terms_hash: string }
  | { purpose: "CART_APPROVAL"; cart_attempt_id: string; cart_hash: string };

export type ChallengeInputs = ApprovalBinding & { domain: typeof PASSKEY_DOMAIN; nonce: string };

/** The stored proof: enough for anyone to re-verify the buyer's signature over the exact data. */
export interface PasskeyProof {
  type: "webauthn.get";
  credential_id: string;
  public_key: string; // base64url COSE key
  rp_id: string;
  origin: string;
  challenge_inputs: ChallengeInputs;
  authenticator_data: string;
  client_data_json: string;
  signature: string;
  user_verified: true;
}

export interface PasskeyApprovalInput {
  challengeId: string;
  response: AuthenticationResponseJSON;
  rp: RelyingParty;
}

const b64url = z.string().max(16_384).regex(/^[A-Za-z0-9_-]*$/);

/** Request shape for an assertion posted by the browser (from @simplewebauthn/browser). */
export const passkeyAssertionSchema = z.object({
  challenge_id: z.string().uuid(),
  response: z.object({
    id: b64url,
    rawId: b64url,
    type: z.literal("public-key"),
    response: z.object({ authenticatorData: b64url, clientDataJSON: b64url, signature: b64url, userHandle: b64url.optional() }),
    clientExtensionResults: z.record(z.string(), z.unknown()),
    authenticatorAttachment: z.string().optional(),
  }),
});

export function toPasskeyInput(body: z.infer<typeof passkeyAssertionSchema>, rp: RelyingParty): PasskeyApprovalInput {
  return { challengeId: body.challenge_id, response: body.response as AuthenticationResponseJSON, rp };
}

export function challengeFor(inputs: ChallengeInputs): string {
  return isoBase64URL.fromBuffer(createHash("sha256").update(canonicalJson(inputs)).digest());
}

interface CredentialRow {
  id: string;
  user_id: string;
  public_key: string;
  counter: string;
  transports: string[];
  device_type: string;
  backed_up: boolean;
  label: string;
  created_at: Date;
  last_used_at: Date | null;
}

interface ChallengeRow {
  id: string;
  user_id: string | null;
  purpose: string;
  challenge: string;
  binding_json: string | null;
}

export async function listPasskeys(q: Queryable, userId: string) {
  return q.query<Pick<CredentialRow, "id" | "label" | "device_type" | "backed_up" | "created_at" | "last_used_at">>(
    "SELECT id, label, device_type, backed_up, created_at, last_used_at FROM webauthn_credentials WHERE user_id = $1 ORDER BY created_at",
    [userId],
  );
}

export async function hasPasskey(q: Queryable, userId: string) {
  const [row] = await q.query<{ n: number }>("SELECT count(*)::int AS n FROM webauthn_credentials WHERE user_id = $1", [userId]);
  return row.n > 0;
}

async function storeChallenge(q: Queryable, c: { userId: string | null; purpose: string; challenge: string; binding?: ChallengeInputs }) {
  const [row] = await q.query<{ id: string }>(
    `INSERT INTO webauthn_challenges (user_id, purpose, challenge, binding_json, expires_at)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [c.userId, c.purpose, c.challenge, c.binding ? canonicalJson(c.binding) : null, new Date(Date.now() + CHALLENGE_TTL_MS).toISOString()],
  );
  return row.id;
}

/** Marks a challenge used (single use) and returns it, or fails if it is unknown, expired, used or someone else's. */
async function consumeChallenge(q: Queryable, id: unknown, purpose: string, userId: string | null) {
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id)) throw new ServiceError("PASSKEY_CHALLENGE", 400, "Passkey request expired. Please try again.");
  const [row] = await q.query<ChallengeRow>(
    `UPDATE webauthn_challenges SET used_at = now()
      WHERE id = $1 AND purpose = $2 AND user_id IS NOT DISTINCT FROM $3 AND used_at IS NULL AND expires_at > now()
      RETURNING id, user_id, purpose, challenge, binding_json`,
    [id, purpose, userId],
  );
  if (!row) throw new ServiceError("PASSKEY_CHALLENGE", 400, "Passkey request expired or was already used. Please try again.");
  return row;
}

function passkeyFailed(err: unknown): never {
  if (err instanceof ServiceError) throw err;
  throw new ServiceError("PASSKEY_FAILED", 401, "The passkey could not be verified.", { reason: err instanceof Error ? err.message : String(err) });
}

// ---------- Registration ----------

export async function registrationOptions(q: Queryable, user: { id: string; email: string; display_name: string }, rp: RelyingParty) {
  const existing = await q.query<{ id: string; transports: string[] }>("SELECT id, transports FROM webauthn_credentials WHERE user_id = $1", [user.id]);
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: rp.rpID,
    userName: user.email,
    userDisplayName: user.display_name,
    userID: new TextEncoder().encode(user.id),
    attestationType: "none",
    excludeCredentials: existing.map((c) => ({ id: c.id, transports: c.transports })),
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
  });
  const challengeId = await storeChallenge(q, { userId: user.id, purpose: "REGISTER", challenge: options.challenge });
  return { challengeId, options };
}

export async function verifyRegistration(
  q: Queryable,
  userId: string,
  input: { challengeId: string; response: RegistrationResponseJSON; rp: RelyingParty; label?: string },
) {
  const ch = await consumeChallenge(q, input.challengeId, "REGISTER", userId);
  const result = await verifyRegistrationResponse({
    response: input.response,
    expectedChallenge: ch.challenge,
    expectedOrigin: input.rp.origin,
    expectedRPID: input.rp.rpID,
    requireUserVerification: true,
  }).catch(passkeyFailed);
  if (!result.verified) passkeyFailed("not verified");
  const { credential, credentialDeviceType, credentialBackedUp } = result.registrationInfo;
  const label = (input.label?.trim() || (credentialBackedUp ? "Synced passkey" : "Device passkey")).slice(0, 60);
  const inserted = await q.query(
    `INSERT INTO webauthn_credentials (id, user_id, public_key, counter, transports, device_type, backed_up, label)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING RETURNING id`,
    [credential.id, userId, isoBase64URL.fromBuffer(credential.publicKey), credential.counter, credential.transports ?? [],
      credentialDeviceType, credentialBackedUp, label],
  );
  if (!inserted.length) throw new ServiceError("PASSKEY_EXISTS", 409, "This passkey is already registered.");
  await appendEvidence(q, {
    subjectType: "user",
    subjectId: userId,
    eventType: "PASSKEY_REGISTERED",
    actorId: userId,
    payload: { credential_id: credential.id, public_key_sha256: createHash("sha256").update(credential.publicKey).digest("hex"), rp_id: input.rp.rpID },
  });
  return { id: credential.id, label };
}

// ---------- Assertions (sign-in and approvals) ----------

async function verifyAssertion(q: Queryable, expectedChallenge: string, response: AuthenticationResponseJSON, rp: RelyingParty, userId: string | null) {
  if (!response || typeof response.id !== "string") throw new ServiceError("PASSKEY_FAILED", 400, "Missing passkey response.");
  const [cred] = await q.query<CredentialRow>("SELECT * FROM webauthn_credentials WHERE id = $1 FOR UPDATE", [response.id]);
  if (!cred || (userId && cred.user_id !== userId)) throw new ServiceError("PASSKEY_UNKNOWN", 401, "This passkey is not registered to this account.");
  const result = await verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: rp.origin,
    expectedRPID: rp.rpID,
    credential: { id: cred.id, publicKey: isoBase64URL.toBuffer(cred.public_key), counter: Number(cred.counter), transports: cred.transports as never },
    requireUserVerification: true,
  }).catch(passkeyFailed);
  if (!result.verified) passkeyFailed("not verified");
  await q.query("UPDATE webauthn_credentials SET counter = $2, last_used_at = now() WHERE id = $1", [cred.id, result.authenticationInfo.newCounter]);
  return cred;
}

export async function signInOptions(q: Queryable, rp: RelyingParty) {
  const options = await generateAuthenticationOptions({ rpID: rp.rpID, userVerification: "required" });
  const challengeId = await storeChallenge(q, { userId: null, purpose: "SIGN_IN", challenge: options.challenge });
  return { challengeId, options };
}

/** Usernameless sign-in: returns the account that owns the passkey. */
export async function verifySignIn(q: Queryable, input: PasskeyApprovalInput) {
  const ch = await consumeChallenge(q, input.challengeId, "SIGN_IN", null);
  const cred = await verifyAssertion(q, ch.challenge, input.response, input.rp, null);
  return cred.user_id;
}

/** Options for approving exact data; the challenge commits to `binding`. */
export async function approvalOptions(q: Queryable, userId: string, rp: RelyingParty, binding: ApprovalBinding) {
  const creds = await q.query<{ id: string; transports: string[] }>("SELECT id, transports FROM webauthn_credentials WHERE user_id = $1", [userId]);
  if (!creds.length) throw new ServiceError("NO_PASSKEY", 409, "Add a passkey to this account first.");
  const inputs: ChallengeInputs = { ...binding, domain: PASSKEY_DOMAIN, nonce: randomBytes(16).toString("base64url") };
  const options = await generateAuthenticationOptions({
    rpID: rp.rpID,
    challenge: isoBase64URL.toBuffer(challengeFor(inputs)),
    allowCredentials: creds.map((c) => ({ id: c.id, transports: c.transports })),
    userVerification: "required",
  });
  const challengeId = await storeChallenge(q, { userId, purpose: binding.purpose, challenge: options.challenge, binding: inputs });
  return { challengeId, options };
}

/**
 * Verifies the buyer's passkey signed exactly `expected` and returns the proof to store.
 * Must run inside the approval transaction so the challenge and approval commit together.
 */
export async function verifyApproval(q: Queryable, userId: string, expected: ApprovalBinding, input: PasskeyApprovalInput): Promise<PasskeyProof> {
  const ch = await consumeChallenge(q, input.challengeId, expected.purpose, userId);
  const inputs = JSON.parse(ch.binding_json ?? "null") as ChallengeInputs | null;
  if (!inputs || !bindingMatches(inputs, expected) || challengeFor(inputs) !== ch.challenge) {
    throw new ServiceError("PASSKEY_MISMATCH", 409, "The passkey approval was for different data. Please review and try again.");
  }
  const cred = await verifyAssertion(q, ch.challenge, input.response, input.rp, userId);
  return {
    type: "webauthn.get",
    credential_id: cred.id,
    public_key: cred.public_key,
    rp_id: input.rp.rpID,
    origin: input.rp.origin,
    challenge_inputs: inputs,
    authenticator_data: input.response.response.authenticatorData,
    client_data_json: input.response.response.clientDataJSON,
    signature: input.response.response.signature,
    user_verified: true,
  };
}

function bindingMatches(inputs: ChallengeInputs, expected: ApprovalBinding) {
  const { domain, nonce, ...binding } = inputs;
  return domain === PASSKEY_DOMAIN && typeof nonce === "string" && canonicalJson(binding) === canonicalJson(expected);
}

/**
 * Independent check of a stored proof using only its own contents: the challenge is recomputed from
 * the approved data, and the signature is checked against the embedded public key with user verification.
 */
export async function verifyPasskeyProof(proof: unknown, expected: ApprovalBinding): Promise<boolean> {
  try {
    const p = proof as PasskeyProof;
    if (p?.type !== "webauthn.get" || !bindingMatches(p.challenge_inputs, expected)) return false;
    const host = new URL(p.origin).hostname;
    if (host !== p.rp_id && !host.endsWith(`.${p.rp_id}`)) return false;
    const result = await verifyAuthenticationResponse({
      response: {
        id: p.credential_id,
        rawId: p.credential_id,
        type: "public-key",
        clientExtensionResults: {},
        response: { authenticatorData: p.authenticator_data, clientDataJSON: p.client_data_json, signature: p.signature },
      },
      expectedChallenge: challengeFor(p.challenge_inputs),
      expectedOrigin: p.origin,
      expectedRPID: p.rp_id,
      credential: { id: p.credential_id, publicKey: isoBase64URL.toBuffer(p.public_key), counter: 0 },
      requireUserVerification: true,
    });
    return result.verified;
  } catch {
    return false;
  }
}
