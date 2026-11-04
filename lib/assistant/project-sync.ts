import { createHash, randomUUID } from 'node:crypto';
import { getMasterPrompt } from '@/lib/ai/master-prompts';
import { generateJson } from '@/lib/ai/provider';
import { getAnthropicSpecModel } from '@/lib/ai/spec-models';
import { summarizeMeeting, upsertProjectMeetingNote } from '@/lib/assistant/meeting-notes';
import { ensureAssistantRuntimeTables } from '@/lib/assistant/schema';
import { buildProjectContextWithinBudget } from '@/lib/assistant/project-memory';
import { analyzeEmailThread } from '@/lib/email-hub';
import { db } from '@/lib/db';
import { fetchGoogleCalendarEvents } from '@/lib/google/calendar';
import { fetchGmailInbox } from '@/lib/google/gmail';

interface SyncTodo {
  task: string;
  priority: 'high' | 'medium' | 'low';
  deadline: string | null;
  context: string;
}

function collectProjectEmails(metadata: Record<string, unknown> | null, linkedContacts: string[] | null): string[] {
  const emails = new Set<string>();
  const scan = (value: unknown) => {
    if (typeof value === 'string') {
      const matches = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
      for (const match of matches) emails.add(match.toLowerCase());
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(scan);
      return;
    }
    if (value && typeof value === 'object') {
      Object.values(value).forEach(scan);
    }
  };

  scan(metadata);
  scan(linkedContacts);
  return [...emails];
}

function toIsoOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

async function mirrorLegacyMeetingNote(params: {
  userId: string;
  projectId: string;
  externalId: string;
  title: string;
  meetingDate: string | null;
  content: string;
}) {
  const existing = await db.queryOne<{ id: string }>(
    `SELECT id
     FROM client_meeting_notes
     WHERE user_id = $1 AND project_id = $2 AND external_id = $3
     LIMIT 1`,
    [params.userId, params.projectId, params.externalId]
  );

  if (existing) {
    await db.query(
      `UPDATE client_meeting_notes
       SET title = $4, meeting_date = $5, content = $6, updated_at = NOW()
       WHERE id = $1 AND user_id = $2 AND project_id = $3`,
      [existing.id, params.userId, params.projectId, params.title, params.meetingDate, params.content]
    );
    return;
  }

  await db.query(
    `INSERT INTO client_meeting_notes (id, client_id, user_id, title, content, meeting_date, source, external_id, project_id, created_at, updated_at)
     VALUES ($1, NULL, $2, $3, $4, $5, 'calendar_sync', $6, $7, NOW(), NOW())`,
    [randomUUID(), params.userId, params.title, params.content, params.meetingDate, params.externalId, params.projectId]
  );
}

async function generateSyncTodos(params: { userId: string; projectId: string }): Promise<number> {
  const projectContext = await buildProjectContextWithinBudget(params.projectId, 'Generate the synced project task list.', 60_000);
  if (!projectContext.trim()) {
    return 0;
  }

  const todos = await generateJson<{ todos?: Array<{ task?: string; priority?: string; deadline?: string | null; context?: string }> }>({
    system: [
      'You generate a consolidated initial project todo list from project memory after sync.',
      'Return JSON only with this shape: { "todos": [{ "task": string, "priority": "high|medium|low", "deadline": string|null, "context": string }] }.',
      'Rules: include only actionable next steps, avoid duplicating clearly completed work, prefer 3-8 tasks, and keep tasks specific.',
      `Reference style guide:\n${getMasterPrompt(9)}`,
    ].join('\n\n'),
    messages: [
      {
        role: 'user',
        content: [
          'Generate the current project todo list from this synchronized project memory.',
          projectContext,
        ].join('\n\n'),
      },
    ],
    maxTokens: 2000,
    temperature: 0.3,
    preferredProvider: 'anthropic',
    model: getAnthropicSpecModel('opus'),
  });

  let inserted = 0;
  for (const candidate of todos.todos || []) {
    const task = typeof candidate.task === 'string' ? candidate.task.trim() : '';
    if (!task) {
      continue;
    }

    const sourceHash = createHash('sha256').update(`project_sync:${params.projectId}:${task}`).digest('hex');
    const existing = await db.queryOne<{ id: string }>(
      `SELECT id FROM todo WHERE user_id = $1 AND source_hash = $2 LIMIT 1`,
      [params.userId, sourceHash]
    );
    if (existing) {
      continue;
    }

    const priority = ['high', 'medium', 'low'].includes((candidate.priority || '').toLowerCase())
      ? (candidate.priority || 'medium').toLowerCase()
      : 'medium';

    await db.query(
      `INSERT INTO todo (id, user_id, title, description, status, priority, due_at, source, source_hash, created_at, updated_at, project_id)
       VALUES ($1, $2, $3, $4, 'todo'::todo_status, $5::todo_priority, $6::timestamptz, $7::jsonb, $8, NOW(), NOW(), $9)`,
      [
        randomUUID(),
        params.userId,
        task,
        typeof candidate.context === 'string' ? candidate.context.trim() : null,
        priority,
        toIsoOrNull(candidate.deadline),
        JSON.stringify({ source: 'project_sync' }),
        sourceHash,
        params.projectId,
      ]
    );
    inserted += 1;
  }

  return inserted;
}

export async function runProjectSync(
  userId: string,
  projectId: string
): Promise<{ syncedEmails: number; syncedMeetings: number; ingestedAttachments: number; generatedTodos: number }> {
  await ensureAssistantRuntimeTables();

  const project = await db.queryOne<{
    id: string;
    title: string | null;
    name: string | null;
    description: string | null;
    metadata: Record<string, unknown> | null;
    linked_contacts: string[] | null;
  }>(
    `SELECT id, title, name, description, metadata, linked_contacts
     FROM projects
     WHERE user_id = $1 AND id = $2`,
    [userId, projectId]
  );

  if (!project) {
    throw new Error('Project not found');
  }

  const lastSyncValue = typeof project.metadata?.last_ai_sync === 'string' ? project.metadata.last_ai_sync : null;
  const lastSync = lastSyncValue ? new Date(lastSyncValue) : null;
  const contactEmails = collectProjectEmails(project.metadata, project.linked_contacts);

  const recentInbox = await fetchGmailInbox(userId, lastSync ? 50 : 100);
  const candidateThreads = contactEmails.length
    ? recentInbox.filter((email) => {
        const matchesContact = contactEmails.some(
          (contact) => email.from.toLowerCase().includes(contact) || email.to.toLowerCase().includes(contact)
        );
        if (!matchesContact) {
          return false;
        }
        if (!lastSync || !email.receivedAt) {
          return true;
        }
        return new Date(email.receivedAt).getTime() >= lastSync.getTime();
      })
    : [];

  const uniqueThreads = [...new Map(candidateThreads.map((thread) => [thread.threadId, thread])).values()];
  let syncedEmails = 0;
  let ingestedAttachments = 0;
  for (const thread of uniqueThreads) {
    const analysis = await analyzeEmailThread(userId, thread.threadId, { projectId });
    syncedEmails += 1;
    ingestedAttachments += analysis.ingestedAttachments;
  }

  const now = new Date();
  const calendarEvents = await fetchGoogleCalendarEvents(userId, {
    timeMin: lastSync ? lastSync.toISOString() : new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString(),
    timeMax: now.toISOString(),
    maxResults: 100,
  });

  const relevantEvents = contactEmails.length
    ? calendarEvents.filter(
        (event) =>
          new Date(event.start).getTime() <= now.getTime() &&
          event.attendeeEmails.some((email) => contactEmails.includes(email.toLowerCase()))
      )
    : [];

  let syncedMeetings = 0;
  for (const event of relevantEvents) {
    const summary = await summarizeMeeting({
      title: event.title,
      description: event.description,
      attendees: event.attendeeEmails,
      projectName: project.title || project.name || 'Untitled Project',
      projectDescription: project.description,
    });

    await upsertProjectMeetingNote({
      userId,
      projectId,
      calendarEventId: event.id,
      title: event.title,
      meetingDate: event.start,
      attendees: event.attendeeEmails,
      summary: summary.summary,
      decisions: summary.decisions,
      actionItems: summary.action_items,
      rawNotes: event.description || null,
      source: 'project_sync',
    });

    await mirrorLegacyMeetingNote({
      userId,
      projectId,
      externalId: event.id,
      title: event.title,
      meetingDate: event.start,
      content: [summary.summary, summary.decisions.length ? `Decisions: ${summary.decisions.join(' · ')}` : '', summary.action_items.length ? `Action items: ${summary.action_items.join(' · ')}` : '']
        .filter(Boolean)
        .join('\n'),
    });

    syncedMeetings += 1;
  }

  const generatedTodos = await generateSyncTodos({ userId, projectId });

  const nextMetadata = {
    ...(project.metadata || {}),
    last_ai_sync: new Date().toISOString(),
    synced_contact_emails: contactEmails,
  };

  await db.query(`UPDATE projects SET metadata = $2::jsonb, updated_at = NOW() WHERE id = $1`, [projectId, JSON.stringify(nextMetadata)]);

  return {
    syncedEmails,
    syncedMeetings,
    ingestedAttachments,
    generatedTodos,
  };
}
