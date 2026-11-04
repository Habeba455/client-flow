import { randomUUID } from 'node:crypto';
import { ensureAssistantRuntimeTables } from '@/lib/assistant/schema';
import type { StoredApprovalAction } from '@/lib/assistant/action-executor';
import { db } from '@/lib/db';
import type { AgentName, ApprovalAction, ApprovalStatus, DeferredAction } from '@/lib/ai/types';

interface ApprovalRow {
  user_id?: string;
  id: string;
  title: string;
  action_type: string;
  status: ApprovalStatus;
  agent_name?: string | null;
  payload: Record<string, unknown>;
  output_content?: string | null;
  project_id: string | null;
  conversation_id: string | null;
  created_at: string;
  updated_at: string;
}

export async function createApprovalActions(params: {
  userId: string;
  projectId?: string | null;
  conversationId?: string | null;
  agent: AgentName;
  titleBase: string;
  output: string;
  actions: DeferredAction[];
}): Promise<ApprovalAction[]> {
  await ensureAssistantRuntimeTables();

  const created: ApprovalAction[] = [];
  for (const action of params.actions) {
    const id = action.id || randomUUID();
    const title = action.title || params.titleBase;
    const payload = {
      ...action.payload,
      output: params.output,
      recipient_email: action.recipient_email,
      drive_folder: action.drive_folder,
      generated_at: new Date().toISOString(),
    };

    await db.query(
      `INSERT INTO document_actions (id, user_id, project_id, conversation_id, title, action_type, status, agent_name, payload, output_content, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'PENDING_GENERATION', $7, $8::jsonb, $9, NOW(), NOW())`,
      [id, params.userId, params.projectId || null, params.conversationId || null, title, action.action_type, params.agent, JSON.stringify(payload), params.output]
    );

    await db.query(
      `UPDATE document_actions
       SET status = 'AWAITING_APPROVAL',
           payload = COALESCE(payload, '{}'::jsonb) || $3::jsonb,
           updated_at = NOW()
       WHERE id = $1 AND user_id = $2`,
      [id, params.userId, JSON.stringify({ approval_ready_at: new Date().toISOString() })]
    );

    created.push({
      id,
      title,
      status: 'AWAITING_APPROVAL',
      actionType: action.action_type,
      projectId: params.projectId || null,
      conversationId: params.conversationId || null,
      payload,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  return created;
}

export async function listPendingApprovalActions(userId: string, projectId?: string | null): Promise<ApprovalAction[]> {
  await ensureAssistantRuntimeTables();

  const rows = await db.query<ApprovalRow>(
    `SELECT id, title, action_type, status, payload, project_id, conversation_id, created_at, updated_at
     FROM document_actions
     WHERE user_id = $1
       AND status IN ('PENDING_GENERATION', 'AWAITING_APPROVAL', 'EDITING', 'APPROVED', 'ACTION_IN_PROGRESS')
       AND ($2::text IS NULL OR project_id = $2)
     ORDER BY created_at DESC
     LIMIT 20`,
    [userId, projectId || null]
  );

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status,
    actionType: row.action_type as ApprovalAction['actionType'],
    projectId: row.project_id,
    conversationId: row.conversation_id,
    payload: row.payload || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function getApprovalAction(userId: string, approvalId: string): Promise<StoredApprovalAction | null> {
  await ensureAssistantRuntimeTables();

  const row = await db.queryOne<ApprovalRow>(
    `SELECT user_id, id, title, action_type, status, agent_name, payload, output_content, project_id, conversation_id, created_at, updated_at
     FROM document_actions
     WHERE id = $1 AND user_id = $2
     LIMIT 1`,
    [approvalId, userId]
  );

  if (!row || !row.user_id) {
    return null;
  }

  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    status: row.status,
    actionType: row.action_type as ApprovalAction['actionType'],
    projectId: row.project_id,
    conversationId: row.conversation_id,
    payload: row.payload || {},
    outputContent: row.output_content || null,
    agentName: row.agent_name || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function updateApprovalAction(params: {
  approvalId: string;
  userId: string;
  status: ApprovalStatus;
  payloadPatch?: Record<string, unknown>;
}) {
  await ensureAssistantRuntimeTables();

  const row = await db.queryOne<ApprovalRow>(
    `UPDATE document_actions
     SET status = $3,
         payload = CASE
           WHEN $4::jsonb IS NULL THEN payload
           ELSE COALESCE(payload, '{}'::jsonb) || $4::jsonb
         END,
         updated_at = NOW()
     WHERE id = $1 AND user_id = $2
     RETURNING id, title, action_type, status, payload, project_id, conversation_id, created_at, updated_at`,
    [params.approvalId, params.userId, params.status, params.payloadPatch ? JSON.stringify(params.payloadPatch) : null]
  );

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    title: row.title,
    status: row.status,
    actionType: row.action_type as ApprovalAction['actionType'],
    projectId: row.project_id,
    conversationId: row.conversation_id,
    payload: row.payload || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } satisfies ApprovalAction;
}
