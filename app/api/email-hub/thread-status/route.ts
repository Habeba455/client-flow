import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/current-user';
import { updateGmailThreadUnreadStatus } from '@/lib/google/gmail';

export async function POST(request: Request) {
  const current = await getCurrentUser();
  if (!current) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = (await request.json()) as { threadId?: string; unread?: boolean };
  if (!body.threadId?.trim() || typeof body.unread !== 'boolean') {
    return NextResponse.json({ error: 'threadId and unread are required' }, { status: 400 });
  }

  try {
    const thread = await updateGmailThreadUnreadStatus({
      userId: current.user.id,
      threadId: body.threadId.trim(),
      unread: body.unread,
    });

    if (!thread) {
      return NextResponse.json({ error: 'Email thread not found' }, { status: 404 });
    }

    return NextResponse.json({
      threadId: thread.id,
      unread: body.unread,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update thread status';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
