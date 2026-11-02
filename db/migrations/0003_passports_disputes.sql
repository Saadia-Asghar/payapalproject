-- Phases 3-5 (database side): payment reservations, Purchase Passports, merchant disputes.

CREATE SEQUENCE reconciliation_seq START 1;
CREATE SEQUENCE passport_seq START 1;
CREATE SEQUENCE dispute_seq START 1;

-- payment_orders.status lifecycle (written only by services/payments.ts):
-- CREATING -> PAYPAL_CREATED -> CAPTURED | FAILED | CANCELLED
ALTER TABLE payment_orders
  ADD COLUMN user_id UUID NOT NULL REFERENCES users(id),
  ADD COLUMN merchant_id TEXT NOT NULL REFERENCES merchants(id),
  ADD CONSTRAINT payment_orders_status_check
    CHECK (status IN ('CREATING', 'PAYPAL_CREATED', 'CAPTURED', 'FAILED', 'CANCELLED'));

-- At most one successful capture per order.
CREATE UNIQUE INDEX payment_captures_one_per_order ON payment_captures(payment_order_id);

ALTER TABLE passports ADD COLUMN user_id UUID NOT NULL REFERENCES users(id);

CREATE TRIGGER passports_immutable
  BEFORE UPDATE OR DELETE ON passports
  FOR EACH ROW EXECUTE FUNCTION cw_forbid_mutation();

CREATE TRIGGER payment_captures_immutable
  BEFORE UPDATE OR DELETE ON payment_captures
  FOR EACH ROW EXECUTE FUNCTION cw_forbid_mutation();

-- Disputes may concern a paid order (REAL or SAMPLE) or, before payments exist, an approved cart (SAMPLE only).
ALTER TABLE dispute_cases
  ADD COLUMN public_id TEXT NOT NULL UNIQUE DEFAULT ('CW-DSP-' || lpad(nextval('dispute_seq')::text, 5, '0')),
  ADD COLUMN cart_attempt_id UUID REFERENCES cart_attempts(id),
  ADD COLUMN merchant_id TEXT NOT NULL REFERENCES merchants(id),
  ADD COLUMN opened_by UUID NOT NULL REFERENCES users(id),
  ADD COLUMN complaint TEXT NOT NULL DEFAULT '',
  ADD COLUMN packet_json TEXT,
  ADD COLUMN packet_hash TEXT,
  ADD COLUMN reviewer_note TEXT,
  ADD COLUMN reviewed_at TIMESTAMPTZ,
  ADD CONSTRAINT dispute_reason_check
    CHECK (reason IN ('NOT_AUTHORIZED', 'WRONG_ITEM', 'NOT_RECEIVED', 'EXCEEDED_INSTRUCTIONS')),
  ADD CONSTRAINT dispute_status_check CHECK (status IN ('OPEN', 'REVIEWED')),
  ADD CONSTRAINT dispute_subject_check CHECK (payment_order_id IS NOT NULL OR cart_attempt_id IS NOT NULL),
  ADD CONSTRAINT dispute_real_needs_payment CHECK (source = 'SAMPLE' OR payment_order_id IS NOT NULL);
CREATE INDEX dispute_cases_merchant_idx ON dispute_cases(merchant_id);
