import { AGENT_PROMPT_CONFIG, getAnthropicModelForTier } from '@/lib/ai/agent-config';
import { buildAgentPrompt } from '@/lib/ai/master-prompts';
import { buildProjectContextWithinBudget } from '@/lib/assistant/project-memory';
import type {
  AgentName,
  ChatMessage,
  PersonaIntros,
  RoutingTask,
  UserProfile,
  WorkspaceArtifact,
  WorkspaceState,
} from '@/lib/ai/types';

function formatValue(value: unknown): string {
  if (value == null) return 'Not specified';
  if (Array.isArray(value)) {
    return value.length ? value.map((item) => String(item)).join(', ') : 'Not specified';
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}

function artifactMatchesProject(artifact: WorkspaceArtifact, project: string | null): boolean {
  if (!project) return false;
  return artifact.project?.toLowerCase() === project.toLowerCase();
}

function getRelevantArtifacts(task: RoutingTask, workspace: WorkspaceState): WorkspaceArtifact[] {
  const project = typeof task.context.project === 'string' ? task.context.project : null;
  const matched = workspace.artifacts.filter((artifact) => artifactMatchesProject(artifact, project));
  if (matched.length > 0) {
    return matched.slice(-4);
  }
  return workspace.artifacts.slice(-2);
}

function formatRecentConversation(history: ChatMessage[]): string {
  return history
    .slice(-8)
    .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
    .join('\n');
}

function formatProfileContext(profile: UserProfile | null): string {
  if (!profile) {
    return '';
  }

  const lines = [
    profile.firm_name ? `Firm name: ${profile.firm_name}` : '',
    profile.firm_description ? `Firm description: ${profile.firm_description}` : '',
    profile.primary_industry ? `Primary industry: ${profile.primary_industry}` : '',
    profile.secondary_industries.length ? `Secondary industries: ${profile.secondary_industries.join(', ')}` : '',
    profile.firm_size ? `Firm size: ${profile.firm_size}` : '',
    profile.services.length ? `Services: ${profile.services.join(', ')}` : '',
    profile.client_profile ? `Typical clients: ${profile.client_profile}` : '',
    profile.client_problems.length ? `Client problems: ${profile.client_problems.join(', ')}` : '',
    profile.credentials.length ? `Credentials: ${profile.credentials.join(', ')}` : '',
    profile.geography.length ? `Geography: ${profile.geography.join(', ')}` : '',
    profile.positioning ? `Positioning: ${profile.positioning}` : '',
    profile.contact_email ? `Contact email: ${profile.contact_email}` : '',
    profile.contact_website ? `Contact website: ${profile.contact_website}` : '',
  ].filter(Boolean);

  return lines.join('\n');
}

function formatCalendarAvailabilityContext(task: RoutingTask): string {
  if (task.persona !== 'CALENDAR_AGENT') {
    return '';
  }

  const validSlots = Array.isArray(task.context.valid_meeting_slots)
    ? task.context.valid_meeting_slots.filter((slot): slot is Record<string, unknown> => Boolean(slot) && typeof slot === 'object')
    : [];
  const slotConstraints =
    task.context.slot_constraints && typeof task.context.slot_constraints === 'object'
      ? (task.context.slot_constraints as Record<string, unknown>)
      : null;

  const lines = [
    'AUTHORITATIVE_MEETING_SLOT_RULES:',
    `User timezone: ${typeof task.context.user_timezone === 'string' ? task.context.user_timezone : 'UTC'}`,
    `User working hours: ${typeof task.context.working_hours_start === 'string' ? task.context.working_hours_start : '09:00'}-${
      typeof task.context.working_hours_end === 'string' ? task.context.working_hours_end : '17:00'
    }`,
    `Client timezone: ${typeof task.context.client_timezone === 'string' && task.context.client_timezone ? task.context.client_timezone : 'not set'}`,
    'Any suggested meeting time must come from getValidMeetingSlots. Do not invent ad hoc times.',
  ];

  if (validSlots.length > 0) {
    lines.push(
      `Valid slots:\n${validSlots
        .map((slot) => {
          const userDisplay = typeof slot.userDisplayTime === 'string' ? slot.userDisplayTime : '';
          const clientDisplay = typeof slot.clientDisplayTime === 'string' ? slot.clientDisplayTime : '';
          const note = typeof slot.timezoneNote === 'string' && slot.timezoneNote ? ` (${slot.timezoneNote})` : '';
          return `- ${userDisplay}${clientDisplay ? ` | client: ${clientDisplay}` : ''}${note}`;
        })
        .join('\n')}`
    );
  } else if (slotConstraints?.noOverlap) {
    lines.push(typeof slotConstraints.message === 'string' ? slotConstraints.message : 'No valid mutual availability found.');
    if (typeof slotConstraints.nearestOption === 'string' && slotConstraints.nearestOption) {
      lines.push(`Nearest option: ${slotConstraints.nearestOption}`);
    }
  }

  return lines.join('\n');
}

export async function buildAgentExecution(
  agent: AgentName,
  task: RoutingTask,
  intros: PersonaIntros | null,
  profile: UserProfile | null,
  history: ChatMessage[],
  workspace: WorkspaceState,
  dependencyOutputs: string[]
): Promise<{ system: string; messages: Array<{ role: 'user' | 'assistant'; content: string }>; maxTokens: number; temperature: number; model: string }> {
  const prompt = buildAgentPrompt(agent, task, intros);
  const now = new Date();
  const facts = Object.entries(task.context || {}).map(([key, value]) => `${key}: ${formatValue(value)}`);
  const relevantArtifacts = getRelevantArtifacts(task, workspace);
  const projectId = typeof task.context.project_id === 'string' ? task.context.project_id : null;
  const projectContext = projectId ? await buildProjectContextWithinBudget(projectId, task.subtask) : '';
  const calendarAvailabilityContext = formatCalendarAvailabilityContext(task);
  const contextChunks = [
    `Current date: ${now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`,
    `Current timestamp: ${now.toISOString()}`,
    formatProfileContext(profile) ? `USER_PROFILE:\n${formatProfileContext(profile)}` : '',
    calendarAvailabilityContext,
    ...facts,
    history.length > 0 ? `Recent conversation:\n${formatRecentConversation(history)}` : '',
    relevantArtifacts.length > 0
      ? `Relevant workspace records:\n${relevantArtifacts
          .map((artifact) => `${artifact.kind.toUpperCase()} | ${artifact.title}\n${artifact.content}`)
          .join('\n\n')}`
      : '',
    dependencyOutputs.length > 0 ? `Outputs from prerequisite agents:\n${dependencyOutputs.join('\n\n')}` : '',
  ].filter(Boolean);

  const user = [
    contextChunks.length > 0 ? `[CONTEXT]\n${contextChunks.join('\n\n')}` : '',
    `[TASK]\n${task.subtask}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  const historyMessages = history
    .filter((message): message is ChatMessage & { role: 'user' | 'assistant' } => message.role === 'user' || message.role === 'assistant')
    .map((message) => ({ role: message.role, content: message.content }));

  return {
    system: [projectContext, prompt].filter(Boolean).join('\n\n'),
    messages: [...historyMessages, { role: 'user', content: user }],
    maxTokens: AGENT_PROMPT_CONFIG[agent].maxTokens,
    temperature: AGENT_PROMPT_CONFIG[agent].temperature,
    model: getAnthropicModelForTier(AGENT_PROMPT_CONFIG[agent].modelTier),
  };
}
