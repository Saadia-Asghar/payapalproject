-- CartWitness initial schema.
-- Migrations are append-only: never edit an applied file, add a new one.
-- All money is NUMERIC(12,2) in the DB and a decimal string in JSON/hashes.

CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('BUYER', 'MERCHANT')),
  auth_method   TEXT NOT NULL DEFAULT 'PASSWORD' CHECK (auth_method IN ('PASSWORD', 'PASSKEY')),
  password_hash TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Only the SHA-256 of the session token is stored.
CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

-- Trusted merchant identities. Allowlists match on id, never on display name.
CREATE TABLE merchants (
  id            TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  owner_user_id UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Trusted catalog: the only source of price, shipping, tax and stock.
CREATE TABLE catalog_products (
  sku                   TEXT PRIMARY KEY,
  merchant_id           TEXT NOT NULL REFERENCES merchants(id),
  title                 TEXT NOT NULL,
  category              TEXT NOT NULL,
  attributes            JSONB NOT NULL,
  price                 NUMERIC(12,2) NOT NULL CHECK (price >= 0),
  shipping              NUMERIC(12,2) NOT NULL CHECK (shipping >= 0),
  tax_rate_bps          INTEGER NOT NULL DEFAULT 0 CHECK (tax_rate_bps >= 0),
  currency              TEXT NOT NULL DEFAULT 'USD',
  stock                 INTEGER NOT NULL DEFAULT 0,
  -- Free text supplied by the merchant: untrusted, never interpreted as instructions.
  untrusted_description TEXT NOT NULL DEFAULT '',
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE SEQUENCE permission_public_seq START 1;

CREATE TABLE permissions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id           TEXT NOT NULL UNIQUE
                        DEFAULT ('CW-POL-' || lpad(nextval('permission_public_seq')::text, 3, '0')),
  user_id             UUID NOT NULL REFERENCES users(id),
  status              TEXT NOT NULL DEFAULT 'DRAFT'
                        CHECK (status IN ('DRAFT', 'ACTIVE', 'REVOKED', 'CONSUMED')),
  -- Mutable working copy. Never trusted for shopping; only approved versions are.
  draft_json          JSONB,
  -- Hash the buyer was shown on the review screen; cleared by any draft edit.
  reviewed_terms_hash TEXT,
  active_version      INTEGER,
  used_at             TIMESTAMPTZ,
  revoked_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX permissions_user_idx ON permissions(user_id);

CREATE TABLE permission_versions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  permission_id     UUID NOT NULL REFERENCES permissions(id),
  version           INTEGER NOT NULL CHECK (version >= 1),
  canonical_json    TEXT NOT NULL,
  terms_hash        TEXT NOT NULL,
  summary_text      TEXT NOT NULL,
  expires_at        TIMESTAMPTZ NOT NULL,
  approved_by       UUID NOT NULL REFERENCES users(id),
  approved_at       TIMESTAMPTZ NOT NULL,
  approval_evidence JSONB NOT NULL,
  approval_record   TEXT NOT NULL,
  signature         TEXT NOT NULL,
  signing_key_id    TEXT NOT NULL,
  UNIQUE (permission_id, version)
);

CREATE TABLE cart_attempts (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  permission_version_id UUID NOT NULL REFERENCES permission_versions(id),
  cart_json             TEXT NOT NULL,
  cart_hash             TEXT NOT NULL,
  verdict               TEXT NOT NULL CHECK (verdict IN ('ALLOW', 'REVIEW', 'BLOCK')),
  mismatch_codes        JSONB NOT NULL DEFAULT '[]',
  evaluation            JSONB NOT NULL,
  buyer_cart_approved_at TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE payment_orders (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cart_attempt_id    UUID NOT NULL UNIQUE REFERENCES cart_attempts(id),
  reconciliation_key TEXT NOT NULL UNIQUE,
  paypal_request_id  TEXT NOT NULL UNIQUE,
  paypal_order_id    TEXT UNIQUE,
  amount             NUMERIC(12,2) NOT NULL,
  currency           TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'CREATING',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE payment_captures (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_order_id  UUID NOT NULL REFERENCES payment_orders(id),
  paypal_capture_id TEXT NOT NULL UNIQUE,
  status            TEXT NOT NULL,
  amount            NUMERIC(12,2) NOT NULL,
  currency          TEXT NOT NULL,
  response_hash     TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE passports (
  id               TEXT PRIMARY KEY,
  payment_order_id UUID NOT NULL UNIQUE REFERENCES payment_orders(id),
  bundle_json      TEXT NOT NULL,
  bundle_hash      TEXT NOT NULL,
  signature        TEXT NOT NULL,
  signing_key_id   TEXT NOT NULL,
  issued_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE dispute_cases (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_order_id UUID REFERENCES payment_orders(id),
  source           TEXT NOT NULL CHECK (source IN ('REAL', 'SAMPLE')),
  reason           TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'OPEN',
  reviewer_id      UUID REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE webhook_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  paypal_event_id TEXT NOT NULL UNIQUE,
  event_type      TEXT NOT NULL,
  verified        BOOLEAN NOT NULL,
  payload         JSONB NOT NULL,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only, hash-chained audit log for every evidence-relevant event.
CREATE TABLE evidence_events (
  seq          BIGSERIAL PRIMARY KEY,
  subject_type TEXT NOT NULL,
  subject_id   TEXT NOT NULL,
  case_id      UUID REFERENCES dispute_cases(id),
  event_type   TEXT NOT NULL,
  actor_id     UUID REFERENCES users(id),
  payload      JSONB NOT NULL,
  payload_hash TEXT NOT NULL,
  prev_hash    TEXT NOT NULL,
  hash         TEXT NOT NULL UNIQUE,
  created_at   TIMESTAMPTZ NOT NULL
);
CREATE INDEX evidence_subject_idx ON evidence_events(subject_type, subject_id);

-- Public verification keys (private keys never touch the database).
CREATE TABLE signing_keys (
  key_id         TEXT PRIMARY KEY,
  algorithm      TEXT NOT NULL DEFAULT 'Ed25519',
  public_key_pem TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Immutability: approved versions and audit entries can never be rewritten.
CREATE FUNCTION cw_forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'CW_IMMUTABLE: % rows are append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER permission_versions_immutable
  BEFORE UPDATE OR DELETE ON permission_versions
  FOR EACH ROW EXECUTE FUNCTION cw_forbid_mutation();

CREATE TRIGGER evidence_events_immutable
  BEFORE UPDATE OR DELETE ON evidence_events
  FOR EACH ROW EXECUTE FUNCTION cw_forbid_mutation();

-- Demo merchants (identities only; catalog arrives with Phase 2).
INSERT INTO merchants (id, display_name) VALUES
  ('DEMO-SNEAKER-STORE', 'Demo Sneaker Store'),
  ('DEMO-OUTLET-MARKET', 'Demo Outlet Market');
