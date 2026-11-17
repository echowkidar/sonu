-- Operational modules (imports, tracker loader, work requests, jobs, deadline sweep).
-- Only what 001 lacks: an import result marker + event count + parse warnings, and a store for tracker previews.

ALTER TABLE import_batch
  ADD COLUMN result   text NOT NULL DEFAULT 'ok' CHECK (result IN ('ok', 'unchanged', 'failed')),
  ADD COLUMN events   integer NOT NULL DEFAULT 0,
  ADD COLUMN warnings jsonb NOT NULL DEFAULT '[]';

-- Tracker workbook loads (preview first, then confirm). Rows are kept until confirmed.
CREATE TABLE tracker_load (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_id  uuid NOT NULL REFERENCES contractor (id) ON DELETE CASCADE,
  file_name      text NOT NULL,
  file_hash      text NOT NULL,
  user_id        uuid REFERENCES app_user (id) ON DELETE SET NULL,
  status         text NOT NULL DEFAULT 'preview' CHECK (status IN ('preview', 'confirmed')),
  preview        jsonb NOT NULL,
  rows           jsonb NOT NULL,
  rows_written   integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  confirmed_at   timestamptz
);
CREATE INDEX tracker_load_contractor_idx ON tracker_load (contractor_id, created_at DESC);

CREATE INDEX wr_event_batch_idx ON wr_event (import_batch_id);
CREATE INDEX wr_event_wr_type_idx ON wr_event (work_request_id, type);
CREATE INDEX list_snapshot_list_batch_idx ON list_snapshot (contractor_id, list_key, created_at DESC);
