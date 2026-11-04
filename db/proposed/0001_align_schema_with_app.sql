-- PROPOSED MIGRATION 0001 — NOT APPLIED. Awaiting explicit approval.
-- Target: clientflow-test (public schema). Additive only: no drops, no data changes.
-- Every statement is idempotent (IF NOT EXISTS), so re-running is safe.
--
-- Why each part exists:
--   projects.owner_user_id, progress, linked_contacts : read/written by lib/assistant/project-record.ts,
--     project-memory.ts, project-semantic-memory.ts, email-hub.ts, product-data.ts (getProjectDetail).
--     Without them the project page and assistant project memory fail.
--   pnl_entries : expenses (app/api/expenses, finance routes, product-data). Table does not exist.
--   invoices    : invoices (finance routes, action-executor). Table does not exist.

BEGIN;

ALTER TABLE projects ADD COLUMN IF NOT EXISTS owner_user_id text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS progress integer;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS linked_contacts text[];

CREATE TABLE IF NOT EXISTS pnl_entries (
  id                    text PRIMARY KEY,
  user_id               text NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  type                  text NOT NULL,                       -- 'expense' (income reserved)
  description           text,
  category              text,
  amount                numeric(12, 2) NOT NULL,
  currency              text NOT NULL DEFAULT 'USD',
  entry_date            date NOT NULL,
  project_id            text REFERENCES projects(id) ON DELETE SET NULL,
  recurring_cadence     text,
  recurring_start_date  date,
  recurring_end_date    date,
  created_at            timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pnl_entries_user_project ON pnl_entries (user_id, project_id, entry_date DESC);

CREATE TABLE IF NOT EXISTS invoices (
  id              text PRIMARY KEY,
  user_id         text NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  client_id       text REFERENCES clients(id) ON DELETE SET NULL,
  project_id      text REFERENCES projects(id) ON DELETE SET NULL,
  invoice_number  text NOT NULL,
  share_token     text NOT NULL UNIQUE,
  status          text NOT NULL DEFAULT 'draft',
  currency        text NOT NULL DEFAULT 'USD',
  issue_date      timestamptz NOT NULL DEFAULT NOW(),
  due_date        timestamptz,
  subtotal        numeric(12, 2),
  tax_rate        numeric(6, 4),
  tax_amount      numeric(12, 2),
  total           numeric(12, 2) NOT NULL,
  notes           text,
  document_url    text,
  created_at      timestamptz NOT NULL DEFAULT NOW(),
  updated_at      timestamptz NOT NULL DEFAULT NOW(),
  paid_at         timestamptz,
  UNIQUE (user_id, invoice_number)
);
CREATE INDEX IF NOT EXISTS idx_invoices_user_project ON invoices (user_id, project_id, created_at DESC);

-- Line items (app/api/projects/[projectId]/finance, lib/assistant/action-executor.ts). Table does not exist.
CREATE TABLE IF NOT EXISTS invoice_items (
  id          text PRIMARY KEY,
  invoice_id  text NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  description text NOT NULL,
  quantity    numeric(12, 2) NOT NULL DEFAULT 1,
  unit_amount numeric(12, 2),
  line_total  numeric(12, 2) NOT NULL,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items (invoice_id, sort_order);

COMMIT;
