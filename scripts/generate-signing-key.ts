// Prints a new Ed25519 signing key as a single-line env var for .env.local / your host.
// Keep the output secret. Rotating it means old records verify against the old public key,
// which stays published in the signing_keys table.
import { generatePrivatePem, keyFromPrivatePem } from "../src/server/crypto/signing.ts";

const pem = generatePrivatePem();
const { keyId } = keyFromPrivatePem(pem);
console.log(`# key id: ${keyId}`);
console.log(`CW_SIGNING_PRIVATE_KEY=${Buffer.from(pem).toString("base64")}`);
