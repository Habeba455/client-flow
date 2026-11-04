import { NextRequest, NextResponse } from 'next/server';
import { getAssistantProfile } from '@/lib/assistant-profile';
import { executeRoutingPlan, mergeAgentOutputs } from '@/lib/assistant/runner';
import { getCurrentUser } from '@/lib/current-user';
import { routeMessage } from '@/lib/ai/orchestrator';

export async function POST(request: NextRequest) {
  const current = await getCurrentUser();
  if (!current) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const savedProfile = await getAssistantProfile(current.user.id);
  if (!savedProfile) {
    return NextResponse.json({ error: 'Assistant setup is incomplete.' }, { status: 409 });
  }

  const body = (await request.json()) as {
    title?: string;
    description?: string;
    start?: string;
    end?: string;
    attendeeCount?: number;
  };

  const prompt = [
    `Prepare me for this meeting: ${body.title || 'Meeting'}.`,
    body.start ? `Start: ${body.start}` : '',
    body.end ? `End: ${body.end}` : '',
    typeof body.attendeeCount === 'number' ? `Attendees: ${body.attendeeCount}` : '',
    body.description ? `Description:\n${body.description}` : 'Description: not provided.',
    'Give me a concise prep brief with meeting objective, likely questions, talking points, risks, and a suggested follow-up structure.',
  ]
    .filter(Boolean)
    .join('\n\n');

  const routing = await routeMessage(prompt, { surface: 'calendar' });
  const runs = await executeRoutingPlan(routing.routing, [], savedProfile.profile, savedProfile.intros, { artifacts: [] });
  const reply = await mergeAgentOutputs(prompt, runs, routing.merge_instruction);

  return NextResponse.json({ reply, route: routing });
}
