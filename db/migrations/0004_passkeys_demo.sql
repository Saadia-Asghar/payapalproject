-- Passkeys (WebAuthn): buyer-bound approval of exact permission terms and exact carts,
-- plus one-click demo accounts for judges.

-- Fresh, passwordless buyer workspaces created by "Try the demo"; never a real person.
ALTER TABLE users ADD COLUMN is_demo BOOLEAN NOT NULL DEFAULT false;

-- Public keys only. The private key never leaves the buyer's authenticator.
CREATE TABLE webauthn_credentials (
  id            TEXT PRIMARY KEY,            -- base64url credential ID
  user_id       UUID NOT NULL REFERENCES users(id),
  public_key    TEXT NOT NULL,               -- base64url COSE public key
  counter       BIGINT NOT NULL DEFAULT 0,
  transports    TEXT[] NOT NULL DEFAULT '{}',
  device_type   TEXT NOT NULL,
  backed_up     BOOLEAN NOT NULL,
  label         TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ
);
CREATE INDEX webauthn_credentials_user_idx ON webauthn_credentials(user_id);

-- Single-use, short-lived challenges. For approvals the challenge is derived from the
-- exact data being approved (see src/server/auth/webauthn.ts), so it cannot be reused for anything else.
CREATE TABLE webauthn_challenges (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID REFERENCES users(id),     -- NULL for usernameless sign-in
  purpose      TEXT NOT NULL CHECK (purpose IN ('REGISTER', 'SIGN_IN', 'PERMISSION_APPROVAL', 'CART_APPROVAL')),
  challenge    TEXT NOT NULL,
  binding_json TEXT,                          -- canonical challenge inputs for approvals
  expires_at   TIMESTAMPTZ NOT NULL,
  used_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX webauthn_challenges_user_idx ON webauthn_challenges(user_id);

-- The buyer's exact-cart approval proof (passkey assertion or session evidence), set once with the approval time.
ALTER TABLE cart_attempts ADD COLUMN buyer_cart_approval TEXT;

CREATE OR REPLACE FUNCTION cw_cart_attempt_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'CW_IMMUTABLE: cart_attempts rows are append-only';
  END IF;
  IF OLD.buyer_cart_approved_at IS NOT NULL
     OR (NEW.buyer_cart_approval IS NOT NULL AND NEW.buyer_cart_approved_at IS NULL)
     OR (NEW.id, NEW.permission_version_id, NEW.cart_json, NEW.cart_hash, NEW.verdict, NEW.mismatch_codes,
         NEW.evaluation, NEW.created_at, NEW.user_id, NEW.source, NEW.evaluation_record, NEW.signature, NEW.signing_key_id)
        IS DISTINCT FROM
        (OLD.id, OLD.permission_version_id, OLD.cart_json, OLD.cart_hash, OLD.verdict, OLD.mismatch_codes,
         OLD.evaluation, OLD.created_at, OLD.user_id, OLD.source, OLD.evaluation_record, OLD.signature, OLD.signing_key_id)
  THEN
    RAISE EXCEPTION 'CW_IMMUTABLE: only the buyer cart approval may be set, once';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
