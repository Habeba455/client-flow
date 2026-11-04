import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { summarizeMeeting, upsertProjectMeetingNote } from '@/lib/assistant/meeting-notes';
import { ensureAssistantRuntimeTables } from '@/lib/assistant/schema';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/current-user';

export async function POST(request: NextRequest) {
  const current = await getCurrentUser();
  if (!current) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  await ensureAssistantRuntimeTables();

  const body = (await request.json()) as {
    eventId?: string | null;
    title?: string;
    meetingDate?: string | null;
    content?: string;
  };

  if (!body.content?.trim()) {
    return NextResponse.json({ error: 'content is required' }, { status: 400 });
  }

  if (body.eventId) {
    const existingProjectMeeting = await db.queryOne<{ project_id: string; title: string | null }>(
      `SELECT project_id, title
       FROM project_meeting_notes
       WHERE user_id = $1 AND calendar_event_id = $2
       LIMIT 1`,
      [current.user.id, body.eventId]
    );

    if (existingProjectMeeting?.project_id) {
      const summary = await summarizeMeeting({
        title: body.title || existingProjectMeeting.title || 'Meeting',
        rawNotes: body.content.trim(),
      });
      await upsertProjectMeetingNote({
        userId: current.user.id,
        projectId: existingProjectMeeting.project_id,
        calendarEventId: body.eventId,
        title: body.title || existingProjectMeeting.title || 'Meeting',
        meetingDate: body.meetingDate || null,
        summary: summary.summary,
        decisions: summary.decisions,
        actionItems: summary.action_items,
        rawNotes: body.content.trim(),
        source: 'manual',
      });
    }

    const existing = await db.queryOne<{ id: string }>(
      `SELECT id
       FROM client_meeting_notes
       WHERE user_id = $1 AND external_id = $2
       LIMIT 1`,
      [current.user.id, body.eventId]
    );

    if (existing) {
      const updated = await db.queryOne(
        `UPDATE client_meeting_notes
         SET content = $3, title = COALESCE($4, title), meeting_date = COALESCE($5, meeting_date), updated_at = NOW()
         WHERE id = $1 AND user_id = $2
         RETURNING id, title, content, meeting_date, external_id`,
        [existing.id, current.user.id, body.content.trim(), body.title || null, body.meetingDate || null]
      );
      return NextResponse.json({ note: updated });
    }
  }

  const inserted = await db.queryOne(
    `INSERT INTO client_meeting_notes (id, client_id, user_id, title, content, meeting_date, source, external_id, project_id, created_at, updated_at)
     VALUES ($1, NULL, $2, $3, $4, $5, 'manual', $6, NULL, NOW(), NOW())
     RETURNING id, title, content, meeting_date, external_id`,
    [randomUUID(), current.user.id, body.title || 'Meeting', body.content.trim(), body.meetingDate || null, body.eventId || null]
  );

  return NextResponse.json({ note: inserted });
}
