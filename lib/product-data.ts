import { db } from '@/lib/db';
import { getAssistantProfile } from '@/lib/assistant-profile';
import { listConversations } from '@/lib/assistant/conversations';
import { listPendingApprovalActions } from '@/lib/assistant/approvals';
import { ensureAssistantRuntimeTables } from '@/lib/assistant/schema';
import { fetchGoogleCalendarEvents, type CalendarEventSummary } from '@/lib/google/calendar';
import { fetchGmailInbox, fetchGmailInboxPage, type GmailThreadSummary } from '@/lib/google/gmail';
import { getPrimaryNylasGrant, isNylasConfigured } from '@/lib/nylas/client';
import { ensureClientProjectLinksTable, ensureClientsTable, ensureProjectScopedFinanceColumns, ensureServicesTable } from '@/lib/workspace/schema';
import { setProjectClient } from '@/lib/workspace/project-links';

export interface ConnectedAccounts {
  emailConnected: boolean;
  calendarConnected: boolean;
  providerLabel: string | null;
  accountEmail: string | null;
  connectAvailable: boolean;
}

export interface DashboardData {
  onboardingReady: boolean;
  userTimezone: string;
  todayLabel: string;
  metrics: {
    activeProjects: number;
    pendingTasks: number;
    highPriority: number;
    overdue: number;
  };
  priorityEmails: GmailThreadSummary[];
  todayEvents: CalendarEventSummary[];
  recentApprovals: Awaited<ReturnType<typeof listPendingApprovalActions>>;
  quickActions: Array<{ title: string; description: string; href: string }>;
  upcomingTasks: Array<{
    id: string;
    title: string;
    projectName: string | null;
    dueLabel: string;
    priority: string;
  }>;
}

export interface ProjectListItem {
  id: string;
  name: string;
  description: string | null;
  status: string;
  openTasks: number;
  documentCount: number;
  clientEntity: string | null;
  targetCompletion: string | null;
  projectType: string | null;
}

export interface ClientListItem {
  id: string;
  name: string;
  timezone: string | null;
  company: string | null;
  primaryEmail: string | null;
  website: string | null;
  location: string | null;
  relationshipNotes: string | null;
  enrichmentSummary: string | null;
  enrichmentSources: Array<{ title: string; url: string; snippet: string | null }>;
  recommendedServices: Array<{ serviceName: string; reasoning: string; priority: 'high' | 'medium' | 'low' }>;
  enrichmentUpdatedAt: string | null;
  recommendationsUpdatedAt: string | null;
}

export interface ClientMeetingItem {
  id: string;
  title: string;
  meetingDate: string | null;
  content: string | null;
  projectId: string | null;
  projectName: string | null;
}

export interface ClientEmailSummaryItem {
  id: string;
  subject: string;
  summary: string;
  replyNeeded: boolean;
  lastMessageAt: string | null;
  projectId: string | null;
  projectName: string | null;
}

export interface ServiceListItem {
  id: string;
  name: string;
  code: string;
  category: string;
  description: string | null;
  estimatedDuration: string | null;
  basePrice: number | null;
  currency: string | null;
  isActive: boolean;
}

export interface ProjectDetailData {
  id: string;
  name: string;
  description: string | null;
  status: string;
  openTasks: number;
  summary: string | null;
  clientEntity: string | null;
  projectType: string | null;
  startDate: string | null;
  targetCompletion: string | null;
  engagementValue: string | null;
  projectOwner: string | null;
  linkedContacts: string[];
  milestones: Array<{
    title: string;
    targetDate: string | null;
    status: string;
  }>;
  teamMembers: Array<{
    name: string;
    email: string;
    role: string | null;
    responsibilities: string | null;
    accessLevel: string | null;
  }>;
  pendingInvites: Array<{
    name: string;
    role: string | null;
    reason: string;
  }>;
  documents: Array<{
    id: string;
    fileName: string;
    summary: string | null;
    storageProvider: string | null;
    createdAt: string;
  }>;
  todos: Array<{
    id: string;
    title: string;
    status: string;
    priority: string;
    dueAt: string | null;
  }>;
  meetings: Array<{
    id: string;
    title: string;
    meetingDate: string | null;
    content: string | null;
  }>;
  recentEmails: Array<{
    id: string;
    subject: string;
    summary: string;
    replyNeeded: boolean;
    lastMessageAt: string | null;
  }>;
  invoices: Array<{
    id: string;
    invoiceNumber: string;
    status: string;
    total: number;
    dueDate: string | null;
  }>;
  expenses: Array<{
    id: string;
    description: string;
    amount: number;
    entryDate: string;
  }>;
  approvals: Awaited<ReturnType<typeof listPendingApprovalActions>>;
  linkedClients: Array<{ id: string; name: string; timezone: string | null; primaryEmail: string | null }>;
}

function toNumber(value: string | number | null | undefined): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number(value);
  return 0;
}

function formatDueLabel(value: string | null): string {
  if (!value) return 'No due date';
  return new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatMeetingContent(summary: string | null, decisions: string[] = [], actionItems: string[] = []): string {
  return [
    summary || '',
    decisions.length > 0 ? `Decisions: ${decisions.join(' · ')}` : '',
    actionItems.length > 0 ? `Action items: ${actionItems.join(' · ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function getFormatter(timeZone: string, options: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat('en-US', { timeZone, ...options });
}

function getOffsetMinutes(date: Date, timeZone: string): number {
  const formatter = getFormatter(timeZone, {
    timeZoneName: 'shortOffset',
    hour: '2-digit',
  });
  const zone = formatter.formatToParts(date).find((part) => part.type === 'timeZoneName')?.value || 'GMT+00:00';
  const match = zone.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/i);
  if (!match) {
    return 0;
  }
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3] || 0));
}

function toUtcInTimezone(localDate: string, localTime: string, timeZone: string): Date {
  const [year, month, day] = localDate.split('-').map(Number);
  const [hour, minute] = localTime.split(':').map(Number);
  let utc = Date.UTC(year, month - 1, day, hour, minute);

  for (let index = 0; index < 3; index += 1) {
    const offset = getOffsetMinutes(new Date(utc), timeZone);
    const nextUtc = Date.UTC(year, month - 1, day, hour, minute) - offset * 60_000;
    if (Math.abs(nextUtc - utc) < 1_000) {
      utc = nextUtc;
      break;
    }
    utc = nextUtc;
  }

  return new Date(utc);
}

function getDateKeyInTimezone(date: Date, timeZone: string): string {
  const formatter = getFormatter(timeZone, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(date);
  const year = parts.find((part) => part.type === 'year')?.value || '1970';
  const month = parts.find((part) => part.type === 'month')?.value || '01';
  const day = parts.find((part) => part.type === 'day')?.value || '01';
  return `${year}-${month}-${day}`;
}

function readMetadataString(metadata: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export async function enrichInboxThreadsWithAssistantState(userId: string, items: GmailThreadSummary[]): Promise<GmailThreadSummary[]> {
  const threadIds = [...new Set(items.map((item) => item.threadId).filter(Boolean))];
  if (threadIds.length === 0) {
    return items;
  }

  const [todoRows, cacheRows] = await Promise.all([
    db.query<{ thread_id: string }>(
      `SELECT DISTINCT related_email_id AS thread_id
       FROM todo
       WHERE user_id = $1
         AND related_email_id = ANY($2::text[])`,
      [userId, threadIds]
    ),
    db.query<{ thread_id: string; meeting_requested: boolean }>(
      `SELECT thread_id,
              COALESCE((analysis->>'meeting_requested')::boolean, FALSE) AS meeting_requested
       FROM email_thread_analysis_cache
       WHERE user_id = $1
         AND thread_id = ANY($2::text[])`,
      [userId, threadIds]
    ),
  ]);

  const todoThreadIds = new Set(todoRows.map((row) => row.thread_id));
  const meetingThreadIds = new Set(cacheRows.filter((row) => row.meeting_requested === true).map((row) => row.thread_id));

  return items.map((item) => ({
    ...item,
    hasTodos: item.hasTodos === true || todoThreadIds.has(item.threadId),
    meetingRequested: item.meetingRequested === true || meetingThreadIds.has(item.threadId),
  }));
}

export async function getConnectedAccounts(userId: string): Promise<ConnectedAccounts> {
  await ensureAssistantRuntimeTables();
  const grant = await getPrimaryNylasGrant(userId);

  return {
    emailConnected: Boolean(grant?.grant_id),
    calendarConnected: Boolean(grant?.grant_id),
    providerLabel: grant?.provider || 'nylas',
    accountEmail: grant?.email || null,
    connectAvailable: isNylasConfigured(),
  };
}

export async function getClients(userId: string): Promise<ClientListItem[]> {
  await ensureClientsTable();
  const rows = await db.query<{
    id: string;
    name: string;
    timezone: string | null;
    company: string | null;
    primary_email: string | null;
    website: string | null;
    location: string | null;
    relationship_notes: string | null;
    enrichment_summary: string | null;
    enrichment_sources: unknown;
    recommended_services: unknown;
    enrichment_updated_at: string | null;
    recommendations_updated_at: string | null;
  }>(
    `SELECT id, name, timezone, company, primary_email, website, location, relationship_notes,
            enrichment_summary, enrichment_sources, recommended_services,
            enrichment_updated_at, recommendations_updated_at
     FROM clients
     WHERE user_id = $1
     ORDER BY name ASC`,
    [userId]
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    timezone: r.timezone || null,
    company: r.company || null,
    primaryEmail: r.primary_email || null,
    website: r.website || null,
    location: r.location || null,
    relationshipNotes: r.relationship_notes || null,
    enrichmentSummary: r.enrichment_summary || null,
    enrichmentSources: Array.isArray(r.enrichment_sources) ? (r.enrichment_sources as ClientListItem['enrichmentSources']) : [],
    recommendedServices: Array.isArray(r.recommended_services) ? (r.recommended_services as ClientListItem['recommendedServices']) : [],
    enrichmentUpdatedAt: r.enrichment_updated_at || null,
    recommendationsUpdatedAt: r.recommendations_updated_at || null,
  }));
}

export async function getClient(userId: string, clientId: string): Promise<ClientListItem | null> {
  await ensureClientsTable();
  const row = await db.queryOne<{
    id: string;
    name: string;
    timezone: string | null;
    company: string | null;
    primary_email: string | null;
    website: string | null;
    location: string | null;
    relationship_notes: string | null;
    enrichment_summary: string | null;
    enrichment_sources: unknown;
    recommended_services: unknown;
    enrichment_updated_at: string | null;
    recommendations_updated_at: string | null;
  }>(
    `SELECT id, name, timezone, company, primary_email, website, location, relationship_notes,
            enrichment_summary, enrichment_sources, recommended_services,
            enrichment_updated_at, recommendations_updated_at
     FROM clients
     WHERE id = $1 AND user_id = $2`,
    [clientId, userId]
  );
  return row
    ? {
        id: row.id,
        name: row.name,
        timezone: row.timezone || null,
        company: row.company || null,
        primaryEmail: row.primary_email || null,
        website: row.website || null,
        location: row.location || null,
        relationshipNotes: row.relationship_notes || null,
        enrichmentSummary: row.enrichment_summary || null,
        enrichmentSources: Array.isArray(row.enrichment_sources) ? (row.enrichment_sources as ClientListItem['enrichmentSources']) : [],
        recommendedServices: Array.isArray(row.recommended_services) ? (row.recommended_services as ClientListItem['recommendedServices']) : [],
        enrichmentUpdatedAt: row.enrichment_updated_at || null,
        recommendationsUpdatedAt: row.recommendations_updated_at || null,
      }
    : null;
}


export async function getClientProjects(userId: string, clientId: string): Promise<Array<{ id: string; name: string; status: string }>> {
  await ensureClientProjectLinksTable();
  const rows = await db.query<{ id: string; name: string; status: string }>(
    `SELECT DISTINCT p.id, COALESCE(p.title, p.name, 'Untitled Project') AS name, COALESCE(p.status::text, 'active') AS status
     FROM projects p
     LEFT JOIN client_project_links cpl
       ON cpl.project_id = p.id
      AND cpl.client_id = $2
      AND cpl.user_id = $1
     WHERE p.user_id = $1
       AND (
         cpl.project_id IS NOT NULL
         OR p.metadata->>'clientId' = $2
       )
     ORDER BY name ASC`,
    [userId, clientId]
  );
  return rows;
}

export async function setClientProjects(userId: string, clientId: string, projectIds: string[]): Promise<void> {
  await ensureClientProjectLinksTable();

  const wanted = [...new Set(projectIds.filter(Boolean))];
  const owned = wanted.length
    ? await db.query<{ id: string }>(`SELECT id FROM projects WHERE user_id = $1 AND id = ANY($2::text[])`, [userId, wanted])
    : [];
  const ownedIds = owned.map((project) => project.id);

  // Projects currently linked to this client (by link row or by metadata) that are no longer selected get unlinked.
  const currentlyLinked = await db.query<{ id: string }>(
    `SELECT id FROM projects
     WHERE user_id = $1
       AND (metadata->>'clientId' = $2
            OR id IN (SELECT project_id FROM client_project_links WHERE user_id = $1 AND client_id = $2))`,
    [userId, clientId]
  );
  for (const project of currentlyLinked) {
    if (!ownedIds.includes(project.id)) await setProjectClient(userId, project.id, null);
  }
  for (const projectId of ownedIds) {
    await setProjectClient(userId, projectId, clientId);
  }
}

export async function getClientContextData(userId: string, clientId: string): Promise<{
  linkedProjects: Array<{ id: string; name: string; status: string }>;
  upcomingMeetings: ClientMeetingItem[];
  previousMeetings: ClientMeetingItem[];
  emailSummaries: ClientEmailSummaryItem[];
}> {
  await ensureClientProjectLinksTable();
  await ensureAssistantRuntimeTables();

  const linkedProjects = await getClientProjects(userId, clientId);
  const projectIdSet = linkedProjects.map((project) => project.id);
  const client = await getClient(userId, clientId);
  const clientEmail = client?.primaryEmail || null;

  const [directMeetings, projectMeetings, directEmails, projectEmails] = await Promise.all([
    db.query<{ id: string; title: string | null; meeting_date: string | null; content: string | null; project_id: string | null }>(
      `SELECT id, title, meeting_date, content, project_id
       FROM client_meeting_notes
       WHERE user_id = $1 AND client_id = $2
       ORDER BY meeting_date DESC NULLS LAST, created_at DESC`,
      [userId, clientId]
    ),
    projectIdSet.length > 0
      ? db.query<{ id: string; title: string | null; meeting_date: string | null; summary: string | null; decisions: string[] | null; action_items: string[] | null; project_id: string; project_name: string | null }>(
          `SELECT pmn.id, pmn.title, pmn.meeting_date, pmn.summary, pmn.decisions, pmn.action_items, pmn.project_id,
                  COALESCE(p.title, p.name, 'Untitled Project') AS project_name
           FROM project_meeting_notes pmn
           INNER JOIN projects p ON p.id = pmn.project_id
           WHERE pmn.user_id = $1
             AND pmn.project_id = ANY($2::text[])
           ORDER BY pmn.meeting_date DESC NULLS LAST, pmn.created_at DESC`,
          [userId, projectIdSet]
        )
      : Promise.resolve([]),
    clientEmail
      ? db.query<{ thread_id: string; thread_subject: string | null; summary: string | null; reply_needed: boolean | null; last_message_at: string | null }>(
          `SELECT thread_id,
                  thread_subject,
                  analysis->>'summary' AS summary,
                  COALESCE((analysis->>'reply_needed')::boolean, FALSE) AS reply_needed,
                  last_message_at
           FROM email_thread_analysis_cache
           WHERE user_id = $1
             AND thread_payload::text ILIKE '%' || $2 || '%'
           ORDER BY last_message_at DESC NULLS LAST, updated_at DESC
           LIMIT 8`,
          [userId, clientEmail]
        )
      : Promise.resolve([]),
    projectIdSet.length > 0
      ? db.query<{ thread_id: string; thread_subject: string | null; summary: string | null; reply_needed: boolean | null; last_message_at: string | null; project_id: string; project_name: string | null }>(
          `SELECT pes.thread_id, pes.thread_subject, pes.summary, pes.reply_needed, pes.last_message_at, pes.project_id,
                  COALESCE(p.title, p.name, 'Untitled Project') AS project_name
           FROM project_email_summaries pes
           INNER JOIN projects p ON p.id = pes.project_id
           WHERE p.user_id = $1
             AND pes.project_id = ANY($2::text[])
           ORDER BY pes.last_message_at DESC NULLS LAST, pes.updated_at DESC
           LIMIT 12`,
          [userId, projectIdSet]
        )
      : Promise.resolve([]),
  ]);

  const projectNameMap = new Map(linkedProjects.map((project) => [project.id, project.name]));
  const now = Date.now();

  const allMeetings: ClientMeetingItem[] = [
    ...directMeetings.map((meeting) => ({
      id: meeting.id,
      title: meeting.title || 'Meeting',
      meetingDate: meeting.meeting_date,
      content: meeting.content,
      projectId: meeting.project_id,
      projectName: meeting.project_id ? projectNameMap.get(meeting.project_id) || null : null,
    })),
    ...projectMeetings.map((meeting) => ({
      id: meeting.id,
      title: meeting.title || 'Meeting',
      meetingDate: meeting.meeting_date,
      content: formatMeetingContent(meeting.summary, meeting.decisions || [], meeting.action_items || []),
      projectId: meeting.project_id,
      projectName: meeting.project_name || projectNameMap.get(meeting.project_id) || null,
    })),
  ].filter((meeting, index, array) => array.findIndex((item) => item.id === meeting.id) === index);

  const upcomingMeetings = allMeetings
    .filter((meeting) => meeting.meetingDate && new Date(meeting.meetingDate).getTime() >= now)
    .sort((a, b) => new Date(a.meetingDate || 0).getTime() - new Date(b.meetingDate || 0).getTime());

  const previousMeetings = allMeetings
    .filter((meeting) => !meeting.meetingDate || new Date(meeting.meetingDate).getTime() < now)
    .sort((a, b) => new Date(b.meetingDate || 0).getTime() - new Date(a.meetingDate || 0).getTime());

  const emailSummaries: ClientEmailSummaryItem[] = [
    ...directEmails.map((email) => ({
      id: email.thread_id,
      subject: email.thread_subject || 'Email thread',
      summary: email.summary || 'No summary available.',
      replyNeeded: Boolean(email.reply_needed),
      lastMessageAt: email.last_message_at,
      projectId: null,
      projectName: null,
    })),
    ...projectEmails.map((email) => ({
      id: email.thread_id,
      subject: email.thread_subject || 'Email thread',
      summary: email.summary || 'No summary available.',
      replyNeeded: Boolean(email.reply_needed),
      lastMessageAt: email.last_message_at,
      projectId: email.project_id,
      projectName: email.project_name || projectNameMap.get(email.project_id) || null,
    })),
  ].filter((email, index, array) => array.findIndex((item) => item.id === email.id) === index)
   .sort((a, b) => new Date(b.lastMessageAt || 0).getTime() - new Date(a.lastMessageAt || 0).getTime())
   .slice(0, 8);

  return {
    linkedProjects,
    upcomingMeetings,
    previousMeetings,
    emailSummaries,
  };
}

export async function getServices(userId: string): Promise<ServiceListItem[]> {
  await ensureServicesTable();
  const rows = await db.query<{
    id: string;
    name: string;
    code: string;
    category: string;
    description: string | null;
    estimated_duration: string | null;
    base_price: string | number | null;
    currency: string | null;
    is_active: boolean;
  }>(
    `SELECT id, name, code, category, description, estimated_duration, base_price, currency, is_active
     FROM services
     WHERE user_id = $1
     ORDER BY is_active DESC, category ASC, name ASC`,
    [userId]
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    code: row.code,
    category: row.category,
    description: row.description || null,
    estimatedDuration: row.estimated_duration || null,
    basePrice: row.base_price === null ? null : Number(row.base_price),
    currency: row.currency || null,
    isActive: row.is_active,
  }));
}

export async function getDashboardData(userId: string): Promise<DashboardData> {
  const [profile, metrics, tasks, approvals, emails] = await Promise.all([
    getAssistantProfile(userId),
    db.queryOne<{
      active_projects: number;
      pending_tasks: number;
      high_priority: number;
      overdue: number;
    }>(
      `SELECT
        (SELECT COUNT(*)::int FROM projects WHERE user_id = $1 AND COALESCE(status, 'active') <> 'archived') AS active_projects,
        (SELECT COUNT(*)::int FROM todo WHERE user_id = $1 AND status::text NOT IN ('done', 'completed')) AS pending_tasks,
        (SELECT COUNT(*)::int FROM todo WHERE user_id = $1 AND status::text NOT IN ('done', 'completed') AND priority::text = 'high') AS high_priority,
        (SELECT COUNT(*)::int FROM todo WHERE user_id = $1 AND status::text NOT IN ('done', 'completed') AND due_at IS NOT NULL AND due_at < NOW()) AS overdue`,
      [userId]
    ),
    db.query<{
      id: string;
      title: string;
      priority: string;
      due_at: string | null;
      project_name: string | null;
    }>(
      `SELECT todo.id, todo.title, todo.priority::text as priority, todo.due_at, projects.name as project_name
       FROM todo
       LEFT JOIN projects ON projects.id = todo.project_id
       WHERE todo.user_id = $1 AND todo.status::text NOT IN ('done', 'completed')
       ORDER BY todo.due_at ASC NULLS LAST, todo.created_at DESC
       LIMIT 6`,
      [userId]
    ),
    listPendingApprovalActions(userId),
    fetchGmailInbox(userId, 6),
  ]);

  const userTimezone = profile?.profile.user_timezone || 'UTC';
  const todayDateKey = getDateKeyInTimezone(new Date(), userTimezone);
  const dayStart = toUtcInTimezone(todayDateKey, '00:00', userTimezone);
  const nextDayDate = new Date(dayStart.getTime() + 36 * 60 * 60 * 1000);
  const nextDayDateKey = getDateKeyInTimezone(nextDayDate, userTimezone);
  const dayEnd = toUtcInTimezone(nextDayDateKey, '00:00', userTimezone);
  const events = await fetchGoogleCalendarEvents(userId, {
    timeMin: dayStart.toISOString(),
    timeMax: dayEnd.toISOString(),
    maxResults: 6,
  });

  return {
    onboardingReady: Boolean(profile),
    userTimezone,
    todayLabel: getFormatter(userTimezone, { weekday: 'long', month: 'short', day: 'numeric' }).format(new Date()),
    metrics: {
      activeProjects: metrics?.active_projects || 0,
      pendingTasks: metrics?.pending_tasks || 0,
      highPriority: metrics?.high_priority || 0,
      overdue: metrics?.overdue || 0,
    },
    priorityEmails: emails,
    todayEvents: events,
    recentApprovals: approvals,
    quickActions: [
      { title: 'Write a Proposal', description: 'Client-ready business proposal', href: '/assistant' },
      { title: 'Create Invoice', description: 'Professional invoice with line items', href: '/assistant' },
      { title: 'Review Contract', description: 'Risk analysis and negotiation brief', href: '/assistant' },
      {
        title: 'New Project',
        description: 'Set up project with team and milestones',
        href: `/assistant?prompt=${encodeURIComponent('Create a new project record with milestones and an initial team roster.')}`,
      },
      { title: 'Financial Analysis', description: 'Valuation, due diligence, models', href: '/assistant' },
      { title: 'Strategy Advice', description: 'Pricing, positioning, negotiation', href: '/assistant' },
    ],
    upcomingTasks: tasks.map((task) => ({
      id: task.id,
      title: task.title,
      projectName: task.project_name,
      dueLabel: formatDueLabel(task.due_at),
      priority: task.priority,
    })),
  };
}

export async function getAssistantData(userId: string, projectId?: string | null) {
  const [profile, conversations, approvals] = await Promise.all([
    getAssistantProfile(userId),
    listConversations(userId, projectId),
    listPendingApprovalActions(userId, projectId),
  ]);

  return {
    profile,
    conversations,
    approvals,
  };
}

export async function getEmailHubData(userId: string) {
  const [accounts, inboxPage] = await Promise.all([getConnectedAccounts(userId), fetchGmailInboxPage(userId, { limit: 20 })]);
  const enrichedInbox = await enrichInboxThreadsWithAssistantState(userId, inboxPage.items);

  return {
    accounts,
    inbox: enrichedInbox,
    nextCursor: inboxPage.nextCursor,
  };
}

export async function listProjects(userId: string): Promise<ProjectListItem[]> {
  const rows = await db.query<{
    id: string;
    name: string | null;
    title: string | null;
    description: string | null;
    status: string | null;
    metadata: Record<string, unknown> | null;
    open_tasks: number;
    document_count: number;
  }>(
    `SELECT
      p.id,
      p.name,
      p.title,
      p.description,
      COALESCE(p.status, 'active') AS status,
      p.metadata,
      COALESCE(t.open_tasks, 0)::int AS open_tasks,
      COALESCE(d.document_count, 0)::int AS document_count
     FROM projects p
     LEFT JOIN (
       SELECT project_id, COUNT(*) FILTER (WHERE status::text NOT IN ('done', 'completed', 'archived')) AS open_tasks
       FROM todo
       WHERE user_id = $1
       GROUP BY project_id
     ) t ON t.project_id = p.id
     LEFT JOIN (
       SELECT project_id, COUNT(*) AS document_count
       FROM project_documents
       GROUP BY project_id
     ) d ON d.project_id = p.id
     WHERE p.user_id = $1
     ORDER BY p.updated_at DESC NULLS LAST, p.created_at DESC`,
    [userId]
  );

  return rows.map((row) => ({
    id: row.id,
    name: row.title || row.name || 'Untitled Project',
    description: row.description,
    status: row.status || 'active',
    openTasks: row.open_tasks,
    documentCount: row.document_count,
    clientEntity:
      row.metadata && typeof row.metadata === 'object' && typeof (row.metadata as Record<string, unknown>).clientEntity === 'string'
        ? ((row.metadata as Record<string, unknown>).clientEntity as string)
        : null,
    targetCompletion:
      row.metadata && typeof row.metadata === 'object' && typeof (row.metadata as Record<string, unknown>).targetCompletion === 'string'
        ? ((row.metadata as Record<string, unknown>).targetCompletion as string)
        : null,
    projectType:
      row.metadata && typeof row.metadata === 'object' && typeof (row.metadata as Record<string, unknown>).projectType === 'string'
        ? ((row.metadata as Record<string, unknown>).projectType as string)
        : null,
  }));
}

export async function getProjectDetail(userId: string, projectId: string): Promise<ProjectDetailData | null> {
  await ensureProjectScopedFinanceColumns();
  await ensureAssistantRuntimeTables();
  await ensureClientProjectLinksTable();

  const project = await db.queryOne<{
    id: string;
    name: string | null;
    title: string | null;
    description: string | null;
    status: string | null;
    summary: string | null;
    linked_contacts: string[] | null;
    metadata: Record<string, unknown> | null;
  }>(
    `SELECT id, name, title, description, status, summary, linked_contacts, metadata
     FROM projects
     WHERE user_id = $1 AND id = $2`,
    [userId, projectId]
  );

  if (!project) {
    return null;
  }

  const [documents, todos, meetings, legacyMeetings, recentEmails, invoices, expenses, approvals, teamMembers] = await Promise.all([
    db.query<{ id: string; file_name: string; summary: string | null; storage_provider: string | null; created_at: string }>(
      `SELECT id, file_name, summary, storage_provider, created_at
       FROM project_documents
       WHERE project_id = $1
       ORDER BY created_at DESC`,
      [projectId]
    ),
    db.query<{ id: string; title: string; status: string; priority: string; due_at: string | null }>(
      `SELECT id, title, status::text as status, priority::text as priority, due_at
       FROM todo
       WHERE user_id = $1 AND project_id = $2
       ORDER BY due_at ASC NULLS LAST, created_at DESC`,
      [userId, projectId]
    ),
    db.query<{ id: string; title: string | null; meeting_date: string | null; summary: string | null; decisions: string[] | null; action_items: string[] | null }>(
      `SELECT id, title, meeting_date, summary, decisions, action_items
       FROM project_meeting_notes
       WHERE user_id = $1 AND project_id = $2
       ORDER BY meeting_date DESC NULLS LAST, created_at DESC`,
      [userId, projectId]
    ),
    db.query<{ id: string; title: string | null; meeting_date: string | null; content: string | null }>(
      `SELECT id, title, meeting_date, content
       FROM client_meeting_notes
       WHERE user_id = $1 AND project_id = $2
       ORDER BY meeting_date DESC NULLS LAST, created_at DESC`,
      [userId, projectId]
    ),
    db.query<{ thread_id: string; thread_subject: string | null; summary: string | null; reply_needed: boolean | null; last_message_at: string | null }>(
      `SELECT thread_id, thread_subject, summary, reply_needed, last_message_at
       FROM project_email_summaries
       WHERE project_id = $1
       ORDER BY last_message_at DESC NULLS LAST, updated_at DESC
       LIMIT 6`,
      [projectId]
    ),
    db.query<{ id: string; invoice_number: string; status: string; total: string; due_date: string | null }>(
      `SELECT i.id, i.invoice_number, i.status, i.total::text as total, i.due_date
       FROM invoices i
       WHERE i.user_id = $1 AND i.project_id = $2
       ORDER BY i.created_at DESC
       LIMIT 8`,
      [userId, projectId]
    ),
    db.query<{ id: string; description: string; amount: string; entry_date: string }>(
      `SELECT id, description, amount::text as amount, entry_date
       FROM pnl_entries
       WHERE user_id = $1 AND type = 'expense' AND project_id = $2
       ORDER BY created_at DESC
       LIMIT 8`,
      [userId, projectId]
    ),
    listPendingApprovalActions(userId, projectId),
    db.query<{ name: string | null; email: string; role: string | null; responsibilities: string | null; access_level: string | null }>(
      `SELECT name, email, role, responsibilities, access_level
       FROM project_members
       WHERE project_id = $1
       ORDER BY invited_at ASC, name ASC`,
      [projectId]
    ),
  ]);

  const projectMetadata = project.metadata || {};
  const linkedClients = await db.query<{ id: string; name: string; timezone: string | null; primary_email: string | null }>(
    `SELECT c.id, c.name, c.timezone, c.primary_email
     FROM client_project_links cpl
     INNER JOIN clients c ON c.id = cpl.client_id
     WHERE cpl.user_id = $1 AND cpl.project_id = $2
     ORDER BY c.name ASC`,
    [userId, projectId]
  );

  const milestones = Array.isArray(projectMetadata.milestones)
    ? projectMetadata.milestones
        .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
        .map((entry) => ({
          title: typeof entry.title === 'string' ? entry.title : 'Milestone',
          targetDate: typeof entry.targetDate === 'string' ? entry.targetDate : null,
          status: typeof entry.status === 'string' ? entry.status : 'Not Started',
        }))
    : [];

  return {
    id: project.id,
    name: project.title || project.name || 'Untitled Project',
    description: project.description,
    status: project.status || 'active',
    openTasks: todos.filter((todo) => todo.status !== 'done' && todo.status !== 'completed').length,
    summary: project.summary,
    clientEntity: readMetadataString(projectMetadata, 'clientEntity'),
    projectType: readMetadataString(projectMetadata, 'projectType'),
    startDate: readMetadataString(projectMetadata, 'startDate'),
    targetCompletion: readMetadataString(projectMetadata, 'targetCompletion'),
    engagementValue: readMetadataString(projectMetadata, 'engagementValue'),
    projectOwner: readMetadataString(projectMetadata, 'projectOwner'),
    linkedContacts: project.linked_contacts || [],
    milestones,
    teamMembers: teamMembers.map((member) => ({
      name: member.name || member.email,
      email: member.email,
      role: member.role,
      responsibilities: member.responsibilities,
      accessLevel: member.access_level,
    })),
    pendingInvites: Array.isArray(projectMetadata.pendingInvites)
      ? projectMetadata.pendingInvites
          .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
          .map((entry) => ({
            name: typeof entry.name === 'string' ? entry.name : 'Pending contact',
            role: typeof entry.role === 'string' ? entry.role : null,
            reason: typeof entry.reason === 'string' ? entry.reason : 'Missing information',
          }))
      : [],
    documents: documents.map((doc) => ({
      id: doc.id,
      fileName: doc.file_name,
      summary: doc.summary,
      storageProvider: doc.storage_provider,
      createdAt: doc.created_at,
    })),
    todos: todos.map((todo) => ({
      id: todo.id,
      title: todo.title,
      status: todo.status,
      priority: todo.priority,
      dueAt: todo.due_at,
    })),
    meetings:
      meetings.length > 0
        ? meetings.map((meeting) => ({
            id: meeting.id,
            title: meeting.title || 'Meeting',
            meetingDate: meeting.meeting_date,
            content: formatMeetingContent(meeting.summary, meeting.decisions || [], meeting.action_items || []),
          }))
        : legacyMeetings.map((meeting) => ({
            id: meeting.id,
            title: meeting.title || 'Meeting',
            meetingDate: meeting.meeting_date,
            content: meeting.content,
          })),
    recentEmails: recentEmails.map((email) => ({
      id: email.thread_id,
      subject: email.thread_subject || 'Email thread',
      summary: email.summary || 'No summary available.',
      replyNeeded: Boolean(email.reply_needed),
      lastMessageAt: email.last_message_at,
    })),
    invoices: invoices.map((invoice) => ({
      id: invoice.id,
      invoiceNumber: invoice.invoice_number,
      status: invoice.status,
      total: toNumber(invoice.total),
      dueDate: invoice.due_date,
    })),
    expenses: expenses.map((expense) => ({
      id: expense.id,
      description: expense.description,
      amount: toNumber(expense.amount),
      entryDate: expense.entry_date,
    })),
    approvals,
    linkedClients: linkedClients.map((client) => ({
      id: client.id,
      name: client.name,
      timezone: client.timezone || null,
      primaryEmail: client.primary_email || null,
    })),
  };
}

export async function getTasksData(userId: string) {
  return db.query<{
    id: string;
    title: string;
    status: string;
    priority: string;
    due_at: string | null;
    project_id: string | null;
    project_name: string | null;
    description: string | null;
  }>(
    `SELECT todo.id, todo.title, todo.description, todo.status::text as status, todo.priority::text as priority, todo.due_at, todo.project_id, projects.name as project_name
     FROM todo
     LEFT JOIN projects ON projects.id = todo.project_id
     WHERE todo.user_id = $1
     ORDER BY todo.created_at DESC`,
    [userId]
  );
}

export async function getCalendarData(userId: string, date: Date) {
  await ensureAssistantRuntimeTables();
  const dayStart = new Date(date);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(date);
  dayEnd.setHours(23, 59, 59, 999);

  const [googleEvents, projectMeetings, manualMeetings, notes] = await Promise.all([
    fetchGoogleCalendarEvents(userId, {
      timeMin: dayStart.toISOString(),
      timeMax: dayEnd.toISOString(),
      maxResults: 20,
    }),
    db.query<{ id: string; calendar_event_id: string | null; title: string | null; meeting_date: string | null; summary: string | null; decisions: string[] | null; action_items: string[] | null }>(
      `SELECT id, calendar_event_id, title, meeting_date, summary, decisions, action_items
       FROM project_meeting_notes
       WHERE user_id = $1 AND meeting_date >= $2 AND meeting_date <= $3
       ORDER BY meeting_date ASC`,
      [userId, dayStart.toISOString(), dayEnd.toISOString()]
    ),
    db.query<{ id: string; title: string | null; meeting_date: string | null; content: string | null }>(
      `SELECT id, title, meeting_date, content
       FROM client_meeting_notes
       WHERE user_id = $1 AND meeting_date >= $2 AND meeting_date <= $3
       ORDER BY meeting_date ASC`,
      [userId, dayStart.toISOString(), dayEnd.toISOString()]
    ),
    db.query<{ id: string; external_id: string | null; content: string | null }>(
      `SELECT id, external_id, content
       FROM client_meeting_notes
       WHERE user_id = $1
         AND meeting_date >= $2
         AND meeting_date <= $3`,
      [userId, dayStart.toISOString(), dayEnd.toISOString()]
    ),
  ]);

  const noteByExternalId = new Map<string, string>([
    ...projectMeetings
      .filter((meeting) => meeting.calendar_event_id)
      .map((meeting) => [meeting.calendar_event_id as string, formatMeetingContent(meeting.summary, meeting.decisions || [], meeting.action_items || [])] as const),
    ...notes.filter((note) => note.external_id).map((note) => [note.external_id as string, note.content || ''] as const),
  ]);

  const fallback = (projectMeetings.length > 0
    ? projectMeetings
        .filter((meeting) => meeting.meeting_date)
        .map((meeting) => ({
          id: meeting.id,
          title: meeting.title || 'Meeting',
          description: formatMeetingContent(meeting.summary, meeting.decisions || [], meeting.action_items || []),
          start: meeting.meeting_date as string,
          end: new Date(new Date(meeting.meeting_date as string).getTime() + 60 * 60 * 1000).toISOString(),
          attendeeCount: 1,
          attendeeEmails: [],
          noteId: meeting.id,
          noteContent: formatMeetingContent(meeting.summary, meeting.decisions || [], meeting.action_items || []),
        }))
    : manualMeetings
        .filter((meeting) => meeting.meeting_date)
    .map((meeting) => ({
      id: meeting.id,
      title: meeting.title || 'Meeting',
      description: meeting.content || '',
      start: meeting.meeting_date as string,
      end: new Date(new Date(meeting.meeting_date as string).getTime() + 60 * 60 * 1000).toISOString(),
      attendeeCount: 1,
      attendeeEmails: [],
      noteId: meeting.id,
      noteContent: meeting.content || '',
    })));

  if (googleEvents.length > 0) {
    return googleEvents.map((event) => ({
      ...event,
      noteId: null,
      noteContent: noteByExternalId.get(event.id) || '',
    }));
  }

  return fallback;
}

export async function getCalendarPlanningContext(userId: string, date: Date) {
  const dayStart = new Date(date);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(date);
  dayEnd.setHours(23, 59, 59, 999);

  const [events, tasks, approvals] = await Promise.all([
    getCalendarData(userId, date),
    db.query<{
      title: string;
      priority: string;
      due_at: string | null;
      project_name: string | null;
    }>(
      `SELECT todo.title, todo.priority::text as priority, todo.due_at, projects.name as project_name
       FROM todo
       LEFT JOIN projects ON projects.id = todo.project_id
       WHERE todo.user_id = $1
         AND todo.status::text NOT IN ('done', 'completed')
         AND (todo.due_at IS NULL OR todo.due_at <= $3)
       ORDER BY todo.priority DESC, todo.due_at ASC NULLS LAST
       LIMIT 12`,
      [userId, dayStart.toISOString(), dayEnd.toISOString()]
    ),
    listPendingApprovalActions(userId),
  ]);

  return {
    events,
    tasks,
    approvals,
  };
}

export async function getAutomationsData(userId: string) {
  return db.query<{
    id: string;
    type: string;
    cron_expression: string;
    enabled: boolean;
    config: Record<string, unknown> | null;
    last_run_at: string | null;
    next_run_at: string | null;
  }>(
    `SELECT id, type, cron_expression, enabled, config, last_run_at, next_run_at
     FROM scheduled_jobs
     WHERE user_id = $1
     ORDER BY created_at DESC`,
    [userId]
  );
}

export async function getSettingsData(userId: string) {
  const [profile, accounts] = await Promise.all([getAssistantProfile(userId), getConnectedAccounts(userId)]);

  return {
    profile,
    accounts,
  };
}
