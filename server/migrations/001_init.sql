-- SONU schema for step 1 (export bridge + admin panel) and step 1b (Marafiq connection).
-- Rules: every business table carries contractor_id; secrets live only in table "secret"
-- (other tables hold secret_id); SONU-owned columns never sit in mirror tables.

-- ----------------------------- Platform -----------------------------

CREATE TABLE contractor (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                text NOT NULL,
  name                text NOT NULL,
  name_ar             text,
  marafiq_trade_code  text,
  marafiq_work_teams  text[] NOT NULL DEFAULT '{}',
  disciplines         text[] NOT NULL DEFAULT '{}',
  sender_email        text,
  time_zone           text NOT NULL DEFAULT 'Asia/Qatar',
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX contractor_code_uq ON contractor (lower(code));

CREATE TABLE secret (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_id uuid REFERENCES contractor (id) ON DELETE CASCADE,
  purpose       text NOT NULL,
  ciphertext    bytea NOT NULL,
  iv            bytea NOT NULL,
  tag           bytea NOT NULL,
  key_version   integer NOT NULL DEFAULT 1,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX secret_contractor_idx ON secret (contractor_id);

CREATE TABLE app_user (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_id      uuid REFERENCES contractor (id) ON DELETE RESTRICT,
  email              text NOT NULL,
  full_name          text NOT NULL,
  password_hash      text,
  role               text NOT NULL CHECK (role IN ('platform_admin', 'contractor_admin', 'manager', 'coordinator',
                                                  'purchasing', 'supervisor', 'foreman', 'technician')),
  status             text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'inactive')),
  email_verified_at  timestamptz,
  mobile             text,
  mobile_verified_at timestamptz,
  language           text NOT NULL DEFAULT 'English',
  notify_email       boolean NOT NULL DEFAULT true,
  notify_push        boolean NOT NULL DEFAULT true,
  notify_whatsapp    boolean NOT NULL DEFAULT false,
  quiet_hours_start  time,
  quiet_hours_end    time,
  reports_to         uuid REFERENCES app_user (id) ON DELETE SET NULL,
  employee_no        text,
  craftsperson_code  text,
  discipline         text,
  last_login_at      timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_user_tenant_ck CHECK ((role = 'platform_admin') = (contractor_id IS NULL))
);
CREATE UNIQUE INDEX app_user_email_uq ON app_user (lower(email));
CREATE INDEX app_user_contractor_idx ON app_user (contractor_id, role, status);
CREATE INDEX app_user_reports_to_idx ON app_user (reports_to);

CREATE TABLE work_team (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_id uuid NOT NULL REFERENCES contractor (id) ON DELETE CASCADE,
  code          text NOT NULL,
  name          text,
  zone          text,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX work_team_code_uq ON work_team (contractor_id, lower(code));

CREATE TABLE user_work_team (
  contractor_id uuid NOT NULL REFERENCES contractor (id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  work_team_id  uuid NOT NULL REFERENCES work_team (id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, work_team_id)
);
CREATE INDEX user_work_team_team_idx ON user_work_team (work_team_id);
CREATE INDEX user_work_team_contractor_idx ON user_work_team (contractor_id);

-- Invitation links and password-reset links (single use, hashed token, expiry).
CREATE TABLE invitation (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_id uuid REFERENCES contractor (id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  kind          text NOT NULL DEFAULT 'invite' CHECK (kind IN ('invite', 'password_reset')),
  token_hash    text NOT NULL UNIQUE,
  expires_at    timestamptz NOT NULL,
  used_at       timestamptz,
  revoked_at    timestamptz,
  created_by    uuid REFERENCES app_user (id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invitation_user_idx ON invitation (user_id, kind);
CREATE INDEX invitation_contractor_idx ON invitation (contractor_id);

CREATE TABLE session (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  contractor_id uuid REFERENCES contractor (id) ON DELETE CASCADE,
  token_hash    text NOT NULL UNIQUE,
  ip            text,
  user_agent    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL
);
CREATE INDEX session_user_idx ON session (user_id);
CREATE INDEX session_expires_idx ON session (expires_at);

CREATE TABLE audit_log (
  id            bigserial PRIMARY KEY,
  contractor_id uuid REFERENCES contractor (id) ON DELETE SET NULL,
  user_id       uuid REFERENCES app_user (id) ON DELETE SET NULL,
  user_email    text,
  action        text NOT NULL,
  entity_type   text,
  entity_id     text,
  summary       text,
  details       jsonb NOT NULL DEFAULT '{}',
  ip            text,
  at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_contractor_at_idx ON audit_log (contractor_id, at DESC);
CREATE INDEX audit_log_user_idx ON audit_log (user_id, at DESC);
CREATE INDEX audit_log_action_idx ON audit_log (action);
CREATE INDEX audit_log_entity_idx ON audit_log (entity_type, entity_id);

-- Platform-wide and per-contractor key/value settings (VAPID public key etc.; private parts via secret_id).
CREATE TABLE app_setting (
  key           text NOT NULL,
  contractor_id uuid REFERENCES contractor (id) ON DELETE CASCADE,
  value         jsonb NOT NULL DEFAULT '{}',
  secret_id     uuid REFERENCES secret (id) ON DELETE SET NULL,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX app_setting_uq ON app_setting (key, contractor_id) NULLS NOT DISTINCT;

-- ----------------------------- E-mail and messaging -----------------------------

-- contractor_id NULL = platform-level fallback sender.
CREATE TABLE mail_settings (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_id              uuid REFERENCES contractor (id) ON DELETE CASCADE,
  driver                     text NOT NULL DEFAULT 'log' CHECK (driver IN ('log', 'smtp', 'oauth2')),
  from_address               text,
  from_name                  text,
  reply_to                   text,
  signature                  text,
  footer                     text,
  purchasing_from_address    text,
  smtp_host                  text,
  smtp_port                  integer,
  smtp_secure                boolean NOT NULL DEFAULT false,
  smtp_user                  text,
  smtp_password_secret_id    uuid REFERENCES secret (id) ON DELETE SET NULL,
  oauth_provider             text CHECK (oauth_provider IN ('microsoft', 'google')),
  oauth_user                 text,
  oauth_client_id            text,
  oauth_tenant               text,
  oauth_client_secret_id     uuid REFERENCES secret (id) ON DELETE SET NULL,
  oauth_refresh_token_secret_id uuid REFERENCES secret (id) ON DELETE SET NULL,
  notification_mailbox       text,
  updated_by                 uuid REFERENCES app_user (id) ON DELETE SET NULL,
  updated_at                 timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX mail_settings_contractor_uq ON mail_settings (contractor_id) NULLS NOT DISTINCT;

-- Messages written by the "log" mail driver (no mail configured): usable invite links in local runs.
CREATE TABLE mail_outbox (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_id uuid REFERENCES contractor (id) ON DELETE CASCADE,
  to_address    text NOT NULL,
  subject       text NOT NULL,
  body_text     text NOT NULL,
  body_html     text,
  driver        text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mail_outbox_contractor_idx ON mail_outbox (contractor_id, created_at DESC);

CREATE TABLE messaging_settings (
  contractor_id          uuid PRIMARY KEY REFERENCES contractor (id) ON DELETE CASCADE,
  whatsapp_mode          text NOT NULL DEFAULT 'click_to_chat' CHECK (whatsapp_mode IN ('click_to_chat', 'linked_session')),
  whatsapp_number        text,
  linked_session_state   text NOT NULL DEFAULT 'not_linked',
  push_enabled           boolean NOT NULL DEFAULT true,
  sms_provider           text,
  rate_limit_per_minute  integer NOT NULL DEFAULT 6 CHECK (rate_limit_per_minute BETWEEN 1 AND 120),
  quiet_hours_start      time DEFAULT '21:00',
  quiet_hours_end        time DEFAULT '07:00',
  updated_by             uuid REFERENCES app_user (id) ON DELETE SET NULL,
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE push_subscription (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_id uuid REFERENCES contractor (id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  endpoint      text NOT NULL UNIQUE,
  p256dh        text NOT NULL,
  auth          text NOT NULL,
  user_agent    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz
);
CREATE INDEX push_subscription_user_idx ON push_subscription (user_id);

-- ----------------------------- Marafiq connection (step 1b) -----------------------------

CREATE TABLE marafiq_connection (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_id    uuid NOT NULL REFERENCES contractor (id) ON DELETE CASCADE,
  name             text NOT NULL DEFAULT 'Main',
  base_url         text,
  project          text NOT NULL DEFAULT 'MARAFIQ',
  username         text,
  secret_id        uuid REFERENCES secret (id) ON DELETE SET NULL,
  mode             text NOT NULL DEFAULT 'off' CHECK (mode IN ('off', 'read_only')),
  write_level      smallint NOT NULL DEFAULT 0 CHECK (write_level BETWEEN 0 AND 2),
  paused           boolean NOT NULL DEFAULT false,
  state            text NOT NULL DEFAULT 'idle' CHECK (state IN ('idle', 'running', 'ok', 'error', 'needs_attention')),
  schedule         jsonb NOT NULL DEFAULT '{}',
  enabled_lists    text[] NOT NULL DEFAULT '{}',
  last_success     jsonb NOT NULL DEFAULT '{}',
  last_sign_in_at  timestamptz,
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX marafiq_connection_name_uq ON marafiq_connection (contractor_id, name);

CREATE TABLE worker_job (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_id     uuid NOT NULL REFERENCES contractor (id) ON DELETE CASCADE,
  connection_id     uuid NOT NULL REFERENCES marafiq_connection (id) ON DELETE CASCADE,
  kind              text NOT NULL CHECK (kind IN ('test', 'sync')),
  lists             text[] NOT NULL DEFAULT '{}',
  status            text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'ok', 'signin_failed', 'error', 'cancelled')),
  requested_by      uuid REFERENCES app_user (id) ON DELETE SET NULL,
  sign_in_attempts  integer NOT NULL DEFAULT 0,
  result            jsonb NOT NULL DEFAULT '{}',
  message           text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  claimed_at        timestamptz,
  finished_at       timestamptz
);
CREATE INDEX worker_job_status_idx ON worker_job (status, created_at);
CREATE INDEX worker_job_connection_idx ON worker_job (connection_id, created_at DESC);
CREATE INDEX worker_job_contractor_idx ON worker_job (contractor_id);

CREATE TABLE sync_run (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_id  uuid NOT NULL REFERENCES contractor (id) ON DELETE CASCADE,
  connection_id  uuid REFERENCES marafiq_connection (id) ON DELETE SET NULL,
  worker_job_id  uuid REFERENCES worker_job (id) ON DELETE SET NULL,
  list_key       text NOT NULL,
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  rows_read      integer,
  result         text CHECK (result IN ('ok', 'error', 'signin_failed', 'skipped')),
  error          text
);
CREATE INDEX sync_run_contractor_idx ON sync_run (contractor_id, started_at DESC);
CREATE INDEX sync_run_connection_idx ON sync_run (connection_id, list_key, started_at DESC);

-- ----------------------------- Imports -----------------------------

-- One row per imported Marafiq export (manual upload or worker).
CREATE TABLE import_batch (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_id  uuid NOT NULL REFERENCES contractor (id) ON DELETE CASCADE,
  list_key       text NOT NULL,
  source         text NOT NULL CHECK (source IN ('manual', 'worker')),
  file_name      text,
  file_hash      text,
  user_id        uuid REFERENCES app_user (id) ON DELETE SET NULL,
  sync_run_id    uuid REFERENCES sync_run (id) ON DELETE SET NULL,
  status         text NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'failed')),
  error          text,
  rows_read      integer NOT NULL DEFAULT 0,
  rows_new       integer NOT NULL DEFAULT 0,
  rows_changed   integer NOT NULL DEFAULT 0,
  rows_gone      integer NOT NULL DEFAULT 0,
  rows_rejected  integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX import_batch_contractor_idx ON import_batch (contractor_id, list_key, created_at DESC);

-- Bulk-import previews (contractors / users / sub-contractors templates).
-- contractor_id NULL = started by a platform admin.
CREATE TABLE import_job (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_id  uuid REFERENCES contractor (id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('contractors', 'users', 'subcontractors')),
  file_name      text NOT NULL,
  file_hash      text NOT NULL,
  user_id        uuid REFERENCES app_user (id) ON DELETE SET NULL,
  status         text NOT NULL DEFAULT 'preview' CHECK (status IN ('preview', 'confirmed', 'cancelled')),
  preview        jsonb NOT NULL,
  rows_added     integer NOT NULL DEFAULT 0,
  rows_updated   integer NOT NULL DEFAULT 0,
  rows_rejected  integer NOT NULL DEFAULT 0,
  rows_skipped   integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  confirmed_at   timestamptz
);
CREATE INDEX import_job_contractor_idx ON import_job (contractor_id, created_at DESC);

-- Generic store for other imported lists (rows kept as JSON per batch).
CREATE TABLE list_snapshot (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_id    uuid NOT NULL REFERENCES contractor (id) ON DELETE CASCADE,
  list_key         text NOT NULL,
  import_batch_id  uuid NOT NULL REFERENCES import_batch (id) ON DELETE CASCADE,
  row_no           integer NOT NULL,
  row_key          text,
  row              jsonb NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX list_snapshot_batch_idx ON list_snapshot (import_batch_id, row_no);
CREATE INDEX list_snapshot_list_idx ON list_snapshot (contractor_id, list_key, row_key);

-- ----------------------------- Mirror of Marafiq -----------------------------

-- Columns from design 13 plus every column of "Pending Work Requests" (26 captions).
CREATE TABLE work_request (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_id             uuid NOT NULL REFERENCES contractor (id) ON DELETE CASCADE,
  wr_code                   text NOT NULL,             -- Work Request Code
  wr_status                 text,                      -- Work Request Status
  sr_code                   text,                      -- Service Request Code
  wo_code                   text,
  ptw_code                  text,                      -- Permit to Work Code
  ptw_status                text,                      -- Permit to Work Status
  requestor_name            text,                      -- Requestor Name (restricted)
  contractor_code           text,                      -- Contractor
  site_code                 text,                      -- Site Code
  site_name                 text,                      -- Site Name
  building_code             text,                      -- Building Code
  building_name             text,                      -- Building Name
  floor_code                text,                      -- Floor Code
  room_code                 text,                      -- Room Code
  directorate_code          text,                      -- Directorate Code
  department_code           text,                      -- Department Code
  equipment_code            text,                      -- Equipment Code
  equipment_standard        text,                      -- Equipment Standard
  problem_type              text,                      -- Problem Type
  problem_type_description  text,                      -- Problem Type Description
  work_team_code            text,                      -- Work Team Code
  priority                  text,                      -- Work Request Priority
  description               text,                      -- WR Description
  date_requested            timestamptz,               -- Date Work Requested
  agreed_target_date        timestamptz,               -- Agreed Target Date
  date_trade_assigned       timestamptz,               -- Date Trade Assigned
  est_total_cost            numeric(14, 2),            -- Estimated Total Cost
  date_to_perform           timestamptz,
  descriptive_status        text,
  with_rfe                  boolean,
  progress_pct              numeric(5, 2),
  closure_comments          text,
  raw                       jsonb NOT NULL DEFAULT '{}', -- extra captions from other lists
  first_seen_at             timestamptz NOT NULL DEFAULT now(),
  last_seen_at              timestamptz NOT NULL DEFAULT now(),
  gone_at                   timestamptz,
  last_import_id            uuid REFERENCES import_batch (id) ON DELETE SET NULL,
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT work_request_code_uq UNIQUE (contractor_id, wr_code)
);
CREATE INDEX work_request_open_idx ON work_request (contractor_id, gone_at);
CREATE INDEX work_request_team_idx ON work_request (contractor_id, work_team_code);
CREATE INDEX work_request_site_idx ON work_request (contractor_id, site_code);
CREATE INDEX work_request_status_idx ON work_request (contractor_id, wr_status);
CREATE INDEX work_request_ptw_idx ON work_request (contractor_id, ptw_code);

CREATE TABLE rfe_status (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_id      uuid NOT NULL REFERENCES contractor (id) ON DELETE CASCADE,
  work_request_id    uuid REFERENCES work_request (id) ON DELETE SET NULL,
  wr_code            text NOT NULL,
  submitted_on       timestamptz,
  approved_on        timestamptz,
  pending_with       text,
  rfe_amount         numeric(14, 2),
  bpa_release_ref    text,
  bpa_release_date   timestamptz,
  raw                jsonb NOT NULL DEFAULT '{}',
  first_seen_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at       timestamptz NOT NULL DEFAULT now(),
  gone_at            timestamptz,
  last_import_id     uuid REFERENCES import_batch (id) ON DELETE SET NULL,
  CONSTRAINT rfe_status_uq UNIQUE (contractor_id, wr_code)
);
CREATE INDEX rfe_status_wr_idx ON rfe_status (work_request_id);

CREATE TABLE rfe_comment (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_id        uuid NOT NULL REFERENCES contractor (id) ON DELETE CASCADE,
  work_request_id      uuid REFERENCES work_request (id) ON DELETE SET NULL,
  log_id               text NOT NULL,
  wr_code              text,
  text                 text,
  created_by_name      text,
  created_on           timestamptz,
  send_to              text,
  is_done              boolean,
  answered_in_sonu_at  timestamptz,
  answered_by          uuid REFERENCES app_user (id) ON DELETE SET NULL,
  raw                  jsonb NOT NULL DEFAULT '{}',
  first_seen_at        timestamptz NOT NULL DEFAULT now(),
  last_seen_at         timestamptz NOT NULL DEFAULT now(),
  last_import_id       uuid REFERENCES import_batch (id) ON DELETE SET NULL,
  CONSTRAINT rfe_comment_uq UNIQUE (contractor_id, log_id)
);
CREATE INDEX rfe_comment_wr_idx ON rfe_comment (contractor_id, wr_code);

CREATE TABLE permit (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_id    uuid NOT NULL REFERENCES contractor (id) ON DELETE CASCADE,
  ptw_code         text NOT NULL,
  status           text,
  type             text,
  date_start       timestamptz,
  date_upto        timestamptz,
  date_issued      timestamptz,
  applicant        text,
  controller       text,
  authority        text,
  wr_codes         text[] NOT NULL DEFAULT '{}',
  raw              jsonb NOT NULL DEFAULT '{}',
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  gone_at          timestamptz,
  last_import_id   uuid REFERENCES import_batch (id) ON DELETE SET NULL,
  CONSTRAINT permit_uq UNIQUE (contractor_id, ptw_code)
);
CREATE INDEX permit_upto_idx ON permit (contractor_id, date_upto);

CREATE TABLE money_trail (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_id    uuid NOT NULL REFERENCES contractor (id) ON DELETE CASCADE,
  work_request_id  uuid REFERENCES work_request (id) ON DELETE SET NULL,
  wr_code          text NOT NULL,
  demand_note      text,
  pr_no            text,
  pr_date          timestamptz,
  pr_status        text,
  po_no            text,
  po_date          timestamptz,
  po_status        text,
  wcc_no           text,
  wcc_date         timestamptz,
  wcc_status       text,
  invoice_no       text,
  invoice_status   text,
  raw              jsonb NOT NULL DEFAULT '{}',
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  last_import_id   uuid REFERENCES import_batch (id) ON DELETE SET NULL,
  CONSTRAINT money_trail_uq UNIQUE (contractor_id, wr_code)
);

-- ----------------------------- SONU's own work data -----------------------------

CREATE TABLE deadline_rule (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_id    uuid NOT NULL REFERENCES contractor (id) ON DELETE CASCADE,
  key              text NOT NULL,
  name             text NOT NULL,
  applies_to       text NOT NULL,
  criteria         smallint[],                      -- NULL = any criterion
  stage            text,                            -- QF descriptive stage number or SONU stage, NULL = any
  clock_start      text NOT NULL DEFAULT 'date_trade_assigned',
  limit_value      integer,                         -- NULL when the limit is a date field (see limit_unit)
  limit_unit       text NOT NULL CHECK (limit_unit IN ('hours', 'days', 'working_days', 'same_day', 'date_field')),
  limit_field      text,                            -- e.g. permit.date_upto, lpo.promised_date
  warnings         jsonb NOT NULL DEFAULT '[]',     -- [{ "value": 8, "unit": "days" }] or [{ "every": 3, "unit": "days" }]
  on_breach        text NOT NULL,
  escalation_roles text[] NOT NULL DEFAULT '{}',
  params           jsonb NOT NULL DEFAULT '{}',
  active           boolean NOT NULL DEFAULT true,
  sort_order       integer NOT NULL DEFAULT 0,
  updated_by       uuid REFERENCES app_user (id) ON DELETE SET NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT deadline_rule_key_uq UNIQUE (contractor_id, key)
);

CREATE TABLE wr_internal (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_id     uuid NOT NULL REFERENCES contractor (id) ON DELETE CASCADE,
  work_request_id   uuid NOT NULL REFERENCES work_request (id) ON DELETE CASCADE,
  owner_id          uuid REFERENCES app_user (id) ON DELETE SET NULL,
  criterion         smallint CHECK (criterion BETWEEN 1 AND 4),
  contractor_status text,
  fc_remarks        text,
  status_source     text NOT NULL DEFAULT 'manual' CHECK (status_source IN ('manual', 'suggested', 'tracker_import')),
  discipline        text,
  internal_stage    text,
  deadline_rule_id  uuid REFERENCES deadline_rule (id) ON DELETE SET NULL,
  due_at            timestamptz,
  breach_level      smallint NOT NULL DEFAULT 0,
  updated_by        uuid REFERENCES app_user (id) ON DELETE SET NULL,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wr_internal_wr_uq UNIQUE (work_request_id)
);
CREATE INDEX wr_internal_owner_idx ON wr_internal (contractor_id, owner_id);

CREATE TABLE wr_stage_history (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_id    uuid NOT NULL REFERENCES contractor (id) ON DELETE CASCADE,
  work_request_id  uuid NOT NULL REFERENCES work_request (id) ON DELETE CASCADE,
  source           text NOT NULL CHECK (source IN ('marafiq', 'sonu')),
  from_stage       text,
  to_stage         text NOT NULL,
  at               timestamptz NOT NULL DEFAULT now(),
  import_batch_id  uuid REFERENCES import_batch (id) ON DELETE SET NULL,
  user_id          uuid REFERENCES app_user (id) ON DELETE SET NULL
);
CREATE INDEX wr_stage_history_wr_idx ON wr_stage_history (work_request_id, at);
CREATE INDEX wr_stage_history_contractor_idx ON wr_stage_history (contractor_id, at DESC);

CREATE TABLE wr_event (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_id    uuid NOT NULL REFERENCES contractor (id) ON DELETE CASCADE,
  work_request_id  uuid REFERENCES work_request (id) ON DELETE CASCADE,
  type             text NOT NULL,
  source           text NOT NULL CHECK (source IN ('marafiq', 'sonu')),
  payload          jsonb NOT NULL DEFAULT '{}',
  at               timestamptz NOT NULL DEFAULT now(),
  user_id          uuid REFERENCES app_user (id) ON DELETE SET NULL,
  import_batch_id  uuid REFERENCES import_batch (id) ON DELETE SET NULL
);
CREATE INDEX wr_event_wr_idx ON wr_event (work_request_id, at);
CREATE INDEX wr_event_contractor_idx ON wr_event (contractor_id, type, at DESC);

CREATE TABLE assignment (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_id    uuid NOT NULL REFERENCES contractor (id) ON DELETE CASCADE,
  work_request_id  uuid NOT NULL REFERENCES work_request (id) ON DELETE CASCADE,
  assignee_id      uuid NOT NULL REFERENCES app_user (id) ON DELETE RESTRICT,
  assigned_by      uuid REFERENCES app_user (id) ON DELETE SET NULL,
  status           text NOT NULL DEFAULT 'assigned' CHECK (status IN ('assigned', 'started', 'done')),
  planned_date     date,
  hours_planned    numeric(6, 2),
  note             text,
  started_at       timestamptz,
  done_at          timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX assignment_assignee_idx ON assignment (contractor_id, assignee_id, status);
CREATE INDEX assignment_wr_idx ON assignment (work_request_id);

CREATE TABLE job_update (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_id  uuid NOT NULL REFERENCES contractor (id) ON DELETE CASCADE,
  assignment_id  uuid NOT NULL REFERENCES assignment (id) ON DELETE CASCADE,
  user_id        uuid REFERENCES app_user (id) ON DELETE SET NULL,
  note           text,
  status_to      text CHECK (status_to IN ('assigned', 'started', 'done')),
  at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX job_update_assignment_idx ON job_update (assignment_id, at);

-- owner_type / owner_id point at the record the file belongs to (work_request, assignment, job_update, ...).
CREATE TABLE attachment (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_id    uuid NOT NULL REFERENCES contractor (id) ON DELETE CASCADE,
  owner_type       text NOT NULL,
  owner_id         uuid NOT NULL,
  work_request_id  uuid REFERENCES work_request (id) ON DELETE SET NULL,
  file_path        text NOT NULL,       -- relative to UPLOAD_DIR
  file_name        text NOT NULL,
  mime             text NOT NULL,
  size_bytes       bigint NOT NULL,
  sha256           text,
  uploaded_by      uuid REFERENCES app_user (id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attachment_owner_idx ON attachment (contractor_id, owner_type, owner_id);
CREATE INDEX attachment_wr_idx ON attachment (work_request_id);

CREATE TABLE notification (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_id    uuid REFERENCES contractor (id) ON DELETE CASCADE,
  event            text NOT NULL,
  entity_type      text,
  entity_id        text,
  work_request_id  uuid REFERENCES work_request (id) ON DELETE SET NULL,
  recipient_id     uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  channel          text NOT NULL CHECK (channel IN ('in_app', 'email', 'push', 'whatsapp')),
  template         text,
  title            text NOT NULL,
  body             text,
  link             text,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'delivered', 'failed', 'skipped')),
  error            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  sent_at          timestamptz,
  delivered_at     timestamptz,
  read_at          timestamptz
);
CREATE INDEX notification_recipient_idx ON notification (recipient_id, channel, read_at, created_at DESC);
CREATE INDEX notification_pending_idx ON notification (status, channel) WHERE status = 'pending';
CREATE INDEX notification_contractor_idx ON notification (contractor_id, created_at DESC);

-- ----------------------------- Lookups (seeded from assets/tracker-lookups.json) -----------------------------

CREATE TABLE site_lookup (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_id  uuid NOT NULL REFERENCES contractor (id) ON DELETE CASCADE,
  site_code      text NOT NULL,
  site_name      text,
  zone           text,
  facility       text,
  group_name     text,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT site_lookup_uq UNIQUE (contractor_id, site_code)
);

CREATE TABLE problem_type_lookup (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_id  uuid NOT NULL REFERENCES contractor (id) ON DELETE CASCADE,
  problem_type   text NOT NULL,
  discipline     text NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT problem_type_lookup_uq UNIQUE (contractor_id, problem_type)
);

-- ----------------------------- Sub-contractors (directory only; module is step 2) -----------------------------

CREATE TABLE subcontractor (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_id      uuid NOT NULL REFERENCES contractor (id) ON DELETE CASCADE,
  code               text NOT NULL,
  name               text NOT NULL,
  name_ar            text,
  cr_number          text,
  categories         text[] NOT NULL DEFAULT '{}',
  zones_served       text[] NOT NULL DEFAULT '{}',
  address            text,
  website            text,
  payment_terms      text,
  emergency_callout  boolean,
  status             text NOT NULL DEFAULT 'Pending verification',
  notes              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX subcontractor_code_uq ON subcontractor (contractor_id, lower(code));

CREATE TABLE sub_contact (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_id       uuid NOT NULL REFERENCES contractor (id) ON DELETE CASCADE,
  subcontractor_id    uuid NOT NULL REFERENCES subcontractor (id) ON DELETE CASCADE,
  name                text NOT NULL,
  role                text,
  mobile              text NOT NULL,
  whatsapp            text,
  email               text,
  preferred_channel   text,
  language            text,
  receives_enquiries  boolean,
  receives_urgent     boolean,
  escalation_order    integer,
  consent             boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sub_contact_mobile_uq UNIQUE (subcontractor_id, mobile)
);
CREATE INDEX sub_contact_contractor_idx ON sub_contact (contractor_id);
