import { NextRequest, NextResponse } from 'next/server';
import { analyzeEmailThread } from '@/lib/email-hub';
import { getCurrentUser } from '@/lib/current-user';

export async function POST(request: NextRequest) {
  const current = await getCurrentUser();
  if (!current) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = (await request.json()) as { threadId?: string; lastMessageAt?: string | null };
  if (!body.threadId?.trim()) {
    return NextResponse.json({ error: 'threadId is required' }, { status: 400 });
  }

  try {
    const result = await analyzeEmailThread(current.user.id, body.threadId.trim(), {
      lastMessageAt: body.lastMessageAt || null,
    });
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Email analysis failed';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
