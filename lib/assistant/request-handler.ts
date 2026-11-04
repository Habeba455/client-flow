import { createHash, randomUUID } from 'node:crypto';
import { inferDeferredActionType } from '@/lib/ai/agent-config';
import { saveAssistantProfile, getAssistantProfile } from '@/lib/assistant-profile';
import { createApprovalActions, listPendingApprovalActions } from '@/lib/assistant/approvals';
import { getConversation, listConversations, saveConversation } from '@/lib/assistant/conversations';
import { normalizeProjectDocumentStorageProvider } from '@/lib/assistant/document-ingestion';
import { answerProjectQuestion } from '@/lib/assistant/project-semantic-memory';
import {
  buildProjectCoordinatorRecordText,
  generateDefaultMilestones,
  getMissingProjectCreationFields,
  parseProjectRequestFallback,
  persistProjectCoordinatorRun,
  projectCreateRequested,
} from '@/lib/assistant/project-record';
import { buildResearchRetrievalPlan, formatResearchPlanForReply } from '@/lib/assistant/research-flow';
import { executeRoutingPlan, mergeAgentOutputs } from '@/lib/assistant/runner';
import { ensureAssistantRuntimeTables } from '@/lib/assistant/schema';
import { db } from '@/lib/db';
import { routeMessage } from '@/lib/ai/orchestrator';
import { createProposalPdf, isProposalTask } from '@/lib/proposals/service';
import { runSettingsAgentTurn } from '@/lib/ai/settings-agent';
import { enrichCalendarTaskContext } from '@/lib/calendar/availability-context';
import { createGoogleCalendarEvent } from '@/lib/google/calendar';
import { createSpreadsheetArtifact, parseSpreadsheetBlueprint } from '@/lib/xlsx/service';
import type {
  AgentRunResult,
  AssistantRequest,
  AssistantResponse,
  ChatMessage,
  RoutingDecision,
  RoutingTask,
  WorkspaceArtifact,
  WorkspaceState,
} from '@/lib/ai/types';

const EMPTY_WORKSPACE: WorkspaceState = { artifacts: [] };

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export interface AssistantRequestUserContext {
  id: string;
  name: string | null;
  email: string;
}

export interface AssistantProgressUpdate {
  phase: 'init' | 'routing' | 'agent' | 'merge' | 'documents' | 'approval' | 'saving' | 'done';
  message: string;
}

type ProgressReporter = (update: AssistantProgressUpdate) => Promise<void> | void;
type SchedulingState = NonNullable<NonNullable<ChatMessage['metadata']>['scheduling']>;
type ProjectSetupState = NonNullable<NonNullable<ChatMessage['metadata']>['projectSetup']>;
type ProjectInviteState = NonNullable<NonNullable<ChatMessage['metadata']>['projectInvite']>;

interface ParsedAssistantTodo {
  title: string;
  description: string | null;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  dueAt: string | null;
}

const PROJECT_ACTION_PATTERN =
  /\b(create|draft|write|compose|send|schedule|set up|setup|add|assign|delete|remove|update|change|sync|generate|prepare|make|build|approve|reject|invoice|email|reply|share|save|convert|turn this into)\b/i;
const PROJECT_INFO_PATTERN =
  /^(what|which|who|when|where|why|how|summarize|summary|recap|explain|tell me|show me|list|compare|status|did we|have we|what did|what was|what is)\b/i;

function createMessage(role: ChatMessage['role'], content: string, metadata?: ChatMessage['metadata']): ChatMessage {
  return {
    id: randomUUID(),
    role,
    content,
    createdAt: new Date().toISOString(),
    metadata,
  };
}

function formatRecentConversation(history: ChatMessage[]): string {
  return history
    .filter((entry): entry is ChatMessage & { role: 'user' | 'assistant' } => entry.role === 'user' || entry.role === 'assistant')
    .slice(-4)
    .map((entry) => `${entry.role.toUpperCase()}: ${entry.content}`)
    .join('\n');
}

function buildProjectSearchQuestion(message: string, history: ChatMessage[]): string {
  const trimmed = message.trim();
  if (!trimmed) {
    return trimmed;
  }

  if (!/^(what about|and\b|it\b|that\b|those\b|them\b|this\b|these\b)/i.test(trimmed)) {
    return trimmed;
  }

  const priorUserTurns = history
    .filter((entry) => entry.role === 'user')
    .slice(-2)
    .map((entry) => entry.content.trim())
    .filter(Boolean);

  return priorUserTurns.length > 0 ? `${priorUserTurns.join('\n')}\n${trimmed}` : trimmed;
}

function shouldUseGroundedProjectAnswer(message: string): boolean {
  const trimmed = message.trim();
  if (!trimmed) {
    return false;
  }

  if (PROJECT_ACTION_PATTERN.test(trimmed)) {
    return false;
  }

  return PROJECT_INFO_PATTERN.test(trimmed) || trimmed.includes('?');
}

function cleanSettingsReply(reply: string): string {
  return reply.replace(/\n?\[USER_PROFILE_READY\][\s\S]*$/m, '').trim();
}

function readLatestProjectSetupState(history: ChatMessage[]): ProjectSetupState | null {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const state = history[index]?.metadata?.projectSetup;
    if (state) {
      return state;
    }
  }
  return null;
}

function readLatestProjectInviteState(history: ChatMessage[]): ProjectInviteState | null {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const state = history[index]?.metadata?.projectInvite;
    if (state) {
      return state;
    }
  }
  return null;
}

function questionForProjectField(field: NonNullable<ProjectSetupState['awaitingField']>): string {
  if (field === 'projectName') return 'What is the project name?';
  if (field === 'clientEntity') return 'Who is the client or entity for this project?';
  if (field === 'description') return 'Give me a one or two sentence description of what this project delivers.';
  if (field === 'startDate') return 'What is the project start date?';
  return 'What is the target end date or delivery deadline?';
}

function updateProjectSetupField(
  fields: ProjectSetupState['fields'],
  awaitingField: NonNullable<ProjectSetupState['awaitingField']>,
  message: string
): ProjectSetupState['fields'] {
  const trimmed = message.trim();
  if (!trimmed) {
    return fields;
  }

  if (awaitingField === 'projectName') return { ...fields, projectName: trimmed };
  if (awaitingField === 'clientEntity') return { ...fields, clientEntity: trimmed };
  if (awaitingField === 'description') return { ...fields, description: trimmed };
  if (awaitingField === 'startDate') return { ...fields, startDate: trimmed };
  return { ...fields, targetCompletion: trimmed };
}

async function finalizeProjectCreationFromFields(params: {
  user: AssistantRequestUserContext;
  body: AssistantRequest;
  history: ChatMessage[];
  workspace: WorkspaceState;
  initialProjectId: string | null;
  fields: ProjectSetupState['fields'];
}) {
  const milestones =
    params.fields.milestones && params.fields.milestones.length > 0
      ? params.fields.milestones
      : generateDefaultMilestones(
          params.fields.projectType || null,
          params.fields.startDate || null,
          params.fields.targetCompletion || null
        );
  const teamRoster = params.fields.teamRoster || [];
  const recordText = buildProjectCoordinatorRecordText({
    projectName: params.fields.projectName || 'Untitled Project',
    clientEntity: params.fields.clientEntity || 'Not specified',
    description: params.fields.description || 'Project description to be finalized.',
    projectType: params.fields.projectType || null,
    startDate: params.fields.startDate || null,
    targetCompletion: params.fields.targetCompletion || null,
    engagementValue: params.fields.engagementValue || null,
    projectOwner: params.fields.projectOwner || params.user.name || params.user.email,
    status: params.fields.status || 'Planned',
    milestones,
    teamRoster,
  });

  const syntheticRun: AgentRunResult = {
    id: `run_${randomUUID().slice(0, 8)}`,
    persona: 'PROJECT_COORDINATOR',
    subtask: params.history.at(-1)?.content || recordText,
    context: { project: params.fields.projectName || null },
    depends_on: null,
    output: recordText,
  };
  console.log("FINALIZE PROJECT DEBUG - recordText:", recordText);
  console.log("FINALIZE PROJECT DEBUG - initialProjectId:", params.initialProjectId);
  console.log("FINALIZE PROJECT DEBUG - syntheticRun:", syntheticRun);

  const persistedProject = await persistProjectCoordinatorRun({
    userId: params.user.id,
    userName: params.user.name || params.user.email,
    message: params.history.at(-1)?.content || recordText,
    fallbackProjectId: params.initialProjectId,
    agentRuns: [syntheticRun],
  });
  console.log("FINALIZE PROJECT DEBUG - persistedProject:", persistedProject);

  const teamPrompt =
    teamRoster.length === 0
      ? ' This project has no team members yet. Would you like to invite someone now?'
      : teamRoster.some((member) => member.email.endsWith('@project-member.local'))
        ? ' Some team members still need email addresses before they can be invited.'
        : '';
  const reply = `${recordText}\n\nProject ${persistedProject?.action || 'created'}: ${persistedProject?.projectName || params.fields.projectName}.${teamPrompt}`;
  const effectiveProjectId = persistedProject?.projectId || params.initialProjectId;
  const nextMessages = [
    ...params.history,
    createMessage('assistant', reply, {
      mode: 'assistant',
      surface: params.body.surface,
      projectId: effectiveProjectId,
      projectInvite:
        teamRoster.length === 0 || teamRoster.some((member) => member.email.endsWith('@project-member.local'))
          ? {
              kind: 'team_invite',
              projectId: effectiveProjectId,
              projectName: persistedProject?.projectName || params.fields.projectName || 'Untitled Project',
              awaiting: 'prompt_confirmation',
            }
          : undefined,
    }),
  ];
  const conversation = await saveConversation({
    userId: params.user.id,
    conversationId: params.body.conversationId,
    projectId: effectiveProjectId,
    messages: nextMessages,
  });

  return {
    mode: 'assistant' as const,
    reply,
    workspace: params.workspace,
    conversation,
    conversations: await listConversations(
      params.user.id,
      params.body.surface === 'project_assistant' ? effectiveProjectId : null
),
    pendingApprovals: await listPendingApprovalActions(params.user.id, effectiveProjectId),
    route: null,
    projectId: effectiveProjectId,
  };
}

function parseInvitedTeamMembers(message: string) {
  const lines = message
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  return lines
    .map((line) => line.replace(/^[-*]\s*/, ''))
    .map((line) => {
      const email = line.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || null;
      const stripped = email ? line.replace(email, '').replace(/[()<>]/g, '').trim() : line;
      const parts = stripped.split(/\s+[–-]\s+|\s+\|\s+|:\s+/).map((part) => part.trim()).filter(Boolean);
      if (parts.length < 2 || !email) {
        return null;
      }

      const [name, role, responsibilities] = parts;
      return {
        name,
        email: email.toLowerCase(),
        role,
        responsibilities: responsibilities || null,
        accessLevel: 'Full Access',
      };
    })
    .filter((member): member is NonNullable<typeof member> => Boolean(member));
}

function readLatestSchedulingState(history: ChatMessage[]) {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const scheduling = history[index]?.metadata?.scheduling;
    if (scheduling) {
      return scheduling;
    }
  }
  return null;
}

function readSelectedOption(message: string): number | null {
  const match = message.trim().toLowerCase().match(/\boption\s*(\d+)\b|\b(\d+)\b/);
  if (!match) {
    return null;
  }
  return Number(match[1] || match[2] || 0) || null;
}

function isConfirmationMessage(message: string): boolean {
  return /\b(confirm|confirmed|yes|go ahead|book it|create it|send it|schedule it)\b/i.test(message.trim());
}

function looksLikeOptionSelection(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  return /^option\s*\d+\b/.test(normalized) || /^\d+\b/.test(normalized) || /\boption\s*\d+\b/.test(normalized);
}

function buildSchedulingReplyMetadata(run: AgentRunResult): SchedulingState | null {
  if (run.persona !== 'CALENDAR_AGENT') {
    return null;
  }

  const rawSlots = Array.isArray(run.context.valid_meeting_slots)
    ? run.context.valid_meeting_slots.filter((slot): slot is Record<string, unknown> => Boolean(slot) && typeof slot === 'object')
    : [];

  if (rawSlots.length === 0) {
    return null;
  }

  const options = rawSlots
    .map((slot, index) => {
      const start = typeof slot.start === 'string' ? slot.start : '';
      const end = typeof slot.end === 'string' ? slot.end : '';
      const userDisplayTime = typeof slot.userDisplayTime === 'string' ? slot.userDisplayTime : '';
      const clientDisplayTime = typeof slot.clientDisplayTime === 'string' ? slot.clientDisplayTime : '';
      if (!start || !end || !userDisplayTime || !clientDisplayTime) {
        return null;
      }
      return {
        option: index + 1,
        start,
        end,
        userDisplayTime,
        clientDisplayTime,
      };
    })
    .filter((slot): slot is NonNullable<typeof slot> => Boolean(slot));

  if (options.length === 0) {
    return null;
  }

  const clientName =
    typeof run.context.client_name === 'string' && run.context.client_name.trim()
      ? run.context.client_name.trim()
      : typeof run.context.client === 'string' && run.context.client.trim()
        ? run.context.client.trim()
        : null;
  const clientEmail =
    typeof run.context.client_email === 'string' && run.context.client_email.trim() ? run.context.client_email.trim() : null;
  const clientTimezone =
    typeof run.context.client_timezone === 'string' && run.context.client_timezone.trim()
      ? run.context.client_timezone.trim()
      : null;
  const durationMinutes =
    typeof run.context.duration_minutes === 'number'
      ? run.context.duration_minutes
      : Number(run.context.duration_minutes) || 30;
  const title = clientName ? `Meeting with ${clientName}` : 'Client meeting';
  const description = clientName
    ? `Scheduled ${durationMinutes}-minute meeting with ${clientName}.`
    : `Scheduled ${durationMinutes}-minute client meeting.`;

  return {
    kind: 'availability_options',
    clientName,
    clientEmail,
    clientTimezone,
    title,
    description,
    durationMinutes,
    options,
  };
}

function inferArtifactKind(persona: AgentRunResult['persona']): WorkspaceArtifact['kind'] {
  if (persona === 'PROJECT_COORDINATOR') return 'project_record';
  if (persona === 'TASK_ASSIGNMENT') return 'task_assignment';
  if (persona === 'EMAIL_SENDER' || persona === 'EMAIL_ANALYST') return 'draft_reply';
  if (persona === 'CALENDAR_AGENT') return 'calendar_plan';
  if (persona === 'INVOICE_GENERATOR') return 'invoice';
  if (persona === 'RESEARCH_AGENT') return 'research';
  return 'deliverable';
}

function inferArtifactTitle(run: AgentRunResult): string {
  const project = typeof run.context.project === 'string' ? run.context.project : null;
  const client = typeof run.context.client === 'string' ? run.context.client : null;
  if (project) return `${run.persona.replaceAll('_', ' ')} · ${project}`;
  if (client) return `${run.persona.replaceAll('_', ' ')} · ${client}`;
  return run.persona.replaceAll('_', ' ');
}

function updateWorkspace(workspace: WorkspaceState, runs: AgentRunResult[], approvalActionIds: string[] = []): WorkspaceState {
  const artifacts = [...workspace.artifacts];
  for (const run of runs) {
    artifacts.push({
      id: `artifact_${randomUUID().slice(0, 8)}`,
      kind: inferArtifactKind(run.persona),
      title: inferArtifactTitle(run),
      project: typeof run.context.project === 'string' ? run.context.project : null,
      persona: run.persona,
      content: run.output,
      createdAt: new Date().toISOString(),
      approvalActionId: approvalActionIds[0] || null,
    });
  }

  return {
    artifacts: artifacts.slice(-36),
  };
}

async function getProjectName(projectId: string | null | undefined): Promise<string | null> {
  if (!projectId) return null;
  const project = await db.queryOne<{ name: string | null; title: string | null }>(
    `SELECT name, title FROM projects WHERE id = $1`,
    [projectId]
  );
  return project?.title || project?.name || null;
}

async function queueAttachmentRecords(userId: string, projectId: string | null | undefined, attachments: RoutingDecision['attachments_to_ingest']) {
  if (!projectId || attachments.length === 0) {
    return;
  }

  const storageProvider = normalizeProjectDocumentStorageProvider('local');

  for (const attachment of attachments) {
    const exists = await db.queryOne<{ id: string }>(
      `SELECT id
       FROM project_documents
       WHERE project_id = $1 AND user_id = $2 AND file_name = $3 AND COALESCE(source_email_thread_id, '') = COALESCE($4, '')
       LIMIT 1`,
      [projectId, userId, attachment.name, attachment.thread_id || null]
    );

    if (exists) {
      continue;
    }

    await db.query(
      `INSERT INTO project_documents (id, project_id, user_id, file_name, file_type, file_size, storage_provider, summary, tags, source_email_thread_id, analyzed_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 0, $6, $7, ARRAY['email_ingest'], $8, NOW(), NOW(), NOW())`,
      [
        randomUUID(),
        projectId,
        userId,
        attachment.name,
        attachment.mime_type || 'application/octet-stream',
        storageProvider,
        'Queued from email analysis. Upload or sync the original attachment to complete ingestion.',
        attachment.thread_id || null,
      ]
    );
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readTaskBlockField(block: string, label: string): string | null {
  const match = block.match(new RegExp(`^${escapeRegExp(label)}:\\s*(.+)$`, 'im'));
  return match?.[1]?.trim() || null;
}

function normalizeTodoPriority(value: string | null | undefined): ParsedAssistantTodo['priority'] {
  const normalized = (value || '').trim().toLowerCase();
  if (normalized === 'urgent') return 'urgent';
  if (normalized === 'high') return 'high';
  if (normalized === 'low') return 'low';
  return 'medium';
}

function toIsoOrNull(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  if (!normalized || /^(none|n\/a|tbd)/i.test(normalized)) {
    return null;
  }

  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function parseTaskAssignmentTodos(output: string): ParsedAssistantTodo[] {
  if (!/TASK ASSIGNMENT SUMMARY/i.test(output)) {
    return [];
  }

  const taskMatches = output.match(/TASK #\d+[\s\S]*?(?=\nTASK #\d+|\nSUMMARY\b|$)/gi) || [];
  return taskMatches
    .map((block) => {
      const title = readTaskBlockField(block, 'Task');
      if (!title) {
        return null;
      }

      const context = readTaskBlockField(block, 'Context');
      const dependencies = readTaskBlockField(block, 'Dependencies');
      const notes = readTaskBlockField(block, 'Notes');
      const assignedTo = readTaskBlockField(block, 'Assigned To');
      const description = [context ? `Context: ${context}` : '', dependencies && !/^none$/i.test(dependencies) ? `Dependencies: ${dependencies}` : '', notes && !/^none$/i.test(notes) ? `Notes: ${notes}` : '', assignedTo ? `Assigned to: ${assignedTo}` : '']
        .filter(Boolean)
        .join('\n');

      return {
        title,
        description: description || null,
        priority: normalizeTodoPriority(readTaskBlockField(block, 'Priority')),
        dueAt: toIsoOrNull(readTaskBlockField(block, 'Due')),
      } satisfies ParsedAssistantTodo;
    })
    .filter((task): task is ParsedAssistantTodo => Boolean(task));
}

async function persistTaskAssignmentTodos(params: {
  userId: string;
  projectId: string | null | undefined;
  agentRuns: AgentRunResult[];
}): Promise<number> {
  if (!params.projectId) {
    return 0;
  }

  const extractedTodos = params.agentRuns
    .filter((run) => run.persona === 'TASK_ASSIGNMENT')
    .flatMap((run) => parseTaskAssignmentTodos(run.output));

  if (extractedTodos.length === 0) {
    return 0;
  }

  let inserted = 0;
  for (const todo of extractedTodos) {
    const sourceHash = createHash('sha256')
      .update(`${params.projectId}:${todo.title.toLowerCase()}:${(todo.description || '').toLowerCase()}`)
      .digest('hex');

    const existing = await db.queryOne<{ id: string }>(
      `SELECT id
       FROM todo
       WHERE user_id = $1
         AND project_id = $2
         AND (
           source_hash = $3
           OR (LOWER(title) = LOWER($4) AND status::text NOT IN ('done', 'completed', 'archived'))
         )
       LIMIT 1`,
      [params.userId, params.projectId, sourceHash, todo.title]
    );

    if (existing) {
      continue;
    }

    await db.query(
      `INSERT INTO todo (id, user_id, title, description, status, priority, due_at, source, source_hash, created_at, updated_at, project_id)
       VALUES ($1, $2, $3, $4, 'todo'::todo_status, $5::todo_priority, $6::timestamptz, $7::jsonb, $8, NOW(), NOW(), $9)`,
      [
        randomUUID(),
        params.userId,
        todo.title,
        todo.description,
        todo.priority,
        todo.dueAt,
        JSON.stringify({ source: 'assistant_task_assignment' }),
        sourceHash,
        params.projectId,
      ]
    );
    inserted += 1;
  }

  return inserted;
}

function extractCompanyName(originalMessage: string, agentRuns: AgentRunResult[]): string {
  for (const run of agentRuns) {
    if (typeof run.context.client === 'string' && run.context.client.trim()) {
      return run.context.client.trim();
    }
  }

  const companyFieldMatch = originalMessage.match(/\bCOMPANY\s+([^:\n]+)(?::\s*https?:\/\/[^\s]+)?/i);
  if (companyFieldMatch?.[1]) {
    return companyFieldMatch[1].trim();
  }

  const forMatch = originalMessage.match(/\bproposal\s+for\s+([A-Z][A-Za-z0-9&.,' -]{2,80})/i);
  if (forMatch?.[1]) {
    return forMatch[1].trim();
  }

  return 'Client';
}

function buildProposalReply(openUrl: string, title: string, additionalText: string | null): string {
  const notice = `Proposal PDF generated: **${title}**\n\n[Open proposal PDF](${openUrl})`;
  if (!additionalText) {
    return notice;
  }
  return `${notice}\n\n${additionalText}`;
}

function isSpreadsheetTask(run: AgentRunResult): boolean {
  if (run.persona !== 'DOCUMENT_GENERATOR') {
    return false;
  }

  const fileSubtype = typeof run.context.file_subtype === 'string' ? run.context.file_subtype.toLowerCase() : '';
  const deliverable = typeof run.context.deliverable_type === 'string' ? run.context.deliverable_type.toLowerCase() : '';
  if (fileSubtype === 'excel' || fileSubtype === 'xlsx' || deliverable === 'spreadsheet' || deliverable === 'excel') {
    return true;
  }

  return Boolean(parseSpreadsheetBlueprint(run.output));
}

function buildSpreadsheetReply(openUrl: string, title: string, originalMessage: string): string {
  const isFinancialModel = /\bfinancial model\b|\b3-statement\b/i.test(originalMessage);
  const prefix = isFinancialModel ? 'Financial model XLSX generated' : 'Excel workbook generated';
  const linkLabel = isFinancialModel ? 'Download financial model XLSX' : 'Download Excel workbook';
  return `${prefix}: **${title}**\n\n[${linkLabel}](${openUrl})`;
}

function findRunForActionType(actionType: string, agentRuns: AgentRunResult[]): AgentRunResult | null {
  const preferredPersona =
    actionType === 'email'
      ? 'EMAIL_SENDER'
      : actionType === 'calendar_event'
        ? 'CALENDAR_AGENT'
        : actionType === 'invoice_send'
          ? 'INVOICE_GENERATOR'
          : actionType === 'save_to_drive' || actionType === 'save_to_project_documents'
            ? 'DOCUMENT_GENERATOR'
            : null;

  if (preferredPersona) {
    const match = agentRuns.find((run) => run.persona === preferredPersona);
    if (match) {
      return match;
    }
  }

  return agentRuns[0] || null;
}

function buildApprovalPayloads(params: {
  tasks: RoutingTask[];
  routing: RoutingDecision;
  agentRuns: AgentRunResult[];
  mergedReply: string;
}): Array<{ agent: AgentRunResult['persona']; output: string; actions: RoutingDecision['deferred_actions'] }> {
  if (params.routing.deferred_actions.length > 0) {
    return params.routing.deferred_actions.map((action) => {
      const matchedRun = findRunForActionType(action.action_type, params.agentRuns) || params.agentRuns[0];
      return {
        agent: matchedRun?.persona || params.routing.primary_persona,
        output: matchedRun?.output || params.mergedReply,
        actions: [action],
      };
    });
  }

  const inferred = params.tasks.reduce<Array<{ agent: AgentRunResult['persona']; output: string; actions: RoutingDecision['deferred_actions'] }>>(
    (items, task) => {
      const actionType = inferDeferredActionType(task);
      if (!actionType && !params.routing.requires_approval) {
        return items;
      }
      const matchedRun = params.agentRuns.find((run) => run.persona === task.persona);
      items.push({
        agent: matchedRun?.persona || params.routing.primary_persona,
        output: matchedRun?.output || params.mergedReply,
        actions: [
          {
            action_type: actionType || 'other',
            title: `${task.persona.replaceAll('_', ' ')} approval`,
            payload: { task: task.subtask, context: task.context },
          },
        ],
      });
      return items;
    },
    []
  );

  return inferred.length > 0
    ? inferred
    : [
        {
          agent: params.routing.primary_persona,
          output: params.mergedReply,
          actions: [
            {
              action_type: 'other',
              title: `${params.routing.primary_persona.replaceAll('_', ' ')} approval`,
              payload: { reply: params.mergedReply },
            },
          ],
        },
      ];
}

function formatPersonaLabel(persona: string): string {
  return persona.replaceAll('_', ' ');
}

async function report(progress: ProgressReporter | undefined, phase: AssistantProgressUpdate['phase'], message: string) {
  await progress?.({ phase, message });
}

export async function processAssistantRequest(
  user: AssistantRequestUserContext,
  body: AssistantRequest,
  progress?: ProgressReporter
): Promise<AssistantResponse> {

  await ensureAssistantRuntimeTables();

  const message = body.message?.trim() || "";
  
  if (!message && !body.attachments?.length) {
  throw new Error("message or attachment is required");
}
  await report(progress, 'init', 'Loading conversation and workspace context');

  const workspace = body.workspace ?? EMPTY_WORKSPACE;
  const existingConversation = body.conversationId ? await getConversation(user.id, body.conversationId) : null;
  const history = Array.isArray(body.history) && body.history.length > 0 ? body.history : existingConversation?.messages || [];
  console.log("PROJECT ID RECEIVED:", body.projectId);
  const initialProjectId = body.projectId || existingConversation?.projectId || null;
  const projectName = await getProjectName(initialProjectId);


  
  if (body.mode === 'onboarding') {
    await report(progress, 'agent', 'Running Settings Agent');

    const onboardingHistory = history.filter((entry) => entry.metadata?.mode !== 'assistant');
    const settingsResult = await runSettingsAgentTurn(onboardingHistory, message);

    let profile = null;
    let mode: AssistantResponse['mode'] = 'onboarding';
    let reply = settingsResult.reply;

    if (settingsResult.profileReady && settingsResult.profile) {
      await report(progress, 'saving', 'Saving firm profile');
      const saved = await saveAssistantProfile(user.id, settingsResult.profile);
      profile = saved.profile;
      mode = 'assistant';
      reply = `${cleanSettingsReply(settingsResult.reply)}\n\nYour firm profile has been saved. You can now use the assistant across the workspace.`;
    }

    const nextMessages = [
      ...onboardingHistory,
      createMessage('user', message, { mode: 'onboarding', surface: body.surface, projectId: initialProjectId }),
      createMessage('assistant', reply, { mode, surface: body.surface, projectId: initialProjectId }),
    ];

    await report(progress, 'saving', 'Saving conversation');
    const conversation = await saveConversation({
      userId: user.id,
      conversationId: body.conversationId,
      projectId: initialProjectId,
      messages: nextMessages,
    });

    await report(progress, 'done', 'Ready');
    return {
      mode,
      reply,
      profile,
      workspace,
      conversation,
      conversations: await listConversations(user.id, body.surface === 'project_assistant' ? initialProjectId : null),
      pendingApprovals: [],
      route: null,
    };
  }

  const savedProfile = await getAssistantProfile(user.id);
  if (!savedProfile) {
    throw new Error('Assistant setup is incomplete. Complete the Settings Agent first.');
  }

  const latestProjectInviteState = readLatestProjectInviteState(history);
  if (latestProjectInviteState?.kind === 'team_invite') {
    if (latestProjectInviteState.awaiting === 'prompt_confirmation') {
      if (isConfirmationMessage(message)) {
        const reply = `Share each team member as \`Name - Role - email@example.com\`. You can send multiple lines at once, and I’ll add them to ${latestProjectInviteState.projectName}.`;
        const nextMessages = [
          ...history,
          createMessage('user', message, { mode: 'assistant', surface: body.surface, projectId: latestProjectInviteState.projectId || initialProjectId }),
          createMessage('assistant', reply, {
            mode: 'assistant',
            surface: body.surface,
            projectId: latestProjectInviteState.projectId || initialProjectId,
            projectInvite: {
              ...latestProjectInviteState,
              awaiting: 'member_details',
            },
          }),
        ];
        const conversation = await saveConversation({
          userId: user.id,
          conversationId: body.conversationId,
          projectId: latestProjectInviteState.projectId || initialProjectId,
          messages: nextMessages,
        });

        return {
          mode: 'assistant',
          reply,
          profile: savedProfile.profile,
          workspace,
          conversation,
          conversations: await listConversations(
            user.id,
            body.surface === 'project_assistant'
            ? (latestProjectInviteState.projectId || initialProjectId)
            : null
),
          pendingApprovals: await listPendingApprovalActions(user.id, latestProjectInviteState.projectId || initialProjectId),
          route: null,
        };
      }
    } else if (latestProjectInviteState.awaiting === 'member_details') {
      const members = parseInvitedTeamMembers(message);
      if (members.length === 0) {
        const reply = 'I need each team member in this format: `Name - Role - email@example.com`. Send one or more lines and I will add them.';
        const nextMessages = [
          ...history,
          createMessage('user', message, { mode: 'assistant', surface: body.surface, projectId: latestProjectInviteState.projectId || initialProjectId }),
          createMessage('assistant', reply, {
            mode: 'assistant',
            surface: body.surface,
            projectId: latestProjectInviteState.projectId || initialProjectId,
            projectInvite: latestProjectInviteState,
          }),
        ];
        const conversation = await saveConversation({
          userId: user.id,
          conversationId: body.conversationId,
          projectId: latestProjectInviteState.projectId || initialProjectId,
          messages: nextMessages,
        });

        return {
          mode: 'assistant',
          reply,
          profile: savedProfile.profile,
          workspace,
          conversation,
          conversations: await listConversations(
            user.id,
            body.surface === 'project_assistant'
            ? (latestProjectInviteState.projectId || initialProjectId)
            : null
),

          pendingApprovals: await listPendingApprovalActions(user.id, latestProjectInviteState.projectId || initialProjectId),
          route: null,
        };
      }

      const rosterText = [
        'TEAM ROSTER',
        'Name | Email | Role | Responsibilities | Access',
        ...members.map(
          (member) =>
            `${member.name} | ${member.email} | ${member.role || 'Role not specified'} | ${member.responsibilities || 'To be confirmed'} | ${member.accessLevel || 'Full Access'}`
        ),
      ].join('\n');
      const syntheticRun: AgentRunResult = {
        id: `run_${randomUUID().slice(0, 8)}`,
        persona: 'PROJECT_COORDINATOR',
        subtask: message,
        context: { project: latestProjectInviteState.projectName },
        depends_on: null,
        output: rosterText,
      };
      await persistProjectCoordinatorRun({
        userId: user.id,
        userName: user.name || user.email,
        message: `invite team members to ${latestProjectInviteState.projectName}`,
        fallbackProjectId: latestProjectInviteState.projectId,
        agentRuns: [syntheticRun],
      });

      const confirmations = members
        .map(
          (member) =>
            `Got it — ${member.name} has been added as ${member.role || 'Team Member'} on ${latestProjectInviteState.projectName}. They will be visible to the Task Assignment Agent when generating action items for this project.`
        )
        .join('\n');
      const nextMessages = [
        ...history,
        createMessage('user', message, { mode: 'assistant', surface: body.surface, projectId: latestProjectInviteState.projectId || initialProjectId }),
        createMessage('assistant', confirmations, {
          mode: 'assistant',
          surface: body.surface,
          projectId: latestProjectInviteState.projectId || initialProjectId,
        }),
      ];
      const conversation = await saveConversation({
        userId: user.id,
        conversationId: body.conversationId,
        projectId: latestProjectInviteState.projectId || initialProjectId,
        messages: nextMessages,
      });

      return {
        mode: 'assistant',
        reply: confirmations,
        profile: savedProfile.profile,
        workspace,
        conversation,
        conversations: await listConversations(
          user.id,
          body.surface === 'project_assistant'
          ? (latestProjectInviteState.projectId || initialProjectId)
          : null
),
        pendingApprovals: await listPendingApprovalActions(user.id, latestProjectInviteState.projectId || initialProjectId),
        route: null,
      };
    }
  }

  const latestProjectSetupState = readLatestProjectSetupState(history);
  if (latestProjectSetupState?.kind === 'project_creation') {
    const nextFields = latestProjectSetupState.awaitingField
      ? updateProjectSetupField(latestProjectSetupState.fields, latestProjectSetupState.awaitingField, message)
      : latestProjectSetupState.fields;
    const missingFields = getMissingProjectCreationFields(nextFields, user.name);

    if (missingFields.length > 0) {
      const awaitingField = missingFields[0] || null;
      const reply = awaitingField ? questionForProjectField(awaitingField) : 'I still need a few project details before I can create the record.';
      const nextMessages = [
        ...history,
        createMessage('user', message, { mode: 'assistant', surface: body.surface, projectId: initialProjectId }),
        createMessage('assistant', reply, {
          mode: 'assistant',
          surface: body.surface,
          projectId: initialProjectId,
          projectSetup: {
            kind: 'project_creation',
            fields: nextFields,
            awaitingField,
          },
        }),
      ];

      const conversation = await saveConversation({
        userId: user.id,
        conversationId: body.conversationId,
        projectId: initialProjectId,
        messages: nextMessages,
      });

      return {
        mode: 'assistant',
        reply,
        profile: savedProfile.profile,
        workspace,
        conversation,
        conversations: await listConversations(
           user.id,
           body.surface === 'project_assistant' ? initialProjectId : null  
),
    
        pendingApprovals: await listPendingApprovalActions(user.id, initialProjectId),
        route: null,
      };
    }

    const nextMessages = [
      ...history,
      createMessage('user', message, { mode: 'assistant', surface: body.surface, projectId: initialProjectId }),
    ];
    const finalized = await finalizeProjectCreationFromFields({
      user,
      body,
      history: nextMessages,
      workspace,
      initialProjectId,
      fields: {
        ...nextFields,
        milestones: nextFields.milestones || [],
        teamRoster: nextFields.teamRoster || [],
      },
    });

    return {
      mode: finalized.mode,
      reply: finalized.reply,
      profile: savedProfile.profile,
      workspace,
      conversation: finalized.conversation,
      conversations: finalized.conversations,
      pendingApprovals: finalized.pendingApprovals,
      route: finalized.route,
    };
  }

  if (projectCreateRequested(message)) {
    const parsedRequest = parseProjectRequestFallback(message, user.name || user.email);
    const missingFields = getMissingProjectCreationFields(parsedRequest, user.name);
    if (missingFields.length > 0) {
      const awaitingField = missingFields[0] || null;
      const reply = awaitingField ? questionForProjectField(awaitingField) : 'I need a few required details before I can create the project record.';
      const nextMessages = [
        ...history,
        createMessage('user', message, { mode: 'assistant', surface: body.surface, projectId: initialProjectId }),
        createMessage('assistant', reply, {
          mode: 'assistant',
          surface: body.surface,
          projectId: initialProjectId,
          projectSetup: {
            kind: 'project_creation',
            fields: {
              projectName: parsedRequest.projectName || null,
              clientEntity: parsedRequest.clientEntity || null,
              description: parsedRequest.description || null,
              projectType: parsedRequest.projectType || null,
              startDate: parsedRequest.startDate || null,
              targetCompletion: parsedRequest.targetCompletion || null,
              engagementValue: parsedRequest.engagementValue || null,
              projectOwner: parsedRequest.projectOwner || user.name || user.email,
              status: parsedRequest.status || 'Planned',
              milestones: parsedRequest.milestones || [],
              teamRoster: parsedRequest.teamRoster || [],
            },
            awaitingField,
          },
        }),
      ];
      const conversation = await saveConversation({
        userId: user.id,
        conversationId: body.conversationId,
        projectId: initialProjectId,
        messages: nextMessages,
      });

      return {
        mode: 'assistant',
        reply,
        profile: savedProfile.profile,
        workspace,
        conversation,
        conversations: await listConversations(
          user.id,
          body.surface === 'project_assistant' ? initialProjectId : null
),

        pendingApprovals: await listPendingApprovalActions(user.id, initialProjectId),
        route: null,
      };
    }

    const nextMessages = [
      ...history,
      createMessage('user', message, { mode: 'assistant', surface: body.surface, projectId: initialProjectId }),
    ];
    const finalized = await finalizeProjectCreationFromFields({
      user,
      body,
      history: nextMessages,
      workspace,
      initialProjectId,
      fields: {
        projectName: parsedRequest.projectName || null,
        clientEntity: parsedRequest.clientEntity || null,
        description: parsedRequest.description || null,
        projectType: parsedRequest.projectType || null,
        startDate: parsedRequest.startDate || null,
        targetCompletion: parsedRequest.targetCompletion || null,
        engagementValue: parsedRequest.engagementValue || null,
        projectOwner: parsedRequest.projectOwner || user.name || user.email,
        status: parsedRequest.status || 'Planned',
        milestones: parsedRequest.milestones || [],
        teamRoster: parsedRequest.teamRoster || [],
      },
    });

    return {
      mode: finalized.mode,
      reply: finalized.reply,
      profile: savedProfile.profile,
      workspace,
      conversation: finalized.conversation,
      conversations: finalized.conversations,
      pendingApprovals: finalized.pendingApprovals,
      route: finalized.route,
    };
  }

  const latestSchedulingState = readLatestSchedulingState(history);
  if (latestSchedulingState?.kind === 'availability_options' && looksLikeOptionSelection(message)) {
    const selectedOptionNumber = readSelectedOption(message);
    const selectedOption =
      selectedOptionNumber != null
        ? latestSchedulingState.options?.find((option) => option.option === selectedOptionNumber) || null
        : null;

    if (selectedOption) {
      const clientName = latestSchedulingState.clientName || 'the client';
      const clientEmail = latestSchedulingState.clientEmail || null;
      const confirmationReply = [
        `Option ${selectedOption.option} is ${selectedOption.userDisplayTime} for you and ${selectedOption.clientDisplayTime} for ${clientName}.`,
        clientEmail ? `If you confirm, I’ll create the calendar event and invite ${clientEmail}.` : 'If you confirm, I’ll create the calendar event.',
      ].join(' ');

      const nextMessages = [
        ...history,
        createMessage('user', message, { mode: 'assistant', surface: body.surface, projectId: initialProjectId }),
        createMessage('assistant', confirmationReply, {
          mode: 'assistant',
          surface: body.surface,
          projectId: initialProjectId,
          scheduling: {
            ...latestSchedulingState,
            kind: 'selected_slot_confirmation',
            selectedOption,
          },
        }),
      ];

      await report(progress, 'saving', 'Saving scheduling confirmation');
      const conversation = await saveConversation({
        userId: user.id,
        conversationId: body.conversationId,
        projectId: initialProjectId,
        messages: nextMessages,
      });

      await report(progress, 'done', 'Ready');
      return {
        mode: 'assistant',
        reply: confirmationReply,
        profile: savedProfile.profile,
        workspace,
        conversation,
        conversations: await listConversations(
          user.id,
          body.surface === 'project_assistant' ? initialProjectId : null
),
        pendingApprovals: await listPendingApprovalActions(user.id, initialProjectId),
        route: null,
      };
    }
  }

  if (latestSchedulingState?.kind === 'selected_slot_confirmation' && latestSchedulingState.selectedOption && isConfirmationMessage(message)) {
    const selected = latestSchedulingState.selectedOption;
    const attendees = latestSchedulingState.clientEmail ? [latestSchedulingState.clientEmail] : [];
    const created = await createGoogleCalendarEvent(user.id, {
      title: latestSchedulingState.title || `Meeting with ${latestSchedulingState.clientName || 'client'}`,
      description:
        latestSchedulingState.description ||
        `Scheduled ${latestSchedulingState.durationMinutes || 30}-minute meeting with ${latestSchedulingState.clientName || 'client'}.`,
      start: selected.start,
      end: selected.end,
      attendees,
      videoLink: 'google_meet',
    });

    if (!created) {
      throw new Error('Calendar event creation failed. Confirm a connected calendar is available.');
    }

    const successReply = [
      `Confirmed. I created the event for ${selected.userDisplayTime}.`,
      attendees.length > 0 ? `The invite includes ${attendees.join(', ')} as attendee${attendees.length === 1 ? '' : 's'}.` : '',
    ]
      .filter(Boolean)
      .join(' ');

    const nextMessages = [
      ...history,
      createMessage('user', message, { mode: 'assistant', surface: body.surface, projectId: initialProjectId }),
      createMessage('assistant', successReply, {
        mode: 'assistant',
        surface: body.surface,
        projectId: initialProjectId,
      }),
    ];

    await report(progress, 'saving', 'Saving scheduled event');
    const conversation = await saveConversation({
      userId: user.id,
      conversationId: body.conversationId,
      projectId: initialProjectId,
      messages: nextMessages,
    });

    await report(progress, 'done', 'Ready');
    return {
      mode: 'assistant',
      reply: successReply,
      profile: savedProfile.profile,
      workspace,
      conversation,
      conversations: await listConversations(
        user.id,
        body.surface === 'project_assistant' ? initialProjectId : null
),
      pendingApprovals: await listPendingApprovalActions(user.id, initialProjectId),
      route: null,
    };
  }

  if (body.surface === 'project_assistant' && initialProjectId && shouldUseGroundedProjectAnswer(message)) {
    await report(progress, 'documents', 'Refreshing project memory and retrieving grounded project context');
    const grounded = await answerProjectQuestion({
      projectId: initialProjectId,
      question: buildProjectSearchQuestion(message, history),
      recentConversation: formatRecentConversation(history),
    });

    const nextMessages = [
      ...history,
      createMessage('user', message, { mode: 'assistant', surface: body.surface, projectId: initialProjectId }),
      createMessage('assistant', grounded.reply, {
        mode: 'assistant',
        surface: body.surface,
        projectId: initialProjectId,
      }),
    ];
  

    await report(progress, 'saving', 'Saving grounded project answer');
    const conversation = await saveConversation({
      userId: user.id,
      conversationId: body.conversationId,
      projectId: initialProjectId,
      messages: nextMessages,
    });

    await report(progress, 'done', 'Ready');
    return {
      mode: 'assistant',
      reply: grounded.reply,
      profile: savedProfile.profile,
      workspace,
      conversation,
      conversations: await listConversations(
        user.id,
        body.surface === 'project_assistant' ? initialProjectId : null
),
      pendingApprovals: await listPendingApprovalActions(user.id, initialProjectId),
      route: null,
    };
  }
  await report(progress, 'routing', 'Routing request with ORCHESTRATOR');
  const routing = await routeMessage(message, {
    projectName,
    surface: body.surface,
    hasAttachments: Boolean(body.attachments?.length),
    attachments: body.attachments,
    history,
  });

  await report(
    progress,
    'routing',
    `Routing complete: ${routing.routing.map((task) => formatPersonaLabel(task.persona)).join(' -> ')}`
  );

  const routingWithProject = routing.routing.map((task) => ({
    ...task,
    context: {
      ...task.context,
      project_id: initialProjectId || task.context.project_id || null,
      project: projectName || task.context.project || null,
    },
  }));

  const enrichedTasks = await Promise.all(
    routingWithProject.map((task) =>
      task.persona === 'CALENDAR_AGENT'
        ? enrichCalendarTaskContext({
            userId: user.id,
            profile: savedProfile.profile,
            task,
          })
        : Promise.resolve(task)
    )
  );

  const researchTask = enrichedTasks.find((task) => task.persona === 'RESEARCH_AGENT') || null;
  if (researchTask) {
    await report(progress, 'agent', 'Building retrieval plan with RESEARCH AGENT');
    const researchPlan = await buildResearchRetrievalPlan({
      task: researchTask,
      history,
      profile: savedProfile.profile,
      intros: savedProfile.intros,
      workspace,
    });
    const reply = formatResearchPlanForReply(researchPlan);

    const conversationIdToUse = body.conversationId || existingConversation?.id || randomUUID();
    const messagesForSave = [
      ...history,
      createMessage('user', message, { mode: 'assistant', surface: body.surface, projectId: initialProjectId }),
      createMessage('assistant', reply, { mode: 'assistant', surface: body.surface, projectId: initialProjectId, pendingApprovalIds: [] }),
    ];
    await report(progress, 'saving', 'Saving research plan conversation');
    await saveConversation({
      userId: user.id,
      conversationId: conversationIdToUse,
      projectId: initialProjectId,
      messages: messagesForSave,
    });

    await report(progress, 'approval', 'Queueing retrieval plan for confirmation');
    const pendingApprovals = await createApprovalActions({
      userId: user.id,
      projectId: initialProjectId,
      conversationId: conversationIdToUse,
      agent: 'RESEARCH_AGENT',
      titleBase: projectName ? `Research Retrieval Plan · ${projectName}` : 'Research Retrieval Plan',
      output: reply,
      actions: [
        {
          action_type: 'other',
          title: projectName ? `Confirm research fetch · ${projectName}` : 'Confirm research fetch',
          payload: {
            workflow: 'research_fetch',
            research_plan: researchPlan,
            original_request: message,
            context: researchTask.context,
          },
        },
      ],
    });
    const approvalIds = pendingApprovals.map((item) => item.id);

    const nextMessages = [
      ...history,
      createMessage('user', message, { mode: 'assistant', surface: body.surface, projectId: initialProjectId }),
      createMessage('assistant', reply, {
        mode: 'assistant',
        surface: body.surface,
        projectId: initialProjectId,
        pendingApprovalIds: approvalIds,
      }),
    ];
    const conversation = await saveConversation({
      userId: user.id,
      conversationId: conversationIdToUse,
      projectId: initialProjectId,
      messages: nextMessages,
    });

    await report(progress, 'done', 'Waiting for research confirmation');
    return {
      mode: 'assistant',
      reply,
      profile: savedProfile.profile,
      workspace,
      conversation,
      conversations: await listConversations(user.id, body.surface === 'project_assistant' ? initialProjectId : null),
      pendingApprovals: await listPendingApprovalActions(user.id, body.surface === 'project_assistant' ? initialProjectId : null),
      route: routing,
    };
  }

  const agentRuns = await executeRoutingPlan(enrichedTasks, history, savedProfile.profile, savedProfile.intros, workspace, async (update) => {
    await report(progress, 'agent', update.message);
  });
  console.log("PROJECT SAVE DEBUG - message:", message);
  console.log("PROJECT SAVE DEBUG - initialProjectId:", initialProjectId);
  console.log("PROJECT SAVE DEBUG - agentRuns:", agentRuns);
  const persistedProject = await persistProjectCoordinatorRun({
    userId: user.id,
    userName: user.name || user.email,
    message,
    fallbackProjectId: initialProjectId,
    agentRuns,
  });
  console.log("PROJECT SAVE DEBUG - persistedProject:", persistedProject);
  const effectiveProjectId = persistedProject?.projectId || initialProjectId;
  const effectiveProjectName = persistedProject?.projectName || (effectiveProjectId ? await getProjectName(effectiveProjectId) : projectName);
  const responseProjectScope = body.surface === 'project_assistant' ? effectiveProjectId : null;

  await report(progress, 'merge', 'Assembling final response');
  const mergedReply = await mergeAgentOutputs(message, agentRuns, routing.merge_instruction);
  await queueAttachmentRecords(user.id, effectiveProjectId, routing.attachments_to_ingest);
  const createdTodos = await persistTaskAssignmentTodos({
    userId: user.id,
    projectId: effectiveProjectId,
    agentRuns,
  });

  let reply = mergedReply;
  const proposalRun = agentRuns.find((run) => isProposalTask(run.context, run.persona, run.subtask));
  if (proposalRun) {
    const companyName = extractCompanyName(message, agentRuns);
    await report(progress, 'documents', 'Preparing proposal document');
    const proposal = await createProposalPdf(
      {
        userId: user.id,
        preparedByName: user.name || user.email,
        preparedByEmail: user.email,
        firmProfile: savedProfile.profile,
        originalPrompt: message,
        proposalDraft: proposalRun.output,
        companyName,
      },
      async (proposalMessage) => {
        await report(progress, 'documents', proposalMessage);
      }
    );
    const additionalText = agentRuns.length > 1 ? mergedReply : null;
    reply = buildProposalReply(proposal.openUrl, proposal.title, additionalText);
  } else {
    const spreadsheetRun = agentRuns.find((run) => isSpreadsheetTask(run));
    if (spreadsheetRun) {
      await report(progress, 'documents', 'Preparing Excel workbook');
      const workbook = await createSpreadsheetArtifact({
        userId: user.id,
        projectId: effectiveProjectId,
        originalPrompt: message,
        documentOutput: spreadsheetRun.output,
      });
      reply = buildSpreadsheetReply(workbook.openUrl, workbook.title, message);
    }
  }

  if (persistedProject) {
    reply = `${reply}\n\nProject ${persistedProject.action}: [Open ${persistedProject.projectName}](/projects/${persistedProject.projectId})`;
  }

  if (createdTodos > 0) {
    reply = `${reply}\n\nProject To-Dos updated: ${createdTodos} task${createdTodos === 1 ? '' : 's'} added.`;
  }

  const schedulingMetadata =
    agentRuns
      .map((run) => buildSchedulingReplyMetadata(run))
      .find((value): value is NonNullable<typeof value> => Boolean(value)) || undefined;

  let approvalPayloads =
    routing.requires_approval || routing.deferred_actions.length > 0
      ? buildApprovalPayloads({
          tasks: enrichedTasks,
          routing,
          agentRuns,
          mergedReply: reply,
        })
      : [];

  approvalPayloads = approvalPayloads.filter(
    (payload) => !payload.actions.some((action) => action.action_type === 'calendar_event')
  );

  if (approvalPayloads.length > 0) {
    await report(progress, 'approval', `Creating ${approvalPayloads.length} approval item${approvalPayloads.length === 1 ? '' : 's'}`);
  }

  const pendingApprovals = approvalPayloads.length > 0
    ? (
        await Promise.all(
          approvalPayloads.map((payload) =>
            createApprovalActions({
              userId: user.id,
              projectId: effectiveProjectId,
              conversationId: body.conversationId || existingConversation?.id || null,
              agent: payload.agent,
              titleBase: effectiveProjectName ? `${payload.agent.replaceAll('_', ' ')} · ${effectiveProjectName}` : payload.agent.replaceAll('_', ' '),
              output: payload.output,
              actions: payload.actions,
            })
          )
        )
      ).flat()
    : [];

  const approvalIds = pendingApprovals.map((item) => item.id);
  const nextWorkspace = updateWorkspace(workspace, agentRuns, approvalIds);

  const nextMessages = [
    ...history,
    createMessage('user', message, { mode: 'assistant', surface: body.surface, projectId: effectiveProjectId }),
    createMessage('assistant', reply, {
      mode: 'assistant',
      surface: body.surface,
      projectId: effectiveProjectId,
      pendingApprovalIds: approvalIds,
      scheduling: schedulingMetadata,
    }),
  ];

  await report(progress, 'saving', 'Saving conversation and workspace state');
  console.log("SAVING CONVERSATION", {
  projectId: effectiveProjectId,
  conversationId: body.conversationId,
  message: message
});
  const conversation = await saveConversation({
    userId: user.id,
    conversationId: body.conversationId,
    projectId: effectiveProjectId,
    messages: nextMessages,
  });

  await report(progress, 'done', 'Ready');
  return {
    mode: 'assistant',
    reply,
    profile: savedProfile.profile,
    workspace: nextWorkspace,
    conversation,
    conversations: await listConversations(
    user.id,
    body.surface === 'project_assistant' ? effectiveProjectId : null
  ),
    pendingApprovals: await listPendingApprovalActions(user.id, responseProjectScope),
    route: routing,
  };
}
