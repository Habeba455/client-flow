import { NextRequest, NextResponse } from 'next/server';
import { getAssistantProfile, saveAssistantProfile } from '@/lib/assistant-profile';
import { getCurrentUser } from '@/lib/current-user';

export async function PATCH(request: NextRequest) {
  const current = await getCurrentUser();
  if (!current) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const existing = await getAssistantProfile(current.user.id);
  if (!existing) {
    return NextResponse.json({ error: 'Assistant profile not found' }, { status: 404 });
  }

  const body = (await request.json()) as {
    address?: string | null;
    user_timezone?: string | null;
    working_hours_start?: string | null;
    working_hours_end?: string | null;
  };

  const profile = {
    ...existing.profile,
    address: typeof body.address === 'string' ? body.address : existing.profile.address || null,
    user_timezone: typeof body.user_timezone === 'string' ? body.user_timezone : existing.profile.user_timezone || 'UTC',
    working_hours_start:
      typeof body.working_hours_start === 'string' ? body.working_hours_start : existing.profile.working_hours_start || '09:00',
    working_hours_end:
      typeof body.working_hours_end === 'string' ? body.working_hours_end : existing.profile.working_hours_end || '17:00',
  };

  const saved = await saveAssistantProfile(current.user.id, profile);
  return NextResponse.json({ profile: saved.profile });
}
