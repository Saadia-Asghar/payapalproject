"use client";
// Browser side of passkeys: create one, sign in with one, and sign an approval challenge.
import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import { apiCall } from "./api-client";

export const passkeysSupported = () => typeof window !== "undefined" && browserSupportsWebAuthn();

/** A friendly message for the browser's WebAuthn errors (cancelled prompt, timeout, …). */
export function passkeyErrorMessage(err: unknown): string {
  const name = err instanceof Error ? err.name : "";
  if (name === "NotAllowedError" || name === "AbortError") return "The passkey prompt was cancelled or timed out. Nothing was approved.";
  if (name === "InvalidStateError") return "This device already has a passkey for this account.";
  if (name === "SecurityError") return "Passkeys need HTTPS (or localhost) on this site's own domain.";
  return err instanceof Error ? err.message : "Passkey step failed.";
}

export async function registerPasskey(label?: string) {
  const { challengeId, options } = await apiCall<{ challengeId: string; options: PublicKeyCredentialCreationOptionsJSON }>(
    "/api/passkeys/register-options",
    "POST",
  );
  const response = await startRegistration({ optionsJSON: options });
  return apiCall<{ id: string; label: string }>("/api/passkeys/register", "POST", { challenge_id: challengeId, response, label });
}

export async function signInWithPasskey() {
  const { challengeId, options } = await apiCall<{ challengeId: string; options: PublicKeyCredentialRequestOptionsJSON }>(
    "/api/passkeys/sign-in-options",
    "POST",
  );
  const response = await startAuthentication({ optionsJSON: options });
  return apiCall<{ role: string }>("/api/passkeys/sign-in", "POST", { challenge_id: challengeId, response });
}

/** Gets a challenge bound to the exact data from `optionsUrl` and has the authenticator sign it. */
export async function signApproval(optionsUrl: string, body: unknown) {
  const { challengeId, options } = await apiCall<{ challengeId: string; options: PublicKeyCredentialRequestOptionsJSON }>(optionsUrl, "POST", body);
  const response = await startAuthentication({ optionsJSON: options });
  return { challenge_id: challengeId, response };
}
