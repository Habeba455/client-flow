import { NextRequest, NextResponse } from 'next/server';
import { getAssistantProfile } from '@/lib/assistant-profile';
import { executeRoutingPlan, mergeAgentOutputs } from '@/lib/assistant/runner';
import { getCurrentUser } from '@/lib/current-user';
import { routeMessage } from '@/lib/ai/orchestrator';
import { getCalendarPlanningContext } from '@/lib/product-data';

export async function POST(request: NextRequest) {
  const current = await getCurrentUser();
  if (!current) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const savedProfile = await getAssistantProfile(current.user.id);
  if (!savedProfile) {
    return NextResponse.json({ error: 'Assistant setup is incomplete.' }, { status: 409 });
  }

  const body = (await request.json()) as { date?: string };
  const date = body.date ? new Date(body.date) : new Date();
  const planning = await getCalendarPlanningContext(current.user.id, date);

  const prompt = [
    `Organise my day for ${date.toDateString()}.`,
    planning.events.length > 0
      ? `Calendar events:\n${planning.events
          .map(
            (event) =>
              `- ${event.title} at ${new Date(event.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} for ${Math.max(
                15,
                Math.round((new Date(event.end).getTime() - new Date(event.start).getTime()) / 60000)
              )} minutes${event.description ? ` | ${event.description}` : ''}${event.noteContent ? ` | Notes: ${event.noteContent}` : ''}`
          )
          .join('\n')}`
      : 'Calendar events: none.',
    planning.tasks.length > 0
      ? `Tasks:\n${planning.tasks
          .map(
            (task) =>
              `- [${task.priority}] ${task.title}${task.project_name ? ` (${task.project_name})` : ''}${
                task.due_at ? ` due ${new Date(task.due_at).toLocaleString()}` : ''
              }`
          )
          .join('\n')}`
      : 'Tasks: none.',
    planning.approvals.length > 0
      ? `Pending approvals:\n${planning.approvals.map((approval) => `- ${approval.title} (${approval.status})`).join('\n')}`
      : 'Pending approvals: none.',
    'Return a practical execution plan for the day with priorities, timing advice, and what to defer.',
  ].join('\n\n');

  const routing = await routeMessage(prompt, { surface: 'calendar' });
  const runs = await executeRoutingPlan(routing.routing, [], savedProfile.profile, savedProfile.intros, { artifacts: [] });
  const reply = await mergeAgentOutputs(prompt, runs, routing.merge_instruction);

  return NextResponse.json({ reply, route: routing, events: planning.events, tasks: planning.tasks });
}
