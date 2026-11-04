import { randomUUID } from 'node:crypto';
import { db } from '@/lib/db';
import type { AssistantConversation, AssistantConversationSummary, ChatMessage } from '@/lib/ai/types';

interface ConversationRow {
  id: string;
  title: string | null;
  messages: unknown;
  created_at: string;
  updated_at: string;
  project_id?: string | null;
}

function normalizeMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => {
      const message = entry as Partial<ChatMessage>;
      return {
        id: typeof message.id === 'string' ? message.id : randomUUID(),
        role: message.role === 'user' || message.role === 'assistant' || message.role === 'system' ? message.role : 'assistant',
        content: typeof message.content === 'string' ? message.content : '',
        createdAt: typeof message.createdAt === 'string' ? message.createdAt : new Date().toISOString(),
        metadata: message.metadata,
      };
    });
}

function deriveTitle(messages: ChatMessage[]): string {
  const firstUser = messages.find((message) => message.role === 'user' && message.content.trim());
  if (!firstUser) {
    return 'New Conversation';
  }
  const normalized = firstUser.content.replace(/\s+/g, ' ').trim();
  return normalized.length > 48 ? `${normalized.slice(0, 45)}...` : normalized;
}

export async function ensureConversationProjectColumn() {
  await db.query(`ALTER TABLE assistant_conversations ADD COLUMN IF NOT EXISTS project_id TEXT REFERENCES projects(id) ON DELETE SET NULL`);
}

export async function listConversations(userId: string, projectId?: string | null): Promise<AssistantConversationSummary[]> {
  await ensureConversationProjectColumn();

  const rows = await db.query<ConversationRow>(
    `SELECT id, title, messages, created_at, updated_at, project_id
     FROM assistant_conversations
     WHERE user_id = $1
       AND ($2::text IS NULL OR project_id = $2)
     ORDER BY updated_at DESC
     LIMIT 50`,
    [userId, projectId || null]
  );

  return rows.map((row) => ({
    id: row.id,
    title: row.title || deriveTitle(normalizeMessages(row.messages)),
    updatedAt: row.updated_at,
    projectId: row.project_id ?? null,
  }));
}

export async function getConversation(userId: string, conversationId: string): Promise<AssistantConversation | null> {
  await ensureConversationProjectColumn();

  const row = await db.queryOne<ConversationRow>(
    `SELECT id, title, messages, created_at, updated_at, project_id
     FROM assistant_conversations
     WHERE user_id = $1 AND id = $2`,
    [userId, conversationId]
  );

  if (!row) {
    return null;
  }

  const messages = normalizeMessages(row.messages);
  return {
    id: row.id,
    title: row.title || deriveTitle(messages),
    updatedAt: row.updated_at,
    projectId: row.project_id ?? null,
    messages,
  };
}

export async function saveConversation(params: {
  userId: string;
  conversationId?: string | null;
  projectId?: string | null;
  messages: ChatMessage[];
}): Promise<AssistantConversation> {
  await ensureConversationProjectColumn();

  const conversationId = params.conversationId || randomUUID();
  const title = deriveTitle(params.messages);
  const messagesJson = JSON.stringify(params.messages);

  await db.query(
    `INSERT INTO assistant_conversations (id, user_id, title, messages, project_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, NOW(), NOW())
     ON CONFLICT (id) DO UPDATE SET
       title = EXCLUDED.title,
       messages = EXCLUDED.messages,
       project_id = EXCLUDED.project_id,
       updated_at = NOW()`,
    [conversationId, params.userId, title, messagesJson, params.projectId || null]
  );

  return {
    id: conversationId,
    title,
    updatedAt: new Date().toISOString(),
    projectId: params.projectId || null,
    messages: params.messages,
  };
}

export async function deleteConversation(userId: string, conversationId: string): Promise<boolean> {
  await ensureConversationProjectColumn();

  const result = await db.query<{ id: string }>(
    `DELETE FROM assistant_conversations
     WHERE id = $1 AND user_id = $2
     RETURNING id`,
    [conversationId, userId]
  );

  return result.length > 0;
}
