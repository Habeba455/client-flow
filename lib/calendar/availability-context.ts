import type { RoutingTask, UserProfile } from '@/lib/ai/types';
import { db } from '@/lib/db';
import { getClient } from '@/lib/product-data';
import { getValidMeetingSlots, type MeetingSlotComputationResult } from '@/lib/calendar/scheduling';
import { fetchGoogleCalendarEvents } from '@/lib/google/calendar';

interface ProjectTimezoneRow {
  metadata: Record<string, unknown> | null;
}

const IANA_TIMEZONE_REGEX = /^[A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?$/;

function readClientTimezoneFromMetadata(metadata: Record<string, unknown> | null): string | null {
  if (!metadata || typeof metadata !== 'object') {
    return null;
  }
  const raw = metadata.clientTimezone ?? metadata.client_timezone ?? metadata.timezone;
  if (typeof raw === 'string' && raw.trim() && IANA_TIMEZONE_REGEX.test(raw.trim())) {
    return raw.trim();
  }
  return null;
}

function scanObjectForTimezone(value: unknown): string | null {
  if (typeof value === 'string' && IANA_TIMEZONE_REGEX.test(value.trim())) {
    return value.trim();
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = scanObjectForTimezone(item);
      if (found) {
        return found;
      }
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) {
      const found = scanObjectForTimezone(entry);
      if (found) {
        return found;
      }
    }
  }
  return null;
}

function parseDurationMinutes(task: RoutingTask): number {
  const direct = typeof task.context.duration_minutes === 'number' ? task.context.duration_minutes : Number(task.context.duration_minutes);
  if (Number.isFinite(direct) && direct > 0) {
    return direct;
  }

  const input = `${task.subtask}\n${typeof task.context.duration_requested === 'string' ? task.context.duration_requested : ''}`;
  const normalized = input.toLowerCase();
  const hourMatch = normalized.match(/(\d+)\s*hour/);
  if (hourMatch) {
    return Number(hourMatch[1]) * 60;
  }
  const minuteMatch = normalized.match(/(\d+)\s*min/);
  if (minuteMatch) {
    return Number(minuteMatch[1]);
  }
  return 30;
}

async function getProjectIdByUserAndName(userId: string, nameOrClient: string): Promise<string | null> {
  if (!nameOrClient || typeof nameOrClient !== 'string') {
    return null;
  }
  const search = `%${nameOrClient.trim()}%`;
  const row = await db.queryOne<{ id: string }>(
    `SELECT id FROM projects
     WHERE user_id = $1
       AND (
         name ILIKE $2 OR title ILIKE $2
         OR (metadata IS NOT NULL AND (metadata->>'clientEntity') ILIKE $2)
       )
     ORDER BY updated_at DESC NULLS LAST
     LIMIT 1`,
    [userId, search]
  );
  return row?.id ?? null;
}

async function getClientTimezoneByNameOrEmail(userId: string, nameOrEmail: string | null): Promise<string | null> {
  if (!nameOrEmail || typeof nameOrEmail !== 'string' || !nameOrEmail.trim()) {
    return null;
  }

  const search = `%${nameOrEmail.trim()}%`;
  const row = await db.queryOne<{ timezone: string | null }>(
    `SELECT timezone
     FROM clients
     WHERE user_id = $1
       AND (
         name ILIKE $2
         OR company ILIKE $2
         OR primary_email ILIKE $2
       )
     ORDER BY updated_at DESC NULLS LAST
     LIMIT 1`,
    [userId, search]
  );

  return row?.timezone || null;
}

async function getClientIdentityByNameOrEmail(
  userId: string,
  nameOrEmail: string | null
): Promise<{ name: string | null; email: string | null; timezone: string | null } | null> {
  if (!nameOrEmail || typeof nameOrEmail !== 'string' || !nameOrEmail.trim()) {
    return null;
  }

  const search = `%${nameOrEmail.trim()}%`;
  const row = await db.queryOne<{ name: string | null; primary_email: string | null; timezone: string | null }>(
    `SELECT name, primary_email, timezone
     FROM clients
     WHERE user_id = $1
       AND (
         name ILIKE $2
         OR company ILIKE $2
         OR primary_email ILIKE $2
       )
     ORDER BY updated_at DESC NULLS LAST
     LIMIT 1`,
    [userId, search]
  );

  if (!row) {
    return null;
  }

  return {
    name: row.name || null,
    email: row.primary_email || null,
    timezone: row.timezone || null,
  };
}

async function getClientTimezoneFromProject(projectId: string | null, userId?: string): Promise<string | null> {
  if (!projectId) {
    return null;
  }

  const project = await db.queryOne<ProjectTimezoneRow>(
    `SELECT metadata FROM projects WHERE id = $1`,
    [projectId]
  );

  if (!project?.metadata || typeof project.metadata !== 'object') {
    return null;
  }

  const clientId = typeof project.metadata.clientId === 'string' ? project.metadata.clientId.trim() : null;
  if (clientId && userId) {
    const client = await getClient(userId, clientId);
    if (client?.timezone) {
      return client.timezone;
    }
  }

  const fromMeta = readClientTimezoneFromMetadata(project.metadata);
  if (fromMeta) {
    return fromMeta;
  }
  return scanObjectForTimezone(project.metadata);
}

function readContextTimezone(task: RoutingTask): string | null {
  const candidates = [
    task.context.client_timezone,
    task.context.clientTimezone,
    task.context.timezone,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }

  return null;
}

function toSerializableAvailability(availability: MeetingSlotComputationResult) {
  return {
    slots: availability.slots,
    noOverlap: availability.noOverlap,
    message: availability.message,
    nearestOption: availability.nearestOption,
  };
}

function getDateParts(date: Date, timeZone: string): { year: number; month: number; day: number; weekday: number } {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  });
  const parts = formatter.formatToParts(date);
  const weekdayLabel = parts.find((part) => part.type === 'weekday')?.value || 'Sun';
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };

  return {
    year: Number(parts.find((part) => part.type === 'year')?.value || '1970'),
    month: Number(parts.find((part) => part.type === 'month')?.value || '01'),
    day: Number(parts.find((part) => part.type === 'day')?.value || '01'),
    weekday: weekdayMap[weekdayLabel] ?? 0,
  };
}

function resolveSearchWindow(task: RoutingTask, userTimezone: string): { searchStartDate?: Date; searchDays?: number } {
  const input = `${task.subtask}\n${typeof task.context.original_message === 'string' ? task.context.original_message : ''}`.toLowerCase();
  const now = new Date();

  if (!/\bnext week\b/.test(input)) {
    return {};
  }

  const parts = getDateParts(now, userTimezone);
  const daysUntilNextMonday = ((8 - parts.weekday) % 7) || 7;
  const startDate = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + daysUntilNextMonday, 12, 0, 0));

  return {
    searchStartDate: startDate,
    searchDays: 7,
  };
}

export async function enrichCalendarTaskContext(params: {
  userId: string;
  profile: UserProfile;
  task: RoutingTask;
}): Promise<RoutingTask> {
  if (params.task.persona !== 'CALENDAR_AGENT') {
    return params.task;
  }

  const userTimezone = params.profile.user_timezone || 'UTC';
  const workingHoursStart = params.profile.working_hours_start || '09:00';
  const workingHoursEnd = params.profile.working_hours_end || '17:00';
  let projectId: string | null = typeof params.task.context.project_id === 'string' ? params.task.context.project_id : null;
  const clientReference =
    typeof params.task.context.client === 'string'
      ? params.task.context.client
      : typeof params.task.context.client_name === 'string'
        ? params.task.context.client_name
        : typeof params.task.context.client_email === 'string'
          ? params.task.context.client_email
          : null;
  if (!projectId) {
    const projectName = typeof params.task.context.project === 'string' ? params.task.context.project : clientReference;
    if (projectName) {
      projectId = await getProjectIdByUserAndName(params.userId, projectName);
    }
  }
  const clientTimezone =
    readContextTimezone(params.task) ||
    (await getClientTimezoneFromProject(projectId, params.userId)) ||
    (await getClientTimezoneByNameOrEmail(params.userId, clientReference));
  const durationMinutes = parseDurationMinutes(params.task);
  const clientIdentity = await getClientIdentityByNameOrEmail(params.userId, clientReference);
  const searchWindow = resolveSearchWindow(params.task, userTimezone);
  let calendarEvents: Awaited<ReturnType<typeof fetchGoogleCalendarEvents>> = [];
  try {
    calendarEvents = await fetchGoogleCalendarEvents(params.userId, {
      timeMin: new Date().toISOString(),
      timeMax: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      maxResults: 100,
    });
  } catch {
    calendarEvents = [];
  }
  const availability = getValidMeetingSlots(
    {
      userTimezone,
      workingHoursStart,
      workingHoursEnd,
      clientTimezone,
      durationMinutes,
      ...searchWindow,
    },
    calendarEvents
  );

  return {
    ...params.task,
    context: {
      ...params.task.context,
      ...(projectId ? { project_id: projectId } : {}),
      user_timezone: userTimezone,
      working_hours_start: workingHoursStart,
      working_hours_end: workingHoursEnd,
      client_timezone: clientTimezone,
      client_name: clientIdentity?.name || clientReference || null,
      client_email: clientIdentity?.email || params.task.context.client_email || null,
      duration_minutes: durationMinutes,
      meeting_slot_source: 'getValidMeetingSlots',
      valid_meeting_slots: availability.slots,
      slot_constraints: toSerializableAvailability(availability),
    },
  };
}
