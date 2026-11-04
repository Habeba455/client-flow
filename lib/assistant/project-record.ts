import { randomUUID } from 'node:crypto';
import type { AgentRunResult } from '@/lib/ai/types';
import { db } from '@/lib/db';

export interface ProjectMilestoneRecord {
  title: string;
  targetDate: string | null;
  status: string;
}

export interface ProjectTeamMemberRecord {
  name: string;
  email: string;
  role: string | null;
  responsibilities: string | null;
  accessLevel: string | null;
}

export interface PendingProjectInviteRecord {
  name: string;
  role: string | null;
  reason: string;
}

export interface ParsedProjectRecord {
  hasProjectRecord: boolean;
  hasMilestones: boolean;
  hasTeamRoster: boolean;
  projectName: string | null;
  clientEntity: string | null;
  description: string | null;
  projectType: string | null;
  startDate: string | null;
  targetCompletion: string | null;
  engagementValue: string | null;
  projectOwner: string | null;
  status: string | null;
  milestones: ProjectMilestoneRecord[];
  teamRoster: ProjectTeamMemberRecord[];
}

interface ExistingProjectRow {
  id: string;
  name: string;
  title: string | null;
  description: string | null;
  summary: string | null;
  status: string | null;
  progress: number | null;
  linked_contacts: string[] | null;
  metadata: Record<string, unknown> | null;
}

interface PersistProjectCoordinatorParams {
  userId: string;
  userName?: string | null;
  message: string;
  fallbackProjectId?: string | null;
  agentRuns: AgentRunResult[];
}

interface PersistProjectCoordinatorResult {
  projectId: string;
  projectName: string;
  action: 'created' | 'updated';
}

const PROJECT_MUTATION_PATTERN =
  /\b(create|set up|setup|new project|add team|invite|update|change|rename|archive|close|complete|cancel|on hold|remove|milestone|roster|team member|status)\b/i;
const PROJECT_CREATE_PATTERN = /\b(create|set up|setup|new project)\b/i;

function normalizeWhitespace(value: string | null | undefined): string | null {
  const normalized = value?.replace(/\s+/g, ' ').trim();
  return normalized ? normalized : null;
}

function extractTimezone(value: string | null | undefined): string | null {
  const normalized = normalizeWhitespace(value);
  if (!normalized) {
    return null;
  }

  const match = normalized.match(/[A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?/);
  return match?.[0] || null;
}

function readField(text: string, label: string): string | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = text.match(new RegExp(`^${escaped}:\\s*(.+)$`, 'im'));
  return normalizeWhitespace(match?.[1] || null);
}

function extractSection(text: string, heading: string, nextHeadings: string[]): string {
  const normalized = text.replace(/\r\n/g, '\n');
  const startRegex = new RegExp(`^${heading}\\s*$`, 'im');
  const start = normalized.search(startRegex);
  if (start < 0) {
    return '';
  }

  const fromStart = normalized.slice(start);
  const firstNewline = fromStart.indexOf('\n');
  const body = firstNewline >= 0 ? fromStart.slice(firstNewline + 1) : '';

  let endIndex = body.length;
  for (const nextHeading of nextHeadings) {
    const nextRegex = new RegExp(`^${nextHeading}\\s*$`, 'im');
    const match = body.match(nextRegex);
    if (match?.index != null && match.index < endIndex) {
      endIndex = match.index;
    }
  }

  return body.slice(0, endIndex).trim();
}

function normalizeStoredDate(value: string | null | undefined): string | null {
  const normalized = normalizeWhitespace(value);
  if (!normalized || /^(tbd|not specified|none|n\/a)$/i.test(normalized)) {
    return null;
  }

  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    return normalized;
  }
  return parsed.toISOString();
}

function normalizeCurrencyValue(value: string | null | undefined): string | null {
  const normalized = normalizeWhitespace(value);
  return normalized || null;
}

function normalizeProjectStatus(value: string | null | undefined): 'active' | 'on_hold' | 'completed' | 'archived' {
  const normalized = (value || '').trim().toLowerCase();
  if (normalized.includes('hold')) return 'on_hold';
  if (normalized.includes('complete')) return 'completed';
  if (normalized.includes('cancel') || normalized.includes('archive') || normalized.includes('close')) return 'archived';
  return 'active';
}

function normalizeMilestoneStatus(value: string | null | undefined): string {
  const normalized = normalizeWhitespace(value);
  return normalized || 'Not Started';
}

function parseAsciiTableRows(section: string): string[][] {
  return section
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line.includes('|'))
    .filter((line) => !/^[-=\s|#]+$/.test(line))
    .map((line) => line.replace(/^\|/, '').replace(/\|$/, ''))
    .map((line) => line.split('|').map((cell) => normalizeWhitespace(cell) || ''))
    .filter((cells) => cells.some(Boolean));
}
function readFieldFromMarkdownTable(text: string, label: string): string | null {
  const rows = parseAsciiTableRows(text);

  for (const cells of rows) {
    const left = normalizeWhitespace(cells[0]);
    const right = normalizeWhitespace(cells[1]);

    if (!left || !right) continue;
    if (left.toLowerCase() === label.toLowerCase()) {
      return right;
    }
  }

  return null;
}

function parseMilestones(section: string): ProjectMilestoneRecord[] {
  return parseAsciiTableRows(section)
    .filter((cells) => /^\d+$/.test((cells[0] || '').trim()))
    .map((cells) => ({
      title: cells[1] || '',
      targetDate: normalizeStoredDate(cells[2]),
      status: normalizeMilestoneStatus(cells[3]),
    }))
    .filter((milestone) => milestone.title);
}

export function createSyntheticProjectMemberEmail(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 48);
  return `${slug || 'team.member'}@project-member.local`;
}

export function isSyntheticProjectMemberEmail(value: string): boolean {
  return value.endsWith('@project-member.local');
}

function parseDateWithYearFallback(value: string, fallbackYear?: number | null): string | null {
  const normalized = normalizeWhitespace(value);
  if (!normalized) {
    return null;
  }

  const withYear = /\b\d{4}\b/.test(normalized)
    ? normalized
    : fallbackYear
      ? `${normalized}, ${fallbackYear}`
      : normalized;
  return normalizeStoredDate(withYear);
}

function parseDateRangeEnd(value: string, fallbackYear?: number | null): string | null {
  const normalized = normalizeWhitespace(value);
  if (!normalized) {
    return null;
  }

  const parts = normalized.split(/\s*[–-]\s*/);
  const endPart = parts[parts.length - 1] || normalized;
  const startPart = parts[0] || normalized;
  const inferredYearMatch = (normalized.match(/\b(20\d{2})\b/) || startPart.match(/\b(20\d{2})\b/))?.[1];
  const inferredYear = inferredYearMatch ? Number(inferredYearMatch) : fallbackYear;
  const startMonthMatch = startPart.match(/^[A-Za-z]+/);
  const endNeedsMonth = !/^[A-Za-z]+/.test(endPart) && startMonthMatch?.[0];
  const candidate = endNeedsMonth ? `${startMonthMatch[0]} ${endPart}` : endPart;
  return parseDateWithYearFallback(candidate, inferredYear);
}

function parseTeamRoster(section: string): ProjectTeamMemberRecord[] {
  return parseAsciiTableRows(section)
    .filter((cells) => !/^name$/i.test((cells[0] || '').trim()))
    .map((cells) => ({
      name: cells[0] || '',
      email: ((cells[1] || '').includes('@') ? cells[1] : createSyntheticProjectMemberEmail(cells[0] || '')).toLowerCase(),
      role: normalizeWhitespace((cells[1] || '').includes('@') ? cells[2] : cells[1]),
      responsibilities: normalizeWhitespace((cells[1] || '').includes('@') ? cells[3] : cells[2]),
      accessLevel: normalizeWhitespace((cells[1] || '').includes('@') ? cells[4] : cells[3]),
    }))
    .filter((member) => member.name);
}

function parseRoleAssignmentsFromPrompt(message: string): ProjectTeamMemberRecord[] {
  const lines = message.replace(/\r\n/g, '\n').split('\n');
  let inTeamSection = false;
  const members: ProjectTeamMemberRecord[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      if (inTeamSection) {
        break;
      }
      continue;
    }

    if (/^initial team:?$/i.test(line)) {
      inTeamSection = true;
      continue;
    }

    if (!inTeamSection) {
      continue;
    }

    const match = line.match(/^[-*]\s*([^:]+):\s*(.+)$/);
    if (!match) {
      if (/^[A-Z][A-Za-z ]+:/i.test(line)) {
        // Continue if model/user omitted bullet marker.
      } else {
        break;
      }
    }

    const role = normalizeWhitespace(match?.[1] || line.split(':')[0] || '');
    const name = normalizeWhitespace(match?.[2] || line.split(':').slice(1).join(':') || '');
    if (!name) {
      continue;
    }

    members.push({
      name,
      email: createSyntheticProjectMemberEmail(name).toLowerCase(),
      role,
      responsibilities: null,
      accessLevel: 'Full Access',
    });
  }

  return members;
}

function parseMilestonesFromPrompt(message: string, fallbackYear?: number | null): ProjectMilestoneRecord[] {
  const lines = message.replace(/\r\n/g, '\n').split('\n');
  let inMilestones = false;
  const milestones: ProjectMilestoneRecord[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      if (inMilestones) {
        break;
      }
      continue;
    }

    if (/^milestones:?$/i.test(line)) {
      inMilestones = true;
      continue;
    }

    if (!inMilestones) {
      continue;
    }

    const match = line.match(/^\d+\.\s*(.+?)\s*[–-]\s*(.+)$/);
    if (!match) {
      break;
    }

    milestones.push({
      title: normalizeWhitespace(match[1]) || 'Milestone',
      targetDate: parseDateRangeEnd(match[2], fallbackYear),
      status: 'Not Started',
    });
  }

  return milestones;
}

export function generateDefaultMilestones(projectType: string | null, startDate: string | null, targetCompletion: string | null): ProjectMilestoneRecord[] {
  const type = (projectType || '').toLowerCase();
  const templates =
    type.includes('implementation')
      ? ['Discovery & Requirements', 'Solution Design', 'Build & Configuration', 'Integration & Validation', 'Launch & Handover']
      : type.includes('research')
        ? ['Scope Definition', 'Research Plan', 'Analysis', 'Synthesis', 'Final Delivery']
        : type.includes('business development')
          ? ['Discovery', 'Solution Framing', 'Proposal Draft', 'Review & Alignment', 'Final Delivery']
          : ['Discovery', 'Planning', 'Execution', 'Review', 'Completion'];

  const start = startDate ? new Date(startDate) : null;
  const end = targetCompletion ? new Date(targetCompletion) : null;
  const validRange = start && end && !Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime()) && end.getTime() >= start.getTime();

  return templates.map((title, index) => {
    let targetDate: string | null = null;
    if (validRange && start && end) {
      const ratio = (index + 1) / templates.length;
      const date = new Date(start.getTime() + (end.getTime() - start.getTime()) * ratio);
      targetDate = date.toISOString();
    }

    return {
      title,
      targetDate,
      status: 'Not Started',
    };
  });
}

export function parseProjectRequestFallback(message: string, userName?: string | null): Partial<ParsedProjectRecord> {
  const normalized = message.replace(/\r\n/g, '\n');
  const projectName =
    readField(normalized, 'Project Name') ||
    normalizeWhitespace(
      normalized.match(/project name:\s*(.+)$/im)?.[1] ||
        normalized.match(/create a new project record(?:\s+for\s+(?:a\s+client\s+called\s+)?(.+?))?(?:\.\s*|\n)/i)?.[1] ||
        null
    );
  const clientEntity =
    readField(normalized, 'Client / Entity') ||
    normalizeWhitespace(normalized.match(/client called\s+(.+?)(?:\.|\n)/i)?.[1] || null);
  const description =
    readField(normalized, 'Description') ||
    normalizeWhitespace(
      normalized.match(/(?:this project|project)\s+(?:will|should)\s+(.+?)(?:\.|\n)/i)?.[1] ||
        normalized.match(/to\s+(.+?)(?:\.|\n)/i)?.[1] ||
        null
    );
  const startDate = normalizeStoredDate(readField(normalized, 'Start Date'));
  const targetCompletion =
    normalizeStoredDate(readField(normalized, 'Expected End Date')) ||
    normalizeStoredDate(readField(normalized, 'Target Completion')) ||
    normalizeStoredDate(readField(normalized, 'End Date'));
  const fallbackYear = targetCompletion ? new Date(targetCompletion).getUTCFullYear() : startDate ? new Date(startDate).getUTCFullYear() : null;
  const projectType = readField(normalized, 'Project Type');
  const engagementValue = normalizeCurrencyValue(readField(normalized, 'Budget') || readField(normalized, 'Engagement Value'));
  const projectOwner = userName || null;
  const status = readField(normalized, 'Status') || normalizeWhitespace(normalized.match(/set the project status to\s+"?([^".\n]+)"?/i)?.[1] || 'Planned');
  const milestones = parseMilestonesFromPrompt(normalized, fallbackYear);
  const teamRoster = parseRoleAssignmentsFromPrompt(normalized);

  return {
    projectName,
    clientEntity,
    description,
    startDate,
    targetCompletion,
    projectType,
    engagementValue,
    projectOwner,
    status,
    milestones,
    teamRoster,
    hasMilestones: milestones.length > 0,
    hasTeamRoster: teamRoster.length > 0,
  };
}

function collectPendingInvites(clientEntity: string | null, teamRoster: ProjectTeamMemberRecord[]): PendingProjectInviteRecord[] {
  const pending: PendingProjectInviteRecord[] = [];

  for (const member of teamRoster) {
    if (isSyntheticProjectMemberEmail(member.email)) {
      pending.push({
        name: member.name,
        role: member.role,
        reason: 'Email address missing. Add the email to send an invitation.',
      });
    }
  }

  if (clientEntity && !/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(clientEntity)) {
    pending.push({
      name: clientEntity,
      role: 'Client Stakeholder',
      reason: 'Primary client stakeholder email not provided.',
    });
  }

  return pending;
}

export function getMissingProjectCreationFields(
  fields: Partial<ParsedProjectRecord>,
  userName?: string | null
): Array<'projectName' | 'clientEntity' | 'description' | 'startDate' | 'targetCompletion'> {
  const missing: Array<'projectName' | 'clientEntity' | 'description' | 'startDate' | 'targetCompletion'> = [];
  if (!normalizeWhitespace(fields.projectName)) missing.push('projectName');
  if (!normalizeWhitespace(fields.clientEntity)) missing.push('clientEntity');
  if (!normalizeWhitespace(fields.description)) missing.push('description');
  if (!normalizeWhitespace(fields.startDate)) missing.push('startDate');
  if (!normalizeWhitespace(fields.targetCompletion)) missing.push('targetCompletion');
  return missing;
}

function formatProjectDisplayDate(value: string | null | undefined): string {
  const normalized = normalizeWhitespace(value);
  if (!normalized) {
    return 'TBD';
  }

  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    return normalized;
  }

  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(parsed);
}

export function buildProjectCoordinatorRecordText(params: {
  projectName: string;
  clientEntity: string;
  description: string;
  projectType: string | null;
  startDate: string | null;
  targetCompletion: string | null;
  engagementValue: string | null;
  projectOwner: string | null;
  status: string | null;
  milestones: ProjectMilestoneRecord[];
  teamRoster: ProjectTeamMemberRecord[];
}): string {
  const milestoneRows =
    params.milestones.length > 0
      ? params.milestones
          .map(
            (milestone, index) =>
              `| ${index + 1} | ${milestone.title} | ${formatProjectDisplayDate(milestone.targetDate)} | ${milestone.status || 'Not Started'} |`
          )
          .join('\n')
      : '| 1 | Initial Planning | TBD | Not Started |';

  const rosterRows =
    params.teamRoster.length > 0
      ? params.teamRoster
          .map(
            (member) =>
              `| ${member.name} | ${isSyntheticProjectMemberEmail(member.email) ? 'Email needed' : member.email} | ${member.role || 'Role not specified'} | ${
                member.responsibilities || 'To be confirmed'
              } | ${member.accessLevel || 'Full Access'} |`
          )
          .join('\n')
      : '(Empty  add team members using the invite flow)';

  return [
    '## Project Record',
    '',
    '| Field | Value |',
    '| --- | --- |',
    `| Project Name | ${params.projectName} |`,
    `| Client / Entity | ${params.clientEntity} |`,
    `| Description | ${params.description} |`,
    `| Project Type | ${params.projectType || 'Other'} |`,
    `| Start Date | ${formatProjectDisplayDate(params.startDate)} |`,
    `| Target Completion | ${formatProjectDisplayDate(params.targetCompletion)} |`,
    `| Engagement Value | ${params.engagementValue || 'TBD'} |`,
    `| Project Owner | ${params.projectOwner || 'Not specified'} |`,
    `| Status | ${params.status || 'Planned'} |`,
    '',
    '### Milestones',
    '',
    '| # | Milestone | Target Date | Status |',
    '| --- | --- | --- | --- |',
    milestoneRows,
    '',
    '### Team Roster',
    '',
    params.teamRoster.length > 0
      ? ['| Name | Email | Role | Responsibilities | Access |', '| --- | --- | --- | --- | --- |', rosterRows].join('\n')
      : rosterRows,
  ].join('\n');
}

export function parseProjectCoordinatorOutput(output: string): ParsedProjectRecord {
  const normalized = output.replace(/\r\n/g, '\n');
  const milestoneSection = extractSection(normalized, '### Milestones', ['### Team Roster', 'SUMMARY', '════════']);
  const rosterSection = extractSection(normalized, '### Team Roster', ['SUMMARY', '════════']);

  return {
    hasProjectRecord: /Project Record/i.test(normalized),
    hasMilestones: /Milestones/i.test(normalized),
    hasTeamRoster: /Team Roster/i.test(normalized),

    projectName: readFieldFromMarkdownTable(normalized, 'Project Name'),
    clientEntity: readFieldFromMarkdownTable(normalized, 'Client / Entity'),
    description: readFieldFromMarkdownTable(normalized, 'Description'),
    projectType: readFieldFromMarkdownTable(normalized, 'Project Type'),
    startDate: normalizeStoredDate(readFieldFromMarkdownTable(normalized, 'Start Date')),
    targetCompletion: normalizeStoredDate(readFieldFromMarkdownTable(normalized, 'Target Completion')),
    engagementValue: readFieldFromMarkdownTable(normalized, 'Engagement Value'),
    projectOwner: readFieldFromMarkdownTable(normalized, 'Project Owner'),
    status: readFieldFromMarkdownTable(normalized, 'Status'),

    milestones: parseMilestones(milestoneSection),
    teamRoster: rosterSection.toLowerCase().includes('empty') ? [] : parseTeamRoster(rosterSection),
  };
}

function collectClientMetadata(clientEntity: string | null, teamRoster: ProjectTeamMemberRecord[], existingClients: unknown): Array<Record<string, unknown>> {
  const nextClients: Array<Record<string, unknown>> = Array.isArray(existingClients)
    ? existingClients.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
    : [];

  const seen = new Set(
    nextClients.map((entry) => `${String(entry.email || '').toLowerCase()}|${String(entry.name || '').toLowerCase()}`)
  );

  if (clientEntity) {
    const emailMatch = clientEntity.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    const name = normalizeWhitespace(clientEntity.replace(/[<(].*$/, '')) || clientEntity;
    const timezone = extractTimezone(clientEntity);
    const key = `${(emailMatch?.[0] || '').toLowerCase()}|${name.toLowerCase()}`;
    if (!seen.has(key)) {
      nextClients.push({
        name,
        email: emailMatch?.[0]?.toLowerCase() || null,
        company: name,
        timezone,
      });
      seen.add(key);
    }
  }

  for (const member of teamRoster) {
    if (!member.role || !/client/i.test(member.role)) {
      continue;
    }
    const key = `${member.email.toLowerCase()}|${member.name.toLowerCase()}`;
    if (seen.has(key)) {
      continue;
    }
    nextClients.push({
      name: member.name,
      email: member.email.toLowerCase(),
      company: clientEntity || null,
      timezone: extractTimezone(clientEntity),
    });
    seen.add(key);
  }

  return nextClients;
}

function inferProjectClientTimezone(clientEntity: string | null, existingMetadata: Record<string, unknown> | null | undefined): string | null {
  const direct = extractTimezone(clientEntity);
  if (direct) {
    return direct;
  }

  const topLevel = typeof existingMetadata?.clientTimezone === 'string' ? extractTimezone(existingMetadata.clientTimezone) : null;
  if (topLevel) {
    return topLevel;
  }

  const clients = Array.isArray(existingMetadata?.clients) ? existingMetadata.clients : [];
  for (const entry of clients) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const timezone = typeof entry.timezone === 'string' ? extractTimezone(entry.timezone) : null;
    if (timezone) {
      return timezone;
    }
  }

  return null;
}

function collectLinkedContacts(clientEntity: string | null, teamRoster: ProjectTeamMemberRecord[], existing: string[] | null): string[] {
  const contacts = new Set((existing || []).map((entry) => entry.toLowerCase()));
  const addEmail = (value: string | null | undefined) => {
    const emailMatch = value?.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    if (emailMatch?.[0]) {
      contacts.add(emailMatch[0].toLowerCase());
    }
  };

  addEmail(clientEntity);
  for (const member of teamRoster) {
    if (member.role && /client/i.test(member.role)) {
      addEmail(member.email);
    }
  }

  return [...contacts];
}

function calculateProgress(milestones: ProjectMilestoneRecord[], fallback: number | null): number {
  if (milestones.length === 0) {
    return fallback ?? 0;
  }

  const completed = milestones.filter((milestone) => /complete|done/i.test(milestone.status)).length;
  return Math.max(0, Math.min(100, Math.round((completed / milestones.length) * 100)));
}

async function findExistingProject(userId: string, fallbackProjectId: string | null | undefined, projectName: string | null): Promise<ExistingProjectRow | null> {
  if (fallbackProjectId) {
    return db.queryOne<ExistingProjectRow>(
      `SELECT id, name, title, description, summary, status, progress, linked_contacts, metadata
       FROM projects
       WHERE user_id = $1 AND id = $2`,
      [userId, fallbackProjectId]
    );
  }

  if (!projectName) {
    return null;
  }

  return db.queryOne<ExistingProjectRow>(
    `SELECT id, name, title, description, summary, status, progress, linked_contacts, metadata
     FROM projects
     WHERE user_id = $1
       AND (LOWER(title) = LOWER($2) OR LOWER(name) = LOWER($2))
     ORDER BY updated_at DESC NULLS LAST, created_at DESC
     LIMIT 1`,
    [userId, projectName]
  );
}

async function replaceProjectMembers(projectId: string, teamRoster: ProjectTeamMemberRecord[]) {
  await db.query(`DELETE FROM project_members WHERE project_id = $1`, [projectId]);

  for (const member of teamRoster) {
    if (isSyntheticProjectMemberEmail(member.email)) {
      continue;
    }
    await db.query(
      `INSERT INTO project_members (id, project_id, email, name, role, responsibilities, access_level, invited_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [
        randomUUID(),
        projectId,
        member.email.toLowerCase(),
        member.name,
        member.role,
        member.responsibilities,
        member.accessLevel,
      ]
    );
  }
}

export function projectMutationRequested(message: string): boolean {
  return PROJECT_MUTATION_PATTERN.test(message);
}

export function projectCreateRequested(message: string): boolean {
  return PROJECT_CREATE_PATTERN.test(message);
}

export async function persistProjectCoordinatorRun(
  params: PersistProjectCoordinatorParams
): Promise<PersistProjectCoordinatorResult | null> {
  
  const coordinatorRun = [...params.agentRuns].reverse().find((run) => run.persona === 'PROJECT_COORDINATOR');
  if (!coordinatorRun) {
    return null;
  }

  const parsed = parseProjectCoordinatorOutput(coordinatorRun.output);
  if (!projectMutationRequested(params.message) && params.agentRuns.length === 0) {
  return null;
}
  const requestFallback = parseProjectRequestFallback(params.message, params.userName);
  const mergedProjectName = parsed.projectName || requestFallback.projectName || null;
  const mergedClientEntity = parsed.clientEntity || requestFallback.clientEntity || null;
  const mergedStartDate = parsed.startDate || requestFallback.startDate || null;
  const mergedTargetCompletion = parsed.targetCompletion || requestFallback.targetCompletion || null;
  const mergedProjectType = parsed.projectType || requestFallback.projectType || null;
  const mergedEngagementValue = parsed.engagementValue || requestFallback.engagementValue || null;
  const mergedProjectOwner = parsed.projectOwner || requestFallback.projectOwner || null;
  const mergedStatus = parsed.status || requestFallback.status || null;
  const mergedMilestones =
    parsed.milestones.length > 0
      ? parsed.milestones
      : requestFallback.milestones && requestFallback.milestones.length > 0
        ? requestFallback.milestones
        : [];
  const mergedTeamRoster =
    parsed.teamRoster.length > 0
      ? parsed.teamRoster
      : requestFallback.teamRoster && requestFallback.teamRoster.length > 0
        ? requestFallback.teamRoster
        : [];

  if (!parsed.hasProjectRecord && !parsed.hasMilestones && !parsed.hasTeamRoster) {
    if (!mergedProjectName && !mergedClientEntity) {
      return null;
    }
  }

  const existingProject = await findExistingProject(params.userId, params.fallbackProjectId, mergedProjectName);
  if (!existingProject && !mergedProjectName) {
    return null;
  }

  if (!existingProject && !parsed.hasProjectRecord) {
    return null;
  }

  const projectId = existingProject?.id || randomUUID();
  const projectName = mergedProjectName || existingProject?.title || existingProject?.name || 'Untitled Project';
  const previousMetadata = existingProject?.metadata || {};
  const shouldReplaceMilestones =
    (parsed.hasMilestones || Boolean(requestFallback.hasMilestones)) &&
    (mergedMilestones.length > 0 || projectCreateRequested(params.message) || /\bmilestone\b/i.test(params.message));
  const shouldReplaceTeamRoster =
    (parsed.hasTeamRoster || Boolean(requestFallback.hasTeamRoster)) &&
    (mergedTeamRoster.length > 0 || projectCreateRequested(params.message) || /\b(team|invite|roster|remove)\b/i.test(params.message));
  const milestones =
    shouldReplaceMilestones
      ? mergedMilestones
      : Array.isArray(previousMetadata.milestones)
        ? (previousMetadata.milestones as ProjectMilestoneRecord[])
        : [];
  const effectiveMilestones =
    milestones.length > 0
      ? milestones
      : projectCreateRequested(params.message)
        ? generateDefaultMilestones(mergedProjectType, mergedStartDate, mergedTargetCompletion)
        : milestones;
  const clients = collectClientMetadata(mergedClientEntity, mergedTeamRoster, previousMetadata.clients);
  const pendingInvites = collectPendingInvites(mergedClientEntity, mergedTeamRoster);
  const metadata = {
    ...previousMetadata,
    clientEntity: mergedClientEntity ?? (typeof previousMetadata.clientEntity === 'string' ? previousMetadata.clientEntity : null),
    clientTimezone: inferProjectClientTimezone(mergedClientEntity, previousMetadata),
    projectType: mergedProjectType ?? (typeof previousMetadata.projectType === 'string' ? previousMetadata.projectType : null),
    startDate: mergedStartDate ?? (typeof previousMetadata.startDate === 'string' ? previousMetadata.startDate : null),
    targetCompletion:
      mergedTargetCompletion ?? (typeof previousMetadata.targetCompletion === 'string' ? previousMetadata.targetCompletion : null),
    engagementValue:
      mergedEngagementValue ?? (typeof previousMetadata.engagementValue === 'string' ? previousMetadata.engagementValue : null),
    projectOwner: mergedProjectOwner ?? (typeof previousMetadata.projectOwner === 'string' ? previousMetadata.projectOwner : params.userName || null),
    milestones: effectiveMilestones,
    clients,
    pendingInvites,
  };
  const linkedContacts = collectLinkedContacts(mergedClientEntity, mergedTeamRoster, existingProject?.linked_contacts || null);
  const status = normalizeProjectStatus(mergedStatus || existingProject?.status);
  const description = parsed.description ?? existingProject?.description ?? null;
  const summary = parsed.description ?? existingProject?.summary ?? description;
  const progress = calculateProgress(effectiveMilestones, existingProject?.progress ?? null);

  if (existingProject) {
    await db.query(
      `UPDATE projects
       SET name = $3,
           title = $4,
           description = $5,
           category = $6,
           summary = $7,
           status = $8,
           progress = $9,
           linked_contacts = $10::text[],
           metadata = $11::jsonb,
           owner_user_id = $12,
           updated_at = NOW()
       WHERE id = $1 AND user_id = $2`,
      [
        projectId,
        params.userId,
        projectName,
        projectName,
        description,
        metadata.projectType || null,
        summary,
        status,
        progress,
        linkedContacts,
        JSON.stringify(metadata),
        params.userId,
      ]
    );
  } else {
    await db.query(
      `INSERT INTO projects (
         id, user_id, name, description, category, summary, created_at, updated_at,
         status, progress, linked_contacts, metadata, owner_user_id, title
       )
       VALUES (
         $1, $2, $3, $4, $5, $6, NOW(), NOW(),
         $7, $8, $9::text[], $10::jsonb, $11, $12
       )`,
      [
        projectId,
        params.userId,
        projectName,
        description,
        metadata.projectType || null,
        summary,
        status,
        progress,
        linkedContacts,
        JSON.stringify(metadata),
        params.userId,
        projectName,
      ]
    );
  }

  if (shouldReplaceTeamRoster) {
    await replaceProjectMembers(projectId, mergedTeamRoster);
  }

  return {
    projectId,
    projectName,
    action: existingProject ? 'updated' : 'created',
  };
}
