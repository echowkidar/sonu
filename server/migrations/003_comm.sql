-- Communication (notification dispatch, web push, WhatsApp) and Marafiq-connection scheduling.

-- Dispatcher bookkeeping on notification rows.
ALTER TABLE notification
  ADD COLUMN attempts         integer NOT NULL DEFAULT 0,
  ADD COLUMN next_attempt_at  timestamptz,
  ADD COLUMN last_attempt_at  timestamptz,
  -- Extra payload: { url, record, whatsapp: { url, to } } — never a secret.
  ADD COLUMN data             jsonb NOT NULL DEFAULT '{}';
DROP INDEX IF EXISTS notification_pending_idx;
CREATE INDEX notification_pending_idx ON notification (next_attempt_at NULLS FIRST, created_at) WHERE status = 'pending';

-- WhatsApp linked-session state and rate limits (per contractor).
ALTER TABLE messaging_settings
  ADD COLUMN wa_min_interval_seconds integer NOT NULL DEFAULT 20 CHECK (wa_min_interval_seconds BETWEEN 10 AND 3600),
  ADD COLUMN wa_daily_limit          integer NOT NULL DEFAULT 200 CHECK (wa_daily_limit BETWEEN 1 AND 500),
  ADD COLUMN wa_session_secret_id    uuid REFERENCES secret (id) ON DELETE SET NULL,
  ADD COLUMN wa_linked_number        text,
  ADD COLUMN wa_last_error           text,
  ADD COLUMN wa_last_sent_at         timestamptz,
  ADD COLUMN wa_sent_day             date,
  ADD COLUMN wa_sent_today           integer NOT NULL DEFAULT 0,
  ADD COLUMN wa_risk_acknowledged_at timestamptz,
  ADD COLUMN wa_risk_acknowledged_by uuid REFERENCES app_user (id) ON DELETE SET NULL;
ALTER TABLE messaging_settings ALTER COLUMN linked_session_state SET DEFAULT 'off';
UPDATE messaging_settings SET linked_session_state = 'off' WHERE linked_session_state = 'not_linked';

-- Never more than one open (queued / running) worker job per connection.
CREATE UNIQUE INDEX worker_job_one_open_uq ON worker_job (connection_id) WHERE status IN ('queued', 'running');
CREATE INDEX sync_run_job_idx ON sync_run (worker_job_id, list_key);
