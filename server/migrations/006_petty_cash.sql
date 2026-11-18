-- Petty cash reimbursement claims: the contractor's "EXPENSE PETTY CASH REIMBURSEMENT CLAIM" form.
-- A supervisor prepares it, the contractor admin reviews it, the project manager approves it (QF is not involved).
-- Bill photos of manual lines are attachment rows with owner_type 'petty_cash_line'; lines made from a local purchase
-- (0 RFE) point at local_purchase and show that purchase's receipts (the files are not copied).
CREATE TABLE petty_cash_claim (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_id   uuid NOT NULL REFERENCES contractor (id) ON DELETE CASCADE,
  ref_no          integer NOT NULL,
  project_name    text,
  month           text NOT NULL CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  purchase_type   text NOT NULL DEFAULT 'materials' CHECK (purchase_type IN ('materials', 'services')),
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'returned', 'reviewed', 'approved', 'rejected')),
  prepared_by     uuid REFERENCES app_user (id) ON DELETE SET NULL,
  reviewed_by     uuid REFERENCES app_user (id) ON DELETE SET NULL,
  reviewed_at     timestamptz,
  approved_by     uuid REFERENCES app_user (id) ON DELETE SET NULL,
  approved_at     timestamptz,
  total_amount    numeric(12,2) NOT NULL DEFAULT 0,
  approved_amount numeric(12,2),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT petty_cash_claim_ref_uq UNIQUE (contractor_id, ref_no)
);
CREATE INDEX petty_cash_claim_status_idx ON petty_cash_claim (contractor_id, status);
CREATE INDEX petty_cash_claim_preparer_idx ON petty_cash_claim (contractor_id, prepared_by);

CREATE TABLE petty_cash_line (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_id         uuid NOT NULL REFERENCES contractor (id) ON DELETE CASCADE,
  claim_id              uuid NOT NULL REFERENCES petty_cash_claim (id) ON DELETE CASCADE,
  line_no               integer NOT NULL,
  work_request_id       uuid REFERENCES work_request (id) ON DELETE SET NULL,
  wr_code               text,
  wr_status             text,
  -- A local purchase (0 RFE) can be on one active claim only; holds_purchase is turned off when the claim is rejected.
  local_purchase_id     uuid REFERENCES local_purchase (id) ON DELETE SET NULL,
  holds_purchase        boolean NOT NULL DEFAULT true,
  grn_code              text,
  gl_code               text,
  wbs                   text,
  work_description      text,
  location              text,
  rfe_approved_amount   numeric(12,2) NOT NULL DEFAULT 0,
  claimable             boolean NOT NULL DEFAULT true,
  supplier              text,
  material_used         text,
  bill_date             date,
  bill_no               text,
  qty                   numeric(12,3) NOT NULL CHECK (qty > 0),
  unit                  text,
  unit_cost             numeric(12,2) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  discount              numeric(12,2) NOT NULL DEFAULT 0 CHECK (discount >= 0),
  total_amount          numeric(12,2) NOT NULL DEFAULT 0,
  approved_total        numeric(12,2)
);
CREATE INDEX petty_cash_line_claim_idx ON petty_cash_line (claim_id, line_no);
CREATE UNIQUE INDEX petty_cash_line_purchase_uq ON petty_cash_line (local_purchase_id) WHERE local_purchase_id IS NOT NULL AND holds_purchase;

CREATE TABLE petty_cash_history (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_id uuid NOT NULL REFERENCES contractor (id) ON DELETE CASCADE,
  claim_id      uuid NOT NULL REFERENCES petty_cash_claim (id) ON DELETE CASCADE,
  from_status   text,
  to_status     text NOT NULL,
  note          text,
  user_id       uuid REFERENCES app_user (id) ON DELETE SET NULL,
  at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX petty_cash_history_claim_idx ON petty_cash_history (claim_id, at);
