import { NextRequest, NextResponse } from 'next/server';
import { runProjectSync } from '@/lib/assistant/project-sync';
import { getCurrentUser } from '@/lib/current-user';

export async function POST(_request: NextRequest, { params }: { params: { projectId: string } }) {
  const current = await getCurrentUser();
  if (!current) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await runProjectSync(current.user.id, params.projectId);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Sync failed';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
