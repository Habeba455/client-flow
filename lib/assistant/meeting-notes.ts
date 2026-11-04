import { randomUUID } from 'node:crypto';
import { generateJson } from '@/lib/ai/provider';
import { getAnthropicSpecModel } from '@/lib/ai/spec-models';
import { db } from '@/lib/db';

export interface MeetingSummary {
  summary: string;
  decisions: string[];
  action_items: string[];
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean)
    .slice(0, 12);
}

export async function summarizeMeeting(params: {
  title: string;
  description?: string | null;
  attendees?: string[];
  rawNotes?: string | null;
  projectName?: string | null;
  projectDescription?: string | null;
}): Promise<MeetingSummary> {
  const content = [params.description || '', params.rawNotes || ''].filter(Boolean).join('\n\n').trim();
  if (!content) {
    return {
      summary: 'Meeting record saved, but no detailed notes or description were available to summarize.',
      decisions: [],
      action_items: [],
    };
  }

  try {
    const response = await generateJson<{
      summary?: string;
      decisions?: string[];
      action_items?: string[];
    }>({
      system:
        'You summarize meeting records for a project workspace. Return JSON only with fields: summary, decisions, action_items. Keep summary to 2-3 sentences and list only explicit decisions or action items.',
      messages: [
        {
          role: 'user',
          content: [
            `Project: ${params.projectName || 'Unspecified project'}`,
            params.projectDescription ? `Project description: ${params.projectDescription}` : '',
            `Meeting title: ${params.title}`,
            params.attendees?.length ? `Attendees: ${params.attendees.join(', ')}` : '',
            '',
            content.slice(0, 10_000),
          ]
            .filter(Boolean)
            .join('\n'),
        },
      ],
      maxTokens: 600,
      temperature: 0.2,
      preferredProvider: 'anthropic',
      model: getAnthropicSpecModel('sonnet'),
    });

    return {
      summary: (typeof response.summary === 'string' && response.summary.trim()) || 'Meeting summary unavailable.',
      decisions: normalizeStringArray(response.decisions),
      action_items: normalizeStringArray(response.action_items),
    };
  } catch {
    const compact = content.replace(/\s+/g, ' ').trim();
    return {
      summary: compact.length > 360 ? `${compact.slice(0, 357)}...` : compact,
      decisions: [],
      action_items: [],
    };
  }
}

export async function upsertProjectMeetingNote(params: {
  userId: string;
  projectId: string | null;
  calendarEventId?: string | null;
  title: string;
  meetingDate: string | null;
  attendees?: string[];
  summary: string;
  decisions?: string[];
  actionItems?: string[];
  rawNotes?: string | null;
  source?: string | null;
}) {
  if (!params.projectId) {
    return null;
  }

  const existing = params.calendarEventId
    ? await db.queryOne<{ id: string }>(
        `SELECT id
         FROM project_meeting_notes
         WHERE user_id = $1 AND project_id = $2 AND calendar_event_id = $3
         LIMIT 1`,
        [params.userId, params.projectId, params.calendarEventId]
      )
    : null;

  if (existing) {
    await db.query(
      `UPDATE project_meeting_notes
       SET title = $4,
           meeting_date = $5,
           attendees = $6,
           summary = $7,
           decisions = $8::jsonb,
           action_items = $9::jsonb,
           raw_notes = $10,
           source = COALESCE($11, source),
           updated_at = NOW()
       WHERE id = $1 AND user_id = $2 AND project_id = $3`,
      [
        existing.id,
        params.userId,
        params.projectId,
        params.title,
        params.meetingDate,
        (params.attendees || []).join(', '),
        params.summary,
        JSON.stringify(params.decisions || []),
        JSON.stringify(params.actionItems || []),
        params.rawNotes || null,
        params.source || null,
      ]
    );
    return existing;
  }

  return db.queryOne<{ id: string }>(
    `INSERT INTO project_meeting_notes (
       id, user_id, project_id, calendar_event_id, title, meeting_date, attendees,
       summary, decisions, action_items, raw_notes, source, created_at, updated_at
     )
     VALUES (
       $1, $2, $3, $4, $5, $6, $7,
       $8, $9::jsonb, $10::jsonb, $11, $12, NOW(), NOW()
     )
     RETURNING id`,
    [
      randomUUID(),
      params.userId,
      params.projectId,
      params.calendarEventId || null,
      params.title,
      params.meetingDate,
      (params.attendees || []).join(', '),
      params.summary,
      JSON.stringify(params.decisions || []),
      JSON.stringify(params.actionItems || []),
      params.rawNotes || null,
      params.source || null,
    ]
  );
}
