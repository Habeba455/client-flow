import { ALL_AGENT_NAMES, getAnthropicModelForTier, SPECIAL_PROMPT_CONFIG, shouldRequireApproval } from '@/lib/ai/agent-config';
import { getSpecialPrompt } from '@/lib/ai/master-prompts';
import { generateJson } from '@/lib/ai/provider';
import type { AgentName, AttachmentToIngest, ChatMessage, DeferredAction, RoutingDecision, RoutingTask, SurfaceName, UploadedAttachmentMeta } from '@/lib/ai/types';

interface RawRoutingDecision {
  complexity?: string;
  primary_persona?: string;
  routing?: Array<{
    persona?: string;
    subtask?: string;
    context?: Record<string, unknown>;
    depends_on?: string | null;
  }>;
  merge_instruction?: string | null;
  requires_approval?: boolean;
  deferred_actions?: Array<Record<string, unknown>>;
  attachments_to_ingest?: Array<Record<string, unknown>>;
}

type RawRoutingTask = NonNullable<RawRoutingDecision['routing']>[number];

function containsPattern(input: string, pattern: RegExp): boolean {
  return pattern.test(input);
}

function isQuestionLikeMessage(input: string): boolean {
  return /[?]\s*$/.test(input) || /^(what|which|who|when|where|why|how|summari[sz]e|explain|tell me|show me|recap|walk me through)\b/i.test(input.trim());
}

function isEmailFocusedQuestion(input: string): boolean {
  return containsPattern(input, /\b(email|inbox|thread|reply|respond|follow[\s-]?up|message|mail)\b/i);
}

function isResearchIntent(input: string): boolean {
  return containsPattern(
    input,
    /\b(research|retrieval plan|collect|gather|find|latest annual report|quarterly filing|earnings release|investor presentation|primary sources?|sec|edgar|investor relations)\b/i
  );
}

function isProposalOrDocumentQuestion(input: string): boolean {
  return containsPattern(
    input,
    /\b(proposal|propose|proposed|document|uploaded|upload|file|pdf|docx|deck|report|scope|pricing|investment|roadmap|what did we propose|what was proposed)\b/i
  );
}

function maybeAdjustProjectAssistantRouting(
  input: string,
  context: {
    projectName?: string | null;
    surface?: SurfaceName;
  } | undefined,
  routing: RoutingTask[],
  primaryPersona: AgentName
): { routing: RoutingTask[]; primaryPersona: AgentName; mergeInstruction: string | null } {
  if (context?.surface !== 'project_assistant' || routing.length !== 1 || !isQuestionLikeMessage(input)) {
    return { routing, primaryPersona, mergeInstruction: null };
  }

  const firstTask = routing[0];
  if (!firstTask) {
    return { routing, primaryPersona, mergeInstruction: null };
  }

  if (firstTask.persona === 'EMAIL_ANALYST' && !isEmailFocusedQuestion(input) && isProposalOrDocumentQuestion(input)) {
    const adjustedTask: RoutingTask = {
      ...firstTask,
      persona: 'BUSINESS_ANALYST',
      subtask: [
        'Answer the user’s question directly using the project context and uploaded documents.',
        'Focus on what was proposed or stated in the relevant document.',
        'Respond in clear prose with concrete facts, scope, pricing, deliverables, and timeline where available.',
        'Do not add workflow status, client response status, or next-step recommendations unless the user explicitly asks for them.',
        'Do not return JSON, task extraction, or email-analysis fields unless the user explicitly asks for them.',
        `User question: ${input}`,
      ].join(' '),
      context: {
        ...firstTask.context,
        deliverable_type: 'report',
      },
    };

    return {
      routing: [adjustedTask],
      primaryPersona: 'BUSINESS_ANALYST',
      mergeInstruction: null,
    };
  }

  if (firstTask.persona === 'EMAIL_ANALYST' && !isEmailFocusedQuestion(input)) {
    const adjustedTask: RoutingTask = {
      ...firstTask,
      persona: 'EXECUTIVE_ASSISTANT',
      subtask: [
        'Answer the user’s question directly from the current project context.',
        'Provide a concise, decision-useful summary in normal prose.',
        'Do not add workflow status, client response status, or next-step recommendations unless the user explicitly asks for them.',
        'Do not return JSON or extract email-specific fields unless the user explicitly asks for them.',
        `User question: ${input}`,
      ].join(' '),
      context: {
        ...firstTask.context,
        deliverable_type: 'report',
      },
    };

    return {
      routing: [adjustedTask],
      primaryPersona: 'EXECUTIVE_ASSISTANT',
      mergeInstruction: null,
    };
  }

  return { routing, primaryPersona, mergeInstruction: null };
}

function coerceAgentName(value: string | undefined): AgentName {
  const normalized = (value || '').trim().toUpperCase().replace(/\s+/g, '_') as AgentName;
  return ALL_AGENT_NAMES.includes(normalized) ? normalized : 'EXECUTIVE_ASSISTANT';
}

function coerceTask(task: RawRoutingTask | undefined, fallbackSubtask: string, index: number): RoutingTask {
  return {
    id: `task_${index + 1}`,
    persona: coerceAgentName(task?.persona),
    subtask: task?.subtask?.trim() || fallbackSubtask,
    context: task?.context || {},
    depends_on: task?.depends_on?.trim() || null,
  };
}

function coerceDeferredAction(value: Record<string, unknown>, index: number): DeferredAction {
  const rawType = typeof value.action_type === 'string' ? value.action_type : 'other';
  const action_type = ['email', 'calendar_event', 'save_to_drive', 'save_to_project_documents', 'invoice_send', 'other'].includes(rawType)
    ? (rawType as DeferredAction['action_type'])
    : 'other';

  return {
    id: typeof value.id === 'string' ? value.id : `deferred_${index + 1}`,
    action_type,
    title: typeof value.title === 'string' ? value.title : null,
    recipient_email: typeof value.recipient_email === 'string' ? value.recipient_email : null,
    recipient_name: typeof value.recipient_name === 'string' ? value.recipient_name : null,
    drive_folder: typeof value.drive_folder === 'string' ? value.drive_folder : null,
    payload: typeof value.payload === 'object' && value.payload ? (value.payload as Record<string, unknown>) : value,
  };
}

function coerceAttachment(value: Record<string, unknown>): AttachmentToIngest {
  return {
    name:
      typeof value.filename === 'string'
        ? value.filename
        : typeof value.name === 'string'
          ? value.name
          : 'Attachment',
    mime_type:
      typeof value.type === 'string'
        ? value.type
        : typeof value.mime_type === 'string'
          ? value.mime_type
          : null,
    source_url:
      typeof value.file_url === 'string'
        ? value.file_url
        : typeof value.source_url === 'string'
          ? value.source_url
          : null,
    thread_id:
      typeof value.email_thread_id === 'string'
        ? value.email_thread_id
        : typeof value.thread_id === 'string'
          ? value.thread_id
          : null,
    project_id: typeof value.project_id === 'string' ? value.project_id : null,
  };
}

function collectTaskAttachments(tasks: RoutingTask[]): AttachmentToIngest[] {
  return tasks.flatMap((task) => {
    const raw = Array.isArray(task.context.attachments_to_ingest) ? task.context.attachments_to_ingest : [];
    return raw
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .map(coerceAttachment);
  });
}

export async function routeMessage(
  input: string,
  context?: {
    projectName?: string | null;
    surface?: SurfaceName;
    hasAttachments?: boolean;
    attachments?: UploadedAttachmentMeta[];
    history?: ChatMessage[];
  }
): Promise<RoutingDecision> {

  // ---- Receipt extraction shortcut ----
  if (context?.hasAttachments && context.attachments?.length) {

    const imageAttachment = context.attachments.find(
      (a) => a.mimeType && a.mimeType.startsWith("image/")
    );

    if (imageAttachment) {
      return {
        complexity: "SIMPLE",
        primary_persona: "DOCUMENT_GENERATOR",
        routing: [
          {
            id: "task_1",
            persona: "DOCUMENT_GENERATOR",
            subtask: "Extract receipt data from uploaded image",
            context: {
              receipt_extraction: true,
              attachment: imageAttachment
            },
            depends_on: null
          }
        ],
        merge_instruction: null,
        requires_approval: false,
        deferred_actions: [],
        attachments_to_ingest: []
      };
    }
  }

  const system = getSpecialPrompt('ORCHESTRATOR');
  const routingConfig = SPECIAL_PROMPT_CONFIG.ORCHESTRATOR;

  const historyMessages = (context?.history || [])
    .filter(
      (message): message is ChatMessage & { role: 'user' | 'assistant' } =>
        message.role === 'user' || message.role === 'assistant'
    )
    .slice(-10)
    .map((message) => ({
      role: message.role,
      content: message.content,
    }));

  const raw = await generateJson<RawRoutingDecision>({
    system,
    messages: [
      ...historyMessages,
      {
        role: 'user',
        content: [
          context?.projectName ? `Project context: ${context.projectName}` : '',
          context?.surface ? `Surface: ${context.surface}` : '',
          context?.hasAttachments ? 'The user attached one or more files.' : '',
          context?.attachments?.length
            ? `Attachments: ${context.attachments
                .map((attachment) =>
                  `${attachment.name}${attachment.mimeType ? ` (${attachment.mimeType})` : ''}`
                )
                .join(', ')}`
            : '',
          `Message: ${input}`,
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ],
    maxTokens: routingConfig.maxTokens,
    temperature: routingConfig.temperature,
    preferredProvider: 'anthropic',
    model: getAnthropicModelForTier(routingConfig.modelTier),
  });

  const routing =
    Array.isArray(raw.routing) && raw.routing.length > 0
      ? raw.routing.map((task, index) => coerceTask(task, input, index))
      : [coerceTask(undefined, input, 0)];

  const inferredRequiresApproval = routing.some((task) =>
    shouldRequireApproval(task)
  );

  const deferred_actions = Array.isArray(raw.deferred_actions)
    ? raw.deferred_actions.map((item, index) =>
        coerceDeferredAction(item, index)
      )
    : [];

  const attachments_to_ingest = [
    ...(Array.isArray(raw.attachments_to_ingest)
      ? raw.attachments_to_ingest.map(coerceAttachment)
      : []),
    ...collectTaskAttachments(routing),
  ];

  const primary_persona = coerceAgentName(raw.primary_persona);
  const adjusted = maybeAdjustProjectAssistantRouting(
    input,
    context,
    routing,
    primary_persona
  );

  const researchOverride =
    isResearchIntent(input) &&
    !containsPattern(
      input,
      /\b(send|email|reply|schedule|create event|book meeting)\b/i
    )
      ? {
          complexity: 'COMPLEX' as const,
          primary_persona: 'RESEARCH_AGENT' as AgentName,
          routing: [
            {
              id: 'task_1',
              persona: 'RESEARCH_AGENT' as AgentName,
              subtask: input,
              context: {
                projectName: context?.projectName || null,
                surface: context?.surface || null,
                deliverable_type: 'research_plan',
              },
              depends_on: null,
            },
          ],
          merge_instruction: null,
          requires_approval: true,
          deferred_actions: [],
          attachments_to_ingest: [],
        }
      : null;

  if (researchOverride) {
    return researchOverride;
  }

  return {
    complexity:
      raw.complexity === 'COMPLEX' || raw.complexity === 'MODERATE'
        ? raw.complexity
        : 'SIMPLE',
    primary_persona: adjusted.primaryPersona,
    routing: adjusted.routing,
    merge_instruction:
      adjusted.mergeInstruction ?? raw.merge_instruction?.trim() ?? null,
    requires_approval:
      typeof raw.requires_approval === 'boolean'
        ? raw.requires_approval || inferredRequiresApproval
        : inferredRequiresApproval,
    deferred_actions,
    attachments_to_ingest,
  };
}