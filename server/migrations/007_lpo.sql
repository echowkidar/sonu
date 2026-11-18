-- LPO (Local Purchase Order): entered by hand by the procurement team once QF releases the LPO for a work request
-- with an approved RFE. SONU only records this; nothing here ever writes to Marafiq.
-- LPO documents are attachment rows with owner_type 'lpo_doc' (work_request_id set, so WR visibility rules apply).
CREATE TABLE lpo (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_id       uuid NOT NULL REFERENCES contractor (id) ON DELETE CASCADE,
  work_request_id     uuid NOT NULL REFERENCES work_request (id) ON DELETE CASCADE,
  wr_code             text NOT NULL,
  material_request_id uuid REFERENCES material_request (id) ON DELETE SET NULL,
  lpo_no              text NOT NULL,
  issue_date          date NOT NULL,
  vendor_name         text NOT NULL,
  vendor_contact      text,
  approved_amount     numeric(12,2) NOT NULL CHECK (approved_amount >= 0),
  rfe_amount_snapshot numeric(12,2),
  rfe_approved_on     date,
  remarks             text,
  status              text NOT NULL DEFAULT 'released' CHECK (status IN ('released', 'cancelled')),
  created_by          uuid REFERENCES app_user (id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid REFERENCES app_user (id) ON DELETE SET NULL,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  cancelled_reason    text
);
CREATE UNIQUE INDEX lpo_no_uq ON lpo (contractor_id, lower(lpo_no)) WHERE status <> 'cancelled';
CREATE INDEX lpo_wr_idx ON lpo (work_request_id);
CREATE INDEX lpo_mr_idx ON lpo (material_request_id);
CREATE INDEX lpo_status_idx ON lpo (contractor_id, status, issue_date DESC);

CREATE TABLE lpo_history (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_id uuid NOT NULL REFERENCES contractor (id) ON DELETE CASCADE,
  lpo_id        uuid NOT NULL REFERENCES lpo (id) ON DELETE CASCADE,
  action        text NOT NULL CHECK (action IN ('created', 'updated', 'cancelled', 'document_added', 'document_removed')),
  changes       jsonb NOT NULL DEFAULT '{}',
  user_id       uuid REFERENCES app_user (id) ON DELETE SET NULL,
  at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lpo_history_lpo_idx ON lpo_history (lpo_id, at);
