-- "0 RFE": jobs whose material costs under QR 100 are bought locally with petty cash, with no estimate (RFE) sent to QF.
ALTER TABLE wr_internal
  ADD COLUMN zero_rfe_at     timestamptz,
  ADD COLUMN zero_rfe_by     uuid REFERENCES app_user (id) ON DELETE SET NULL,
  ADD COLUMN zero_rfe_amount numeric(10,2),
  ADD COLUMN zero_rfe_note   text;

-- One row per local (petty cash) purchase. Receipt photos are attachment rows with owner_type 'local_purchase'.
CREATE TABLE local_purchase (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_id    uuid NOT NULL REFERENCES contractor (id) ON DELETE CASCADE,
  work_request_id  uuid NOT NULL REFERENCES work_request (id) ON DELETE CASCADE,
  item             text NOT NULL,
  amount           numeric(10,2) NOT NULL CHECK (amount > 0),
  purchased_on     date NOT NULL,
  petty_cash_ref   text,
  created_by       uuid REFERENCES app_user (id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX local_purchase_wr_idx ON local_purchase (contractor_id, work_request_id);
