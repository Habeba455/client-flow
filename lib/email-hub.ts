import { createHash, randomUUID } from 'node:crypto';
import { buildAgentPrompt } from '@/lib/ai/master-prompts';
import { generateJson } from '@/lib/ai/provider';
import { getAnthropicSpecModel } from '@/lib/ai/spec-models';
import type { ApprovalAction, RoutingTask } from '@/lib/ai/types';
import { getAssistantProfile } from '@/lib/assistant-profile';
import { createApprovalActions } from '@/lib/assistant/approvals';
import { extractTextFromBuffer, inferDocumentType, insertProjectDocumentRecord, summarizeProjectDocument } from '@/lib/assistant/document-ingestion';
import { ensureAssistantRuntimeTables } from '@/lib/assistant/schema';
import { buildProjectContextWithinBudget } from '@/lib/assistant/project-memory';
import { suggestMeetingSlots, type MeetingSlotComputationResult, type SuggestedMeetingSlot } from '@/lib/calendar/scheduling';
import { db } from '@/lib/db';
import { getClient } from '@/lib/product-data';
import { fetchGoogleCalendarEvents } from '@/lib/google/calendar';
import {
  downloadGmailAttachment,
  fetchGmailThread,
  type GmailThreadDetail,
} from '@/lib/google/gmail';

export interface EmailAnalysisTodo {
  task: string;
  owner: 'me' | 'sender' | 'both';
  priority: 'HIGH' | 'MEDIUM' | 'LOW';
  deadline: string | null;
  source_quote: string;
}

export interface EmailAnalysisAttachment {
  filename: string;
  type: string;
  ingest_to_documents: boolean;
  relevance: string;
}

export interface EmailAnalysisResult {
  summary: string;
  todos: EmailAnalysisTodo[];
  meeting_requested: boolean;
  meeting_details: {
    requested_by: string;
    purpose: string;
    duration_requested: string;
    urgency: string;
    proposed_times: string[];
  } | null;
  sentiment: 'positive' | 'neutral' | 'needs_attention' | 'urgent';
  sender: {
    name: string;
    email: string;
    company: string | null;
  };
  reply_needed: boolean;
  reply_urgency: string;
  attachments_detected: EmailAnalysisAttachment[];
}

export interface EmailReplyDraft {
  to: string;
  to_name: string;
  subject: string;
  body: string;
  attachment_instruction: string;
  attachment_filename: string | null;
  suggested_send_time: string | null;
  tone_used: string;
  reply_to_message_id?: string | null;
  thread_id?: string | null;
  approval?: ApprovalAction | null;
}

export interface EmailHubAnalysisResponse {
  thread: GmailThreadDetail;
  project: { id: string; name: string; description: string | null } | null;
  analysis: EmailAnalysisResult;
  meetingInviteSent: boolean;
  meetingCalendarEventId: string | null;
  suggestedSlots: SuggestedMeetingSlot[];
  availability: {
    noOverlap: boolean;
    message: string | null;
    nearestOption: string | null;
    skippedReasons: string[];
  };
  persistedTodos: number;
  ingestedAttachments: number;
}

interface ProjectCandidate {
  id: string;
  name: string | null;
  title: string | null;
  description: string | null;
  status: string | null;
  linked_contacts: string[] | null;
  metadata: Record<string, unknown> | null;
}

interface LinkedProject {
  id: string;
  name: string;
  description: string | null;
  timezone: string | null;
}

interface CachedEmailAnalysisRow {
  thread_id: string;
  thread_subject: string;
  project_id: string | null;
  project_name: string | null;
  project_description: string | null;
  thread_payload: unknown;
  analysis: unknown;
  meeting_invitation_sent: boolean | null;
  meeting_calendar_event_id: string | null;
  last_message_at: string | null;
}

function extractEmails(value: string): string[] {
  return (value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []).map((item) => item.toLowerCase());
}

function scanObjectForEmails(value: unknown, emails: Set<string>) {
  if (typeof value === 'string') {
    extractEmails(value).forEach((email) => emails.add(email));
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => scanObjectForEmails(item, emails));
    return;
  }
  if (value && typeof value === 'object') {
    Object.values(value).forEach((item) => scanObjectForEmails(item, emails));
  }
}

function scanObjectForTimezone(value: unknown): string | null {
  if (typeof value === 'string' && /^[A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?$/.test(value.trim())) {
    return value.trim();
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = scanObjectForTimezone(item);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) {
      const found = scanObjectForTimezone(entry);
      if (found) return found;
    }
  }
  return null;
}

function buildThreadText(thread: GmailThreadDetail): string {
  return thread.messages
    .map((message) =>
      [
        `From: ${message.from}`,
        `To: ${message.to || 'Unknown recipient'}`,
        message.cc ? `Cc: ${message.cc}` : '',
        `Date: ${message.receivedAt || 'Unknown time'}`,
        `Subject: ${message.subject}`,
        message.attachments.length > 0 ? `Attachments: ${message.attachments.map((item) => item.filename).join(', ')}` : '',
        '',
        message.body || '(No body content available)',
      ]
        .filter(Boolean)
        .join('\n')
    )
    .join('\n\n---\n\n');
}

function inferAttachmentType(filename: string, mimeType: string): string {
  const lower = filename.toLowerCase();
  if (mimeType.includes('pdf') || lower.endsWith('.pdf')) return 'pdf';
  if (mimeType.includes('word') || lower.endsWith('.docx')) return 'docx';
  if (mimeType.includes('sheet') || lower.endsWith('.xlsx') || lower.endsWith('.csv')) return 'xlsx';
  if (mimeType.includes('presentation') || lower.endsWith('.pptx')) return 'pptx';
  if (mimeType.startsWith('image/')) return 'image';
  return 'other';
}

function mapThreadAttachments(thread: GmailThreadDetail): EmailAnalysisAttachment[] {
  return thread.attachments.map((attachment) => ({
    filename: attachment.filename,
    type: inferAttachmentType(attachment.filename, attachment.mimeType),
    ingest_to_documents: true,
    relevance: 'Attached to the live project thread and should be available in project documents.',
  }));
}

async function findRelatedProject(userId: string, thread: GmailThreadDetail): Promise<LinkedProject | null> {
  const projects = await db.query<ProjectCandidate>(
    `SELECT id, name, title, description, status, linked_contacts, metadata
     FROM projects
     WHERE user_id = $1 AND COALESCE(status, 'active') <> 'archived'
     ORDER BY updated_at DESC NULLS LAST, created_at DESC`,
    [userId]
  );

  const participantEmails = new Set(thread.participants.flatMap((value) => extractEmails(value)));
  let best: { score: number; project: ProjectCandidate } | null = null;

  for (const project of projects) {
    const projectEmails = new Set<string>();
    scanObjectForEmails(project.linked_contacts || [], projectEmails);
    scanObjectForEmails(project.metadata, projectEmails);
    const matches = [...participantEmails].filter((email) => projectEmails.has(email)).length;
    if (matches === 0) continue;
    if (!best || matches > best.score) {
      best = { score: matches, project };
    }
  }

  if (!best) {
    return null;
  }

  let timezone = scanObjectForTimezone(best.project.metadata);
  if (!timezone && best.project.metadata && typeof (best.project.metadata as Record<string, unknown>).clientId === 'string') {
    const clientId = (best.project.metadata as Record<string, unknown>).clientId as string;
    const client = await getClient(userId, clientId);
    timezone = client?.timezone || null;
  }

  return {
    id: best.project.id,
    name: best.project.title || best.project.name || 'Untitled Project',
    description: best.project.description,
    timezone,
  };
}

async function getProjectById(userId: string, projectId: string): Promise<LinkedProject | null> {
  const project = await db.queryOne<ProjectCandidate>(
    `SELECT id, name, title, description, status, linked_contacts, metadata
     FROM projects
     WHERE user_id = $1 AND id = $2`,
    [userId, projectId]
  );

  if (!project) {
    return null;
  }

  let timezone = scanObjectForTimezone(project.metadata);
  if (!timezone && project.metadata && typeof (project.metadata as Record<string, unknown>).clientId === 'string') {
    const clientId = (project.metadata as Record<string, unknown>).clientId as string;
    const client = await getClient(userId, clientId);
    timezone = client?.timezone || null;
  }

  return {
    id: project.id,
    name: project.title || project.name || 'Untitled Project',
    description: project.description,
    timezone,
  };
}

function normalizeDeadline(value: string | null): string | null {
  if (!value || !value.trim()) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function normalizeTimestamp(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  const time = parsed.getTime();
  return Number.isNaN(time) ? null : time;
}

function isEmailAnalysisResult(value: unknown): value is EmailAnalysisResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate.summary === 'string' && Array.isArray(candidate.todos) && typeof candidate.meeting_requested === 'boolean';
}

function isGmailThreadDetail(value: unknown): value is GmailThreadDetail {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === 'string' && typeof candidate.subject === 'string' && Array.isArray(candidate.messages);
}

async function getCachedEmailAnalysis(params: {
  userId: string;
  threadId: string;
  lastMessageAt?: string | null;
}): Promise<Pick<EmailHubAnalysisResponse, 'project' | 'analysis' | 'thread' | 'meetingInviteSent' | 'meetingCalendarEventId'> | null> {
  const row = await db.queryOne<CachedEmailAnalysisRow>(
    `SELECT thread_id, thread_subject, project_id, project_name, project_description, thread_payload, analysis, meeting_invitation_sent, meeting_calendar_event_id, last_message_at
     FROM email_thread_analysis_cache
     WHERE user_id = $1 AND thread_id = $2
     LIMIT 1`,
    [params.userId, params.threadId]
  );

  if (!row || !isEmailAnalysisResult(row.analysis) || !isGmailThreadDetail(row.thread_payload)) {
    return null;
  }

  const currentLastMessageAt = params.lastMessageAt || null;
  const cachedLastMessageAt = row.last_message_at || null;
  const currentTimestamp = normalizeTimestamp(currentLastMessageAt);
  const cachedTimestamp = normalizeTimestamp(cachedLastMessageAt);
  if (currentTimestamp != null && cachedTimestamp != null && currentTimestamp !== cachedTimestamp) {
    return null;
  }

  return {
    thread: row.thread_payload,
    project: row.project_id
      ? {
          id: row.project_id,
          name: row.project_name || 'Untitled Project',
          description: row.project_description || null,
        }
      : null,
    analysis: row.analysis,
    meetingInviteSent: row.meeting_invitation_sent === true,
    meetingCalendarEventId: row.meeting_calendar_event_id || null,
  };
}

async function persistCachedEmailAnalysis(params: {
  userId: string;
  thread: GmailThreadDetail;
  project: LinkedProject | null;
  analysis: EmailAnalysisResult;
}) {
  const lastMessageAt = params.thread.messages[params.thread.messages.length - 1]?.receivedAt || null;
  await db.query(
    `INSERT INTO email_thread_analysis_cache (
       id, user_id, thread_id, thread_subject, project_id, project_name, project_description, thread_payload, analysis, last_message_at, analyzed_at, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, NOW(), NOW())
     ON CONFLICT (user_id, thread_id) DO UPDATE SET
       thread_subject = EXCLUDED.thread_subject,
       project_id = EXCLUDED.project_id,
       project_name = EXCLUDED.project_name,
       project_description = EXCLUDED.project_description,
       thread_payload = EXCLUDED.thread_payload,
       analysis = EXCLUDED.analysis,
       last_message_at = EXCLUDED.last_message_at,
       analyzed_at = NOW(),
       updated_at = NOW()`,
    [
      randomUUID(),
      params.userId,
      params.thread.id,
      params.thread.subject,
      params.project?.id || null,
      params.project?.name || null,
      params.project?.description || null,
      JSON.stringify(params.thread),
      JSON.stringify(params.analysis),
      lastMessageAt,
    ]
  );
}

export async function persistTodos(params: {
  userId: string;
  projectId: string | null;
  threadId: string;
  todos: EmailAnalysisTodo[];
}) {
  let count = 0;
  for (const todo of params.todos) {
    const sourceHash = createHash('sha256').update(`${params.threadId}:${todo.task}:${todo.source_quote}`).digest('hex');
    const existing = await db.queryOne<{ id: string }>(
      `SELECT id FROM todo WHERE user_id = $1 AND source_hash = $2 LIMIT 1`,
      [params.userId, sourceHash]
    );
    if (existing) {
      continue;
    }

    await db.query(
      `INSERT INTO todo (id, user_id, title, description, status, priority, due_at, source, source_hash, related_email_id, created_at, updated_at, project_id)
       VALUES ($1, $2, $3, $4, 'todo'::todo_status, $5::todo_priority, $6::timestamptz, $7::jsonb, $8, $9, NOW(), NOW(), $10)`,
      [
        randomUUID(),
        params.userId,
        todo.task,
        todo.source_quote,
        todo.priority.toLowerCase(),
        normalizeDeadline(todo.deadline),
        JSON.stringify({ source: 'email_analyst', owner: todo.owner, source_quote: todo.source_quote }),
        sourceHash,
        params.threadId,
        params.projectId,
      ]
    );
    count += 1;
  }
  return count;
}

export async function markMeetingInvitationSent(params: {
  userId: string;
  threadId: string;
  calendarEventId: string;
}) {
  await ensureAssistantRuntimeTables();
  await db.query(
    `UPDATE email_thread_analysis_cache
     SET meeting_invitation_sent = TRUE,
         meeting_calendar_event_id = $3,
         updated_at = NOW()
     WHERE user_id = $1 AND thread_id = $2`,
    [params.userId, params.threadId, params.calendarEventId]
  );
}

export async function persistEmailSummary(params: {
  projectId: string | null;
  thread: GmailThreadDetail;
  analysis: EmailAnalysisResult;
}) {
  if (!params.projectId) {
    return;
  }

  const lastMessageAt = params.thread.messages[params.thread.messages.length - 1]?.receivedAt || null;
  await db.query(
    `INSERT INTO project_email_summaries (id, project_id, thread_id, thread_subject, participants, summary, reply_needed, reply_urgency, last_message_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
     ON CONFLICT (project_id, thread_id) DO UPDATE SET
       thread_subject = EXCLUDED.thread_subject,
       participants = EXCLUDED.participants,
       summary = EXCLUDED.summary,
       reply_needed = EXCLUDED.reply_needed,
       reply_urgency = EXCLUDED.reply_urgency,
       last_message_at = EXCLUDED.last_message_at,
       updated_at = NOW()`,
    [
      randomUUID(),
      params.projectId,
      params.thread.id,
      params.thread.subject,
      params.thread.participants.join(' | '),
      params.analysis.summary,
      params.analysis.reply_needed,
      params.analysis.reply_urgency,
      lastMessageAt,
    ]
  );
}

export async function ingestAttachments(params: {
  userId: string;
  project: LinkedProject | null;
  threadId: string;
  thread: GmailThreadDetail;
  analysis: EmailAnalysisResult;
}) {
  if (!params.project?.id) {
    return 0;
  }

  let ingested = 0;
  for (const detected of params.analysis.attachments_detected.filter((item) => item.ingest_to_documents)) {
    const attachment = params.thread.attachments.find((item) => item.filename === detected.filename);
    if (!attachment) {
      continue;
    }

    const buffer = await downloadGmailAttachment({
      userId: params.userId,
      messageId: attachment.messageId,
      attachmentId: attachment.attachmentId,
      inlineData: attachment.inlineData,
    });
    if (!buffer) {
      continue;
    }

    const extractedText = await extractTextFromBuffer(attachment.filename, attachment.mimeType, buffer);
    const summary = await summarizeProjectDocument({
      fileName: attachment.filename,
      projectName: params.project.name,
      projectDescription: params.project.description,
      extractedText,
      fallbackSummary: detected.relevance,
    });

    const inserted = await insertProjectDocumentRecord({
      projectId: params.project.id,
      userId: params.userId,
      fileName: attachment.filename,
      mimeType: attachment.mimeType,
      fileSize: buffer.byteLength,
      driveFileId: null,
      driveUrl: null,
      storageProvider: 'local',
      summary,
      fullText: extractedText,
      documentType: inferDocumentType(attachment.filename, attachment.mimeType) || detected.type,
      tags: ['email_ingest', params.threadId],
      sourceEmailThreadId: params.threadId,
    });

    if (inserted) {
      ingested += 1;
    }
  }
  return ingested;
}

function parseDurationMinutes(value: string | null | undefined): number {
  if (!value) return 30;
  const normalized = value.toLowerCase();
  const hourMatch = normalized.match(/(\d+)\s*hour/);
  if (hourMatch) return Number(hourMatch[1]) * 60;
  const minuteMatch = normalized.match(/(\d+)\s*min/);
  if (minuteMatch) return Number(minuteMatch[1]);
  return 30;
}

function buildAnalysisUserMessage(projectContext: string, threadText: string): string {
  return [
    'Analyse this email thread and return a JSON object with exactly this structure.',
    '',
    'PROJECT CONTEXT (if available):',
    projectContext || 'None',
    '',
    'EMAIL THREAD:',
    threadText,
  ].join('\n');
}

function buildReplyInstruction(params: {
  analysis: EmailAnalysisResult;
  availability: MeetingSlotComputationResult;
  thread: GmailThreadDetail;
}) {
  if (params.analysis.meeting_requested && params.availability.slots.length > 0) {
    return [
      `Reply to ${params.analysis.sender.name} and offer concrete meeting options.`,
      `Use these valid slots: ${params.availability.slots
        .map((slot) => `${slot.userDisplayTime} (client: ${slot.clientDisplayTime})`)
        .join('; ')}.`,
      `Acknowledge the purpose as: ${params.analysis.meeting_details?.purpose || 'follow-up discussion'}.`,
      'Keep the email brief and direct.',
    ].join(' ');
  }

  if (params.analysis.meeting_requested && params.availability.noOverlap) {
    return [
      `Reply to ${params.analysis.sender.name} and explain that no mutual availability exists within working hours right now.`,
      params.availability.message || 'No mutual availability found.',
      params.availability.nearestOption ? `Nearest option to mention: ${params.availability.nearestOption}.` : '',
      'Invite them to suggest an exception slot if needed.',
    ]
      .filter(Boolean)
      .join(' ');
  }

  return [
    `Reply to the latest message in thread "${params.thread.subject}".`,
    params.analysis.reply_needed ? `Address the required response: ${params.analysis.summary}` : 'Acknowledge the thread professionally.',
    'Keep the email concise and professional.',
  ].join(' ');
}

async function runEmailAnalysis(params: {
  userId: string;
  thread: GmailThreadDetail;
  project: LinkedProject | null;
}) {
  const savedProfile = await getAssistantProfile(params.userId);
  if (!savedProfile) {
    throw new Error('Assistant setup is incomplete.');
  }

  const projectContext = params.project ? await buildProjectContextWithinBudget(params.project.id, params.thread.subject, 40_000) : '';
  const threadText = buildThreadText(params.thread);
  const system = [projectContext, buildAgentPrompt('EMAIL_ANALYST', null, savedProfile.intros)].filter(Boolean).join('\n\n');

  const analysis = await generateJson<EmailAnalysisResult>({
    system,
    messages: [
      {
        role: 'user',
        content: buildAnalysisUserMessage(projectContext, threadText),
      },
    ],
    maxTokens: 1500,
    temperature: 0.3,
    preferredProvider: 'anthropic',
    model: getAnthropicSpecModel('sonnet'),
  });

  return {
    ...analysis,
    attachments_detected:
      Array.isArray(analysis.attachments_detected) && analysis.attachments_detected.length > 0
        ? analysis.attachments_detected
        : mapThreadAttachments(params.thread),
  } satisfies EmailAnalysisResult;
}

export async function analyzeEmailThread(
  userId: string,
  threadId: string,
  options?: { projectId?: string | null; lastMessageAt?: string | null }
): Promise<EmailHubAnalysisResponse> {
  await ensureAssistantRuntimeTables();
  const savedProfile = await getAssistantProfile(userId);
  if (!savedProfile) {
    throw new Error('Assistant setup is incomplete.');
  }

  const cached = await getCachedEmailAnalysis({
    userId,
    threadId,
    lastMessageAt: options?.lastMessageAt || null,
  });
  const thread = cached?.thread || (await fetchGmailThread(userId, threadId));
  if (!thread) {
    throw new Error('Email thread not found.');
  }

  const project = cached?.project?.id
    ? await getProjectById(userId, cached.project.id)
    : cached?.project
      ? { ...cached.project, timezone: null }
      : options?.projectId
        ? await getProjectById(userId, options.projectId)
        : await findRelatedProject(userId, thread);
  const analysis =
    cached?.analysis ||
    (await runEmailAnalysis({
      userId,
      thread,
      project,
    }));

  const durationMinutes = parseDurationMinutes(analysis.meeting_details?.duration_requested);
  const availability =
    analysis.meeting_requested
      ? suggestMeetingSlots(
          {
            userTimezone: savedProfile.profile.user_timezone || 'UTC',
            workingHoursStart: savedProfile.profile.working_hours_start || '09:00',
            workingHoursEnd: savedProfile.profile.working_hours_end || '17:00',
            clientTimezone: project?.timezone || null,
            durationMinutes,
          },
          await fetchGoogleCalendarEvents(userId, {
            timeMin: new Date().toISOString(),
            timeMax: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
            maxResults: 100,
          })
        )
      : { slots: [], noOverlap: false, message: null, nearestOption: null, skippedReasons: [] };

  if (!cached) {
    await persistCachedEmailAnalysis({
      userId,
      thread,
      project,
      analysis,
    });
    await persistEmailSummary({
      projectId: project?.id || null,
      thread,
      analysis,
    });
  }
  const persistedTodos = cached
    ? 0
    : await persistTodos({
        userId,
        projectId: project?.id || null,
        threadId,
        todos: analysis.todos || [],
      });
  const ingestedAttachments = cached
    ? 0
    : await ingestAttachments({
        userId,
        project,
        threadId,
        thread,
        analysis,
      });

  return {
    thread,
    project: project ? { id: project.id, name: project.name, description: project.description } : null,
    analysis,
    meetingInviteSent: cached?.meetingInviteSent === true,
    meetingCalendarEventId: cached?.meetingCalendarEventId || null,
    suggestedSlots: availability.slots,
    availability: {
      noOverlap: availability.noOverlap,
      message: availability.message,
      nearestOption: availability.nearestOption,
      skippedReasons: availability.skippedReasons,
    },
    persistedTodos,
    ingestedAttachments,
  };
}

export async function draftReplyForThread(params: { userId: string; threadId: string }): Promise<EmailReplyDraft> {
  const savedProfile = await getAssistantProfile(params.userId);
  if (!savedProfile) {
    throw new Error('Assistant setup is incomplete.');
  }

  const analysisResult = await analyzeEmailThread(params.userId, params.threadId);
  const latestMessage = analysisResult.thread.messages[analysisResult.thread.messages.length - 1];
  if (!latestMessage) {
    throw new Error('Email thread is empty.');
  }

  const task: RoutingTask = {
    persona: 'EMAIL_SENDER',
    subtask: 'Draft a reply to the selected email thread.',
    context: {
      deliverable_type: 'email',
      project: analysisResult.project?.name || null,
      project_id: analysisResult.project?.id || null,
    },
    depends_on: null,
  };

  const prompt = buildAgentPrompt('EMAIL_SENDER', task, savedProfile.intros);
  const projectContext = analysisResult.project ? await buildProjectContextWithinBudget(analysisResult.project.id, analysisResult.thread.subject, 40_000) : '';
  const recipientEmail = extractEmails(latestMessage.from)[0] || analysisResult.analysis.sender.email || '';
  const recipientName = analysisResult.analysis.sender.name || latestMessage.from;
  const draft = await generateJson<Omit<EmailReplyDraft, 'approval'>>({
    system: [projectContext, prompt].filter(Boolean).join('\n\n'),
    messages: [
      {
        role: 'user',
        content: [
          'Compose an email for this request:',
          buildReplyInstruction({
            analysis: analysisResult.analysis,
            availability: {
              slots: analysisResult.suggestedSlots,
              noOverlap: analysisResult.availability.noOverlap,
              message: analysisResult.availability.message,
              nearestOption: analysisResult.availability.nearestOption,
              skippedReasons: analysisResult.availability.skippedReasons,
            },
            thread: analysisResult.thread,
          }),
          '',
          `Recipient: ${recipientName} <${recipientEmail || '[PLACEHOLDER: recipient email]'}>`,
          `Project context: ${analysisResult.project?.name || 'No linked project'} — ${analysisResult.project?.description || 'No project description available.'}`,
          'Attachment (if any): null — null',
        ].join('\n'),
      },
    ],
    maxTokens: 600,
    temperature: 0.4,
    preferredProvider: 'anthropic',
    model: getAnthropicSpecModel('sonnet'),
  });

  const [approval] = await createApprovalActions({
    userId: params.userId,
    projectId: analysisResult.project?.id || null,
    agent: 'EMAIL_SENDER',
    titleBase: `Draft reply · ${analysisResult.thread.subject}`,
    output: draft.body,
    actions: [
      {
        action_type: 'email',
        title: `Send reply · ${analysisResult.thread.subject}`,
        recipient_email: draft.to || recipientEmail,
        recipient_name: draft.to_name || recipientName,
        payload: {
          ...draft,
          reply_to_message_id: draft.reply_to_message_id || latestMessage.id,
          thread_id: draft.thread_id || analysisResult.thread.id,
        },
      },
    ],
  });

  return {
    ...draft,
    reply_to_message_id: draft.reply_to_message_id || latestMessage.id,
    thread_id: draft.thread_id || analysisResult.thread.id,
    approval: approval || null,
  };
}
