import { randomUUID } from 'node:crypto';
import { buildAgentExecution } from '@/lib/ai/personas';
import { generateJson, generateText } from '@/lib/ai/provider';
import { getAnthropicSpecModel } from '@/lib/ai/spec-models';
import type { AgentRunResult, ChatMessage, RoutingTask, UserProfile, PersonaIntros, WorkspaceState } from '@/lib/ai/types';

export interface RoutingPlanProgressUpdate {
  phase: 'starting' | 'completed';
  message: string;
  persona: RoutingTask['persona'];
}

function findDependencyOutputs(task: RoutingTask, completed: AgentRunResult[]): string[] {
  if (!task.depends_on) {
    return [];
  }

  const dependency = task.depends_on.trim().toUpperCase();
  return completed
    .filter((run) => run.persona === dependency)
    .map((run) => `${run.persona}\n${run.output}`);
}

function isSpreadsheetDocumentTask(task: RoutingTask): boolean {
  if (task.persona !== 'DOCUMENT_GENERATOR') {
    return false;
  }

  const fileSubtype = typeof task.context.file_subtype === 'string' ? task.context.file_subtype.toLowerCase() : '';
  const deliverable = typeof task.context.deliverable_type === 'string' ? task.context.deliverable_type.toLowerCase() : '';

  return (
    fileSubtype === 'excel' ||
    fileSubtype === 'xlsx' ||
    deliverable === 'spreadsheet' ||
    deliverable === 'excel' ||
    /\bfinancial model\b|\bexcel\b|\bxlsx\b/i.test(task.subtask)
  );
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  const normalized = value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  try {
    const parsed = JSON.parse(normalized);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    const objectMatch = normalized.match(/\{[\s\S]*\}/);
    if (!objectMatch) {
      return null;
    }

    try {
      const parsed = JSON.parse(objectMatch[0]);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
}

function formatEmailAnalystReply(originalMessage: string, parsed: Record<string, unknown>): string | null {
  const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
  if (!summary) {
    return null;
  }

  const lower = originalMessage.toLowerCase();
  const todos = Array.isArray(parsed.todos)
    ? parsed.todos
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
        .map((item) => ({
          task: typeof item.task === 'string' ? item.task.trim() : '',
          owner: typeof item.owner === 'string' ? item.owner.trim() : '',
          priority: typeof item.priority === 'string' ? item.priority.trim() : '',
        }))
        .filter((item) => item.task)
    : [];
  const replyNeeded = typeof parsed.reply_needed === 'boolean' ? parsed.reply_needed : null;
  const replyUrgency = typeof parsed.reply_urgency === 'string' ? parsed.reply_urgency.trim() : '';
  const meetingRequested = parsed.meeting_requested === true;
  const meetingDetails =
    parsed.meeting_details && typeof parsed.meeting_details === 'object' ? (parsed.meeting_details as Record<string, unknown>) : null;

  const sections: string[] = [summary];

  if (/(todo|to-do|task|action item|next step)/i.test(lower) && todos.length > 0) {
    sections.push(
      ['Action items:', ...todos.map((todo) => `- ${todo.task}${todo.owner ? ` (${todo.owner})` : ''}${todo.priority ? ` [${todo.priority}]` : ''}`)].join('\n')
    );
  }

  if (/(reply|respond|response)/i.test(lower) && replyNeeded != null) {
    sections.push(replyNeeded ? `Reply needed: yes${replyUrgency ? ` (${replyUrgency})` : ''}.` : 'Reply needed: no.');
  }

  if (/(meeting|call|schedule|invite|availability)/i.test(lower) && meetingRequested) {
    const purpose = meetingDetails && typeof meetingDetails.purpose === 'string' ? meetingDetails.purpose.trim() : '';
    sections.push(purpose ? `Meeting request detected: ${purpose}.` : 'Meeting request detected in the analysed material.');
  }

  return sections.join('\n\n');
}

function formatCalendarAgentReply(run: AgentRunResult, parsed?: Record<string, unknown> | null): string | null {
  const validSlots = Array.isArray(run.context.valid_meeting_slots)
    ? run.context.valid_meeting_slots.filter((slot): slot is Record<string, unknown> => Boolean(slot) && typeof slot === 'object')
    : [];
  const slotConstraints =
    run.context.slot_constraints && typeof run.context.slot_constraints === 'object'
      ? (run.context.slot_constraints as Record<string, unknown>)
      : null;
  const clientTimezone =
    typeof run.context.client_timezone === 'string' && run.context.client_timezone.trim()
      ? run.context.client_timezone.trim()
      : null;
  const duration =
    typeof run.context.duration_minutes === 'number'
      ? run.context.duration_minutes
      : typeof run.context.duration_minutes === 'string' && run.context.duration_minutes.trim()
        ? Number(run.context.duration_minutes)
          : parsed && typeof parsed.duration_minutes === 'number'
          ? parsed.duration_minutes
          : 30;

  if (validSlots.length > 0) {
    const lines = [
      `Here are the available ${duration}-minute meeting slots${clientTimezone ? ` for the client's timezone (${clientTimezone})` : ''}:`,
      '',
      '| Option | Your time | Client time |',
      '| --- | --- | --- |',
      ...validSlots.slice(0, 6).map((slot, index) => {
        const userDisplay = typeof slot.userDisplayTime === 'string' ? slot.userDisplayTime.trim() : 'Not available';
        const clientDisplay = typeof slot.clientDisplayTime === 'string' ? slot.clientDisplayTime.trim() : userDisplay;
        return `| ${index + 1} | ${userDisplay} | ${clientDisplay} |`;
      }),
      '',
      'Tell me which option you want, and I can draft the reply or help you send the invite.',
    ];

    return lines.join('\n');
  }

  if (slotConstraints?.noOverlap) {
    const message = typeof slotConstraints.message === 'string' ? slotConstraints.message.trim() : 'No mutual availability was found.';
    const nearestOption =
      typeof slotConstraints.nearestOption === 'string' && slotConstraints.nearestOption.trim()
        ? slotConstraints.nearestOption.trim()
        : '';

    return [message, nearestOption ? `Nearest available option: ${nearestOption}.` : '', 'If you want, I can suggest an alternative week or a different meeting duration.']
      .filter(Boolean)
      .join('\n\n');
  }

  const title = parsed && typeof parsed.title === 'string' ? parsed.title.trim() : '';
  const userTime = parsed && typeof parsed.user_display_time === 'string' ? parsed.user_display_time.trim() : '';
  const clientTime = parsed && typeof parsed.client_display_time === 'string' ? parsed.client_display_time.trim() : '';
  const attendees = parsed && Array.isArray(parsed.attendees)
    ? (parsed.attendees as unknown[]).filter((a): a is string => typeof a === 'string')
    : [];

  if (!title) {
    return null;
  }

  const lines: string[] = [
    `**${title}**`,
    '',
    userTime ? `Your time: ${userTime}` : '',
    clientTime ? `Client time: ${clientTime}` : '',
    `Duration: ${duration} minutes`,
    attendees.length > 0 ? `Attendees: ${attendees.join(', ')}` : '',
  ].filter(Boolean);

  const timezoneNote = parsed && typeof parsed.timezone_note === 'string' ? parsed.timezone_note.trim() : '';
  if (timezoneNote) {
    lines.push('', timezoneNote);
  }

  return lines.join('\n');
}

function stripCalendarDraftLeak(value: string): string {
  return value
    .replace(/\n{0,2}#+\s*Draft Event Specification[\s\S]*$/i, '')
    .replace(/\n{0,2}Draft Event Specification[\s\S]*$/i, '')
    .replace(/\n{0,2}```(?:json)?[\s\S]*?start_datetime_utc[\s\S]*?```\s*$/i, '')
    .trim();
}

async function maybeFormatSingleAgentOutput(originalMessage: string, run: AgentRunResult): Promise<string> {
  if (run.persona === 'EMAIL_ANALYST') {
    const parsed = parseJsonObject(run.output);
    const formatted = parsed ? formatEmailAnalystReply(originalMessage, parsed) : null;
    if (formatted) {
      return formatted;
    }
  }

  if (run.persona === 'CALENDAR_AGENT') {
    const parsed = parseJsonObject(run.output);
    const formatted = formatCalendarAgentReply(run, parsed);
    if (formatted) {
      return formatted;
    }
  }

  return run.persona === 'CALENDAR_AGENT' ? stripCalendarDraftLeak(run.output) : run.output;
}

async function executeTask(
  task: RoutingTask,
  history: ChatMessage[],
  profile: UserProfile,
  intros: PersonaIntros,
  workspace: WorkspaceState,
  completed: AgentRunResult[]
): Promise<AgentRunResult> {
  const dependencyOutputs = findDependencyOutputs(task, completed);
  const execution = await buildAgentExecution(task.persona, task, intros, profile, history, workspace, dependencyOutputs);
  const output = isSpreadsheetDocumentTask(task)
    ? JSON.stringify(
        await generateJson<Record<string, unknown>>({
          system: execution.system,
          messages: execution.messages,
          maxTokens: execution.maxTokens,
          temperature: execution.temperature,
          preferredProvider: 'anthropic',
          model: execution.model,
        }),
        null,
        2
      )
    : await generateText({
        system: execution.system,
        messages: execution.messages,
        maxTokens: execution.maxTokens,
        temperature: execution.temperature,
        preferredProvider: 'anthropic',
        model: execution.model,
      });

  return {
    id: `run_${randomUUID().slice(0, 8)}`,
    persona: task.persona,
    subtask: task.subtask,
    context: task.context,
    depends_on: task.depends_on,
    output,
  };
}

export async function executeRoutingPlan(
  tasks: RoutingTask[],
  history: ChatMessage[],
  profile: UserProfile,
  intros: PersonaIntros,
  workspace: WorkspaceState,
  onProgress?: (update: RoutingPlanProgressUpdate) => Promise<void> | void
): Promise<AgentRunResult[]> {
  const pending = tasks.map((task) => ({ ...task }));
  const completed: AgentRunResult[] = [];

  while (pending.length > 0) {
    const ready = pending.filter((task) => !task.depends_on || completed.some((run) => run.persona === task.depends_on));
    if (ready.length === 0) {
      throw new Error('Routing plan has an unresolved dependency.');
    }

    for (const task of ready) {
      await onProgress?.({
        phase: 'starting',
        message: `Running ${task.persona.replaceAll('_', ' ')}`,
        persona: task.persona,
      });
    }

    const results = await Promise.all(ready.map((task) => executeTask(task, history, profile, intros, workspace, completed)));
    completed.push(...results);

    for (const result of results) {
      await onProgress?.({
        phase: 'completed',
        message: `Completed ${result.persona.replaceAll('_', ' ')}`,
        persona: result.persona,
      });
    }

    for (const task of ready) {
      const index = pending.indexOf(task);
      if (index >= 0) {
        pending.splice(index, 1);
      }
    }
  }

  return completed;
}

export async function mergeAgentOutputs(originalMessage: string, agentRuns: AgentRunResult[], mergeInstruction: string | null): Promise<string> {
  if (agentRuns.length === 1) {
    const run = agentRuns[0];
    return run ? maybeFormatSingleAgentOutput(originalMessage, run) : '';
  }

  const formattedRuns = await Promise.all(
    agentRuns.map(async (run) => ({
      run,
      output: await maybeFormatSingleAgentOutput(originalMessage, run),
    }))
  );

  const fallback = formattedRuns.map(({ run, output }) => `## ${run.persona.replaceAll('_', ' ')}\n\n${output}`).join('\n\n');

  try {
    return stripCalendarDraftLeak(
      await generateText({
      system:
        'You are assembling the final user-visible response from multiple specialist agent outputs. Follow the merge instruction exactly. Preserve concrete details. Do not expose internal orchestration, raw JSON, draft specifications, ISO timestamps, or tool payloads. Rewrite calendar outputs in plain human language.',
      messages: [
        {
          role: 'user',
          content: [
            `Original user request: ${originalMessage}`,
            `Merge instruction: ${mergeInstruction || 'Combine the outputs into one coherent response.'}`,
            'Agent outputs:',
            ...formattedRuns.map(({ run, output }) => `${run.persona}\n${output}`),
          ].join('\n\n'),
        },
      ],
      maxTokens: 4000,
      temperature: 0.2,
      preferredProvider: 'anthropic',
      model: getAnthropicSpecModel('sonnet'),
    })
    );
  } catch {
    return fallback;
  }
}
