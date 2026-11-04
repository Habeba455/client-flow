import { db } from '@/lib/db';

let initializationPromise: Promise<void> | null = null;

export function ensureAssistantRuntimeTables(): Promise<void> {
  if (!initializationPromise) {
    initializationPromise = initializeAssistantRuntimeTables().catch((error) => {
      initializationPromise = null;
      throw error;
    });
  }
  return initializationPromise;
}

async function initializeAssistantRuntimeTables(): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS project_email_summaries (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      thread_id TEXT NOT NULL,
      thread_subject TEXT NOT NULL,
      participants TEXT,
      summary TEXT NOT NULL,
      reply_needed BOOLEAN NOT NULL DEFAULT FALSE,
      reply_urgency TEXT,
      last_message_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_project_email_summaries_thread
    ON project_email_summaries (project_id, thread_id)
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS email_thread_analysis_cache (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
      thread_id TEXT NOT NULL,
      thread_subject TEXT NOT NULL,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      project_name TEXT,
      project_description TEXT,
      thread_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      analysis JSONB NOT NULL DEFAULT '{}'::jsonb,
      meeting_invitation_sent BOOLEAN NOT NULL DEFAULT FALSE,
      meeting_calendar_event_id TEXT,
      last_message_at TIMESTAMPTZ,
      analyzed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await db.query(`
    ALTER TABLE email_thread_analysis_cache
    ADD COLUMN IF NOT EXISTS thread_payload JSONB NOT NULL DEFAULT '{}'::jsonb
  `);

  await db.query(`
    ALTER TABLE email_thread_analysis_cache
    ADD COLUMN IF NOT EXISTS meeting_invitation_sent BOOLEAN NOT NULL DEFAULT FALSE
  `);

  await db.query(`
    ALTER TABLE email_thread_analysis_cache
    ADD COLUMN IF NOT EXISTS meeting_calendar_event_id TEXT
  `);

  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_email_thread_analysis_cache_user_thread
    ON email_thread_analysis_cache (user_id, thread_id)
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS project_meeting_notes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      calendar_event_id TEXT,
      title TEXT NOT NULL,
      meeting_date TIMESTAMPTZ,
      attendees TEXT,
      summary TEXT NOT NULL,
      decisions JSONB NOT NULL DEFAULT '[]'::jsonb,
      action_items JSONB NOT NULL DEFAULT '[]'::jsonb,
      raw_notes TEXT,
      source TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_project_meeting_notes_calendar_event
    ON project_meeting_notes (project_id, calendar_event_id)
    WHERE calendar_event_id IS NOT NULL
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_project_meeting_notes_project_date
    ON project_meeting_notes (project_id, meeting_date DESC NULLS LAST, created_at DESC)
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS document_actions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      conversation_id TEXT REFERENCES assistant_conversations(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      action_type TEXT NOT NULL,
      status TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      output_content TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_document_actions_user_status
    ON document_actions (user_id, status, created_at DESC)
  `);

  await db.query(`
    ALTER TABLE project_documents
    ADD COLUMN IF NOT EXISTS source_email_thread_id TEXT
  `);

  await db.query(`
    ALTER TABLE project_members
    ADD COLUMN IF NOT EXISTS role TEXT
  `);

  await db.query(`
    ALTER TABLE project_members
    ADD COLUMN IF NOT EXISTS responsibilities TEXT
  `);

  await db.query(`
    ALTER TABLE project_members
    ADD COLUMN IF NOT EXISTS access_level TEXT
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_project_documents_email_source
    ON project_documents (project_id, user_id, file_name, source_email_thread_id)
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS project_memory_chunks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_title TEXT NOT NULL,
      chunk_index INTEGER NOT NULL DEFAULT 0,
      content TEXT NOT NULL,
      embedding JSONB NOT NULL DEFAULT '[]'::jsonb,
      content_hash TEXT NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_project_memory_chunks_source_chunk
    ON project_memory_chunks (project_id, source_type, source_id, chunk_index)
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_project_memory_chunks_project_source
    ON project_memory_chunks (project_id, source_type, updated_at DESC)
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS nylas_grants (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
      grant_id TEXT NOT NULL UNIQUE,
      provider TEXT,
      email TEXT,
      status TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_nylas_grants_user
    ON nylas_grants (user_id)
  `);

}
