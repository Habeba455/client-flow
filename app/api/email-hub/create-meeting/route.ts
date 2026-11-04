import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/current-user';
import { markMeetingInvitationSent } from '@/lib/email-hub';
import { createGoogleCalendarEvent } from '@/lib/google/calendar';

export async function POST(request: Request) {
  const current = await getCurrentUser();
  if (!current) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = (await request.json()) as {
    threadId?: string;
    start?: string;
    end?: string;
    attendeeEmail?: string;
    attendeeName?: string | null;
    title?: string | null;
    description?: string | null;
  };

  if (!body.threadId || !body.start || !body.end || !body.attendeeEmail) {
    return NextResponse.json({ error: 'threadId, start, end, and attendeeEmail are required' }, { status: 400 });
  }

  try {
    const created = await createGoogleCalendarEvent(current.user.id, {
      title: body.title?.trim() || 'Meeting',
      description: body.description?.trim() || 'Scheduled from Email Hub.',
      start: body.start,
      end: body.end,
      attendees: [body.attendeeEmail.trim()],
    });

    if (!created?.id) {
      return NextResponse.json({ error: 'Failed to create calendar event' }, { status: 500 });
    }

    await markMeetingInvitationSent({
      userId: current.user.id,
      threadId: body.threadId,
      calendarEventId: created.id,
    });

    return NextResponse.json({
      id: created.id,
      threadId: body.threadId,
      attendeeEmail: body.attendeeEmail.trim(),
      attendeeName: body.attendeeName?.trim() || null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create meeting';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
