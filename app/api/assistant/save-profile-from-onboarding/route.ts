import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/current-user';
import { saveAssistantProfile } from '@/lib/assistant-profile';
import { extractProfileFromOnboardingHistory } from '@/lib/ai/settings-agent';
import type { ChatMessage } from '@/lib/ai/types';

export async function POST(request: NextRequest) {
  try {
    const current = await getCurrentUser();
    if (!current) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = (await request.json()) as { history?: ChatMessage[] };
    const history = Array.isArray(body.history) ? body.history : [];

    const profile = await extractProfileFromOnboardingHistory(history);
    if (!profile) {
      return NextResponse.json(
        { error: 'Could not extract a firm profile from the conversation. Add a bit more detail and try again.' },
        { status: 400 }
      );
    }

    const saved = await saveAssistantProfile(current.user.id, profile);
    return NextResponse.json({
      ok: true,
      profile: saved.profile,
      mode: 'assistant',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to save profile';
    console.error('[api/assistant/save-profile-from-onboarding]', error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
