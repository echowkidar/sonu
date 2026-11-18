-- Material requests (MR): the contractor's "MATERIALS / SERVICE REQUEST" form, raised by field staff and worked by procurement.
-- Line photos are attachment rows with owner_type 'mr_line'; documents (quote, warranty, ...) have owner_type 'mr_doc'.
ALTER TABLE attachment ADD COLUMN doc_kind text;

CREATE TABLE material_request (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_id           uuid NOT NULL REFERENCES contractor (id) ON DELETE CASCADE,
  mr_no                   integer NOT NULL,
  work_request_id         uuid REFERENCES work_request (id) ON DELETE SET NULL,
  date_requested          date NOT NULL,
  project_name            text,
  contract_no             text,
  item_discipline         text,
  facility                text,
  zone                    text,
  building_name           text,
  purchase_type           text NOT NULL CHECK (purchase_type IN ('materials', 'services')),
  purpose                 text NOT NULL CHECK (purpose IN ('stock', 'new')),
  additional_requirements text,
  docs_required           text[] NOT NULL DEFAULT '{}',
  status                  text NOT NULL DEFAULT 'submitted'
                          CHECK (status IN ('submitted', 'accepted', 'enquiry', 'quoted', 'ordered', 'delivered', 'closed', 'rejected', 'cancelled')),
  requested_by            uuid REFERENCES app_user (id) ON DELETE SET NULL,
  assigned_to             uuid REFERENCES app_user (id) ON DELETE SET NULL,
  vendor_name             text,
  vendor_contact          text,
  quotation_ref           text,
  quoted_amount           numeric(12,2),
  expected_delivery       date,
  procurement_remarks     text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  closed_at               timestamptz,
  CONSTRAINT material_request_no_uq UNIQUE (contractor_id, mr_no)
);
CREATE INDEX material_request_status_idx ON material_request (contractor_id, status);
CREATE INDEX material_request_wr_idx ON material_request (contractor_id, work_request_id);
CREATE INDEX material_request_requester_idx ON material_request (contractor_id, requested_by);

CREATE TABLE material_request_line (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_id       uuid NOT NULL REFERENCES contractor (id) ON DELETE CASCADE,
  material_request_id uuid NOT NULL REFERENCES material_request (id) ON DELETE CASCADE,
  line_no             integer NOT NULL,
  wr_code             text,
  store_sl_no         text,
  client_mat_ref      text,
  description         text NOT NULL,
  quantity            numeric(12,3) NOT NULL CHECK (quantity > 0),
  uom                 text,
  brand               text,
  kind                text NOT NULL DEFAULT 'material' CHECK (kind IN ('material', 'service')),
  vendor_origin       text CHECK (vendor_origin IN ('local', 'foreign')),
  claimable           boolean,
  target_date         date,
  remarks             text
);
CREATE INDEX material_request_line_mr_idx ON material_request_line (material_request_id, line_no);

CREATE TABLE material_request_history (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_id       uuid NOT NULL REFERENCES contractor (id) ON DELETE CASCADE,
  material_request_id uuid NOT NULL REFERENCES material_request (id) ON DELETE CASCADE,
  from_status         text,
  to_status           text NOT NULL,
  note                text,
  user_id             uuid REFERENCES app_user (id) ON DELETE SET NULL,
  at                  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX material_request_history_mr_idx ON material_request_history (material_request_id, at);
