import { db } from '@/lib/db';
import { buildProjectMemoryEvidence, searchProjectMemory } from '@/lib/assistant/project-semantic-memory';
import { ensureAssistantRuntimeTables } from '@/lib/assistant/schema';

interface ProjectIdentityRow {
  id: string;
  name: string | null;
  title: string | null;
  description: string | null;
  status: string | null;
  created_at: string;
  linked_contacts: unknown;
  metadata: Record<string, unknown> | null;
}

interface ProjectContextOptions {
  emailLimit?: number | null;
  completedTaskLimit?: number | null;
  docSummaryLimit?: number | null;
  includeDeepDocs?: boolean;
}

interface ProjectMetadata {
  clientEntity?: string | null;
  projectType?: string | null;
  startDate?: string | null;
  targetCompletion?: string | null;
  engagementValue?: string | null;
  projectOwner?: string | null;
  clients?: unknown;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => String(item ?? '').trim()).filter(Boolean);
}

function estimateTokens(input: string): number {
  return Math.ceil(input.length / 4);
}

function collectClientLines(project: ProjectIdentityRow, members: Array<{ email: string | null; name: string | null }>): string[] {
  const lines = new Set<string>();

  const linkedContacts = normalizeStringArray(project.linked_contacts);
  linkedContacts.forEach((value) => lines.add(value));

  const metadata = (project.metadata || {}) as ProjectMetadata;
  if (typeof metadata.clientEntity === 'string' && metadata.clientEntity.trim()) {
    lines.add(metadata.clientEntity.trim());
  }

  const metadataClients = Array.isArray(metadata.clients) ? metadata.clients : [];
  for (const entry of metadataClients) {
    if (!entry || typeof entry !== 'object') continue;
    const client = entry as Record<string, unknown>;
    const name = typeof client.name === 'string' ? client.name.trim() : '';
    const email = typeof client.email === 'string' ? client.email.trim() : '';
    const company = typeof client.company === 'string' ? client.company.trim() : '';
    const timezone = typeof client.timezone === 'string' ? client.timezone.trim() : '';
    const label = [
      name || 'Client',
      email ? `<${email}>` : '',
      company ? `— ${company}` : '',
      timezone ? `(${timezone})` : '',
    ]
      .filter(Boolean)
      .join(' ');
    if (label.trim()) {
      lines.add(label.trim());
    }
  }

  return [...lines];
}

function formatStoredDate(value: string | null | undefined): string {
  if (!value) {
    return 'Not specified';
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toISOString();
}

function trimCompletedTasks<T>(tasks: T[], limit: number | null | undefined): T[] {
  if (limit == null || tasks.length <= limit) {
    return tasks;
  }
  return tasks.slice(Math.max(0, tasks.length - limit));
}

function formatStorageProvider(value: string | null): string {
  if (value === 'google_drive') return 'google drive';
  if (value === 'onedrive') return 'onedrive';
  if (value === 'local' || !value) return 'workspace';
  return value;
}

async function loadProject(projectId: string): Promise<ProjectIdentityRow | null> {
  return db.queryOne<ProjectIdentityRow>(
    `SELECT id, name, title, description, status, created_at, linked_contacts, metadata
     FROM projects
     WHERE id = $1`,
    [projectId]
  );
}

async function buildProjectContextInternal(projectId: string, userQuery: string, options: ProjectContextOptions): Promise<string> {
  await ensureAssistantRuntimeTables();

  const project = await loadProject(projectId);
  if (!project) {
    return '';
  }

  const projectMembers = await db.query<{
    email: string | null;
    name: string | null;
    role: string | null;
    responsibilities: string | null;
    access_level: string | null;
  }>(
    `SELECT email, name, role, responsibilities, access_level
     FROM project_members
     WHERE project_id = $1
     ORDER BY invited_at ASC`,
    [projectId]
  );

  const emailThreads = await db.query<{
    thread_subject: string;
    participants: string | null;
    summary: string;
    reply_needed: boolean;
    reply_urgency: string | null;
    last_message_at: string | null;
  }>(
    `SELECT thread_subject, participants, summary, reply_needed, reply_urgency, last_message_at
     FROM project_email_summaries
     WHERE project_id = $1
     ORDER BY last_message_at DESC NULLS LAST, updated_at DESC`,
    [projectId]
  );

  const meetingRows = await db.query<{
    title: string | null;
    meeting_date: string | null;
    attendees: string | null;
    summary: string | null;
    decisions: unknown;
    action_items: unknown;
  }>(
    `SELECT title, meeting_date, attendees, summary, decisions, action_items
     FROM project_meeting_notes
     WHERE project_id = $1
     ORDER BY meeting_date DESC NULLS LAST, created_at DESC`,
    [projectId]
  );

  const legacyMeetings =
    meetingRows.length === 0
      ? await db.query<{
          title: string | null;
          meeting_date: string | null;
          content: string | null;
        }>(
          `SELECT title, meeting_date, content
           FROM client_meeting_notes
           WHERE project_id = $1
           ORDER BY meeting_date DESC NULLS LAST, created_at DESC`,
          [projectId]
        )
      : [];

  const tasks = await db.query<{
    title: string;
    description: string | null;
    status: string;
    priority: string;
    due_at: string | null;
    completed_at: string | null;
    created_at: string;
  }>(
    `SELECT title, description, status::text as status, priority::text as priority, due_at, completed_at, created_at
     FROM todo
     WHERE project_id = $1
     ORDER BY created_at ASC`,
    [projectId]
  );

  const docs = await db.query<{
    id: string;
    file_name: string;
    file_type: string | null;
    summary: string | null;
    full_text: string | null;
    storage_provider: string | null;
    created_at: string;
  }>(
    `SELECT id, file_name, file_type, summary, full_text, storage_provider, created_at
     FROM project_documents
     WHERE project_id = $1
     ORDER BY created_at DESC`,
    [projectId]
  );

  const projectMetadata = (project.metadata || {}) as ProjectMetadata;
  const clients = collectClientLines(project, projectMembers);
  const identityLines = [
    '=== PROJECT MEMORY ===',
    `Project: ${project.title || project.name || 'Untitled project'}`,
    `Description: ${project.description || 'Not specified'}`,
    `Status: ${project.status || 'unknown'}`,
    `Project type: ${projectMetadata.projectType || 'Not specified'}`,
    `Started: ${formatStoredDate(projectMetadata.startDate || project.created_at)}`,
    `Target completion: ${formatStoredDate(projectMetadata.targetCompletion)}`,
    `Engagement value: ${projectMetadata.engagementValue || 'Not specified'}`,
    `Project owner: ${projectMetadata.projectOwner || 'Not specified'}`,
    clients.length > 0 ? `Clients:\n${clients.map((line) => `  ${line}`).join('\n')}` : 'Clients: Not specified',
    projectMembers.length > 0
      ? `Team roster:\n${projectMembers
          .map((member) =>
            `  ${member.name || 'Unnamed'} <${member.email || 'unknown'}>${member.role ? ` — ${member.role}` : ''}${
              member.responsibilities ? ` · ${member.responsibilities}` : ''
            }${member.access_level ? ` · Access: ${member.access_level}` : ''}`
          )
          .join('\n')}`
      : 'Team roster: No team members yet.',
  ];

  const visibleEmailThreads = options.emailLimit == null ? emailThreads : emailThreads.slice(0, options.emailLimit);
  const emailBlock = visibleEmailThreads.length > 0
    ? visibleEmailThreads
        .map((thread) =>
          [
            `[${thread.last_message_at || 'undated'}] ${thread.thread_subject}`,
            `Participants: ${thread.participants || 'Not recorded'}`,
            `Summary: ${thread.summary}`,
            thread.reply_needed ? `Reply needed: ${thread.reply_urgency || 'unspecified'}` : '',
          ]
            .filter(Boolean)
            .join('\n')
        )
        .join('\n\n')
    : 'No email history yet.';

  const meetingEntries = [
    ...meetingRows.map((meeting) =>
      [
        `[${meeting.meeting_date || 'undated'}] ${meeting.title || 'Meeting'}${meeting.attendees ? ` | Attendees: ${meeting.attendees}` : ''}`,
        `Summary: ${meeting.summary || 'No summary recorded.'}`,
        normalizeStringArray(meeting.decisions).length > 0 ? `Decisions: ${normalizeStringArray(meeting.decisions).join(' · ')}` : '',
        normalizeStringArray(meeting.action_items).length > 0 ? `Action items: ${normalizeStringArray(meeting.action_items).join(' · ')}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    ),
    ...legacyMeetings.map((meeting) =>
      [`[${meeting.meeting_date || 'undated'}] ${meeting.title || 'Meeting'}`, `Summary: ${meeting.content || 'No notes recorded.'}`]
        .filter(Boolean)
        .join('\n')
    ),
  ];

  const meetingBlock = meetingEntries.length > 0 ? meetingEntries.join('\n\n') : 'No meeting notes yet.';

  const openTasks = tasks.filter((task) => task.status !== 'done' && task.status !== 'completed');
  const completedTasks = trimCompletedTasks(
    tasks.filter((task) => task.status === 'done' || task.status === 'completed'),
    options.completedTaskLimit
  );

  const taskBlock = [
    openTasks.length > 0
      ? `OPEN (${openTasks.length}):\n${openTasks
          .map(
            (task) =>
              `- [${task.priority}] ${task.title}${task.due_at ? ` · Due: ${task.due_at}` : ''}${task.description ? ` · ${task.description}` : ''}`
          )
          .join('\n')}`
      : 'No open tasks.',
    completedTasks.length > 0
      ? `COMPLETED (${completedTasks.length}):\n${completedTasks
          .map((task) => `- ${task.title}${task.completed_at ? ` · Done: ${task.completed_at}` : ''}`)
          .join('\n')}`
      : 'No completed tasks yet.',
  ].join('\n\n');

  const visibleDocs = options.docSummaryLimit == null ? docs : docs.slice(0, options.docSummaryLimit);
  const docSummaries = visibleDocs.length > 0
    ? visibleDocs
        .map(
          (doc) =>
            `- [${formatStorageProvider(doc.storage_provider)}] ${doc.file_name} (${doc.file_type || 'unknown'}) — ${doc.created_at}\n  ${doc.summary || 'No summary available.'}`
        )
        .join('\n\n')
    : 'No documents yet.';

  const semanticDocHits =
    userQuery && options.includeDeepDocs !== false
      ? await searchProjectMemory({
          projectId,
          query: userQuery,
          topK: 6,
          sourceTypes: ['document'],
          refresh: false,
        })
      : [];
  const deepDocEvidence = buildProjectMemoryEvidence(semanticDocHits, 3);
  const deepDocContext = deepDocEvidence.length > 0
    ? `\n\nMOST RELEVANT DOCUMENT EXCERPTS (semantic match):\n${deepDocEvidence
        .map((entry) => `-- ${entry.sourceTitle} [${entry.label}] --\n${entry.excerpts.join('\n\n')}`)
        .join('\n\n')}`
    : '';

  return [
    identityLines.join('\n'),
    `\n-- EMAIL HISTORY (${visibleEmailThreads.length}) --\n${emailBlock}`,
    `\n-- MEETING NOTES (${meetingEntries.length}) --\n${meetingBlock}`,
    `\n-- TASKS --\n${taskBlock}`,
    `\n-- DOCUMENTS (${visibleDocs.length}) --\n${docSummaries}${deepDocContext}`,
    '=== END PROJECT MEMORY ===',
  ].join('\n');
}

export async function buildProjectContext(projectId: string, userQuery: string): Promise<string> {
  return buildProjectContextInternal(projectId, userQuery, {
    emailLimit: null,
    completedTaskLimit: null,
    docSummaryLimit: null,
    includeDeepDocs: true,
  });
}

export async function buildProjectContextWithinBudget(projectId: string, userQuery: string, maxTokens = 180000): Promise<string> {
  const fullContext = await buildProjectContext(projectId, userQuery);
  if (estimateTokens(fullContext) <= maxTokens) {
    return fullContext;
  }

  const fallbackBudgets = [
    { emailLimit: 30, docSummaryLimit: 40 },
    { emailLimit: 20, docSummaryLimit: 30 },
    { emailLimit: 10, docSummaryLimit: 20 },
    { emailLimit: 5, docSummaryLimit: 10 },
    { emailLimit: 3, docSummaryLimit: 5 },
    { emailLimit: 1, docSummaryLimit: 3 },
  ];

  let smallestContext = fullContext;

  for (const budget of fallbackBudgets) {
    const trimmed = await buildProjectContextInternal(projectId, userQuery, {
      completedTaskLimit: null,
      emailLimit: budget.emailLimit,
      docSummaryLimit: budget.docSummaryLimit,
      includeDeepDocs: false,
    });
    smallestContext = trimmed;
    if (estimateTokens(trimmed) <= maxTokens) {
      return trimmed;
    }
  }

  return `${smallestContext.slice(0, maxTokens * 4 - 64).trim()}\n\n[TRUNCATED FOR CONTEXT BUDGET]`;
}
