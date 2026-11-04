import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/current-user';
import { processAssistantRequest } from '@/lib/assistant/request-handler';
import type { AssistantRequest } from '@/lib/ai/types';

export async function POST(request: NextRequest) {
  try {
    const current = await getCurrentUser();
    if (!current) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = (await request.json()) as AssistantRequest;
    const response = await processAssistantRequest(
      {
        id: current.user.id,
        name: current.user.name || null,
        email: current.user.email,
      },
      body
    );

    return NextResponse.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[api/assistant]', error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
