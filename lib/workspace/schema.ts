import { db } from '@/lib/db';

let ensuredProjectScopedFinance = false;
let ensuredClientsTable = false;
let ensuredServicesTable = false;
let ensuredClientProjectLinksTable = false;

export async function ensureProjectScopedFinanceColumns() {
  if (ensuredProjectScopedFinance) {
    return;
  }

  await db.query(`
    ALTER TABLE invoices
    ADD COLUMN IF NOT EXISTS project_id text
  `);

  await db.query(`
    ALTER TABLE pnl_entries
    ADD COLUMN IF NOT EXISTS project_id text
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_invoices_user_project
    ON invoices (user_id, project_id, created_at DESC)
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_pnl_entries_user_project
    ON pnl_entries (user_id, project_id, entry_date DESC)
  `);

  ensuredProjectScopedFinance = true;
}

export async function ensureClientsTable() {
  if (ensuredClientsTable) {
    return;
  }

  await db.query(`
    CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      timezone TEXT,
      company TEXT,
      primary_email TEXT,
      website TEXT,
      location TEXT,
      relationship_notes TEXT,
      enrichment_summary TEXT,
      enrichment_sources JSONB,
      recommended_services JSONB,
      enrichment_updated_at TIMESTAMPTZ,
      recommendations_updated_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await db.query(`
    ALTER TABLE clients
    ADD COLUMN IF NOT EXISTS company TEXT,
    ADD COLUMN IF NOT EXISTS primary_email TEXT,
    ADD COLUMN IF NOT EXISTS website TEXT,
    ADD COLUMN IF NOT EXISTS location TEXT,
    ADD COLUMN IF NOT EXISTS relationship_notes TEXT,
    ADD COLUMN IF NOT EXISTS enrichment_summary TEXT,
    ADD COLUMN IF NOT EXISTS enrichment_sources JSONB,
    ADD COLUMN IF NOT EXISTS recommended_services JSONB,
    ADD COLUMN IF NOT EXISTS enrichment_updated_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS recommendations_updated_at TIMESTAMPTZ
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_clients_user_id
    ON clients (user_id)
  `);

  ensuredClientsTable = true;
}

export async function ensureServicesTable() {
  if (ensuredServicesTable) {
    return;
  }

  await db.query(`
    CREATE TABLE IF NOT EXISTS services (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      code TEXT NOT NULL,
      category TEXT NOT NULL,
      description TEXT,
      estimated_duration TEXT,
      base_price NUMERIC(12, 2),
      currency TEXT,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, code)
    )
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_services_user_id
    ON services (user_id, is_active, category, name)
  `);

  ensuredServicesTable = true;
}

export async function ensureClientProjectLinksTable() {
  if (ensuredClientProjectLinksTable) {
    return;
  }

  await db.query(`
    CREATE TABLE IF NOT EXISTS client_project_links (
      client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (client_id, project_id)
    )
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_client_project_links_user_client
    ON client_project_links (user_id, client_id)
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_client_project_links_user_project
    ON client_project_links (user_id, project_id)
  `);

  ensuredClientProjectLinksTable = true;
}
