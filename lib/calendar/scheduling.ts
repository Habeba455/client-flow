import type { CalendarEventSummary } from '@/lib/google/calendar';

export interface SchedulingPreferences {
  userTimezone: string;
  workingHoursStart: string;
  workingHoursEnd: string;
  clientTimezone?: string | null;
  durationMinutes: number;
  now?: Date;
  searchStartDate?: Date;
  searchDays?: number;
}

export interface SuggestedMeetingSlot {
  start: string;
  end: string;
  userDisplayTime: string;
  clientDisplayTime: string;
  timezoneNote: string | null;
}

export interface MeetingSlotComputationResult {
  slots: SuggestedMeetingSlot[];
  noOverlap: boolean;
  message: string | null;
  nearestOption: string | null;
  skippedReasons: string[];
}

function parseTime(value: string): { hour: number; minute: number } {
  const match = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    return { hour: 9, minute: 0 };
  }
  return { hour: Number(match[1]), minute: Number(match[2]) };
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

function toUtc(localDate: string, localTime: string, timeZone: string): Date {
  const [year, month, day] = localDate.split('-').map(Number);
  const { hour, minute } = parseTime(localTime);
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

function getDateParts(date: Date, timeZone: string): { year: number; month: number; day: number } {
  const formatter = getFormatter(timeZone, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(date);
  return {
    year: Number(parts.find((part) => part.type === 'year')?.value || '1970'),
    month: Number(parts.find((part) => part.type === 'month')?.value || '01'),
    day: Number(parts.find((part) => part.type === 'day')?.value || '01'),
  };
}

function formatDateKey(parts: { year: number; month: number; day: number }): string {
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function addDays(date: Date, count: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + count, 12, 0, 0));
}

function overlaps(startA: number, endA: number, startB: number, endB: number): boolean {
  return startA < endB && endA > startB;
}

function formatDisplayTime(date: Date, timeZone: string): string {
  return getFormatter(timeZone, {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date);
}

function formatDayLabel(date: Date, timeZone: string): string {
  return getFormatter(timeZone, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  }).format(date);
}

function hasConflict(start: number, end: number, events: Array<{ start: number; end: number }>): boolean {
  return events.some((event) => overlaps(start, end, event.start, event.end));
}

function generateSlots(params: {
  overlapStart: Date;
  overlapEnd: Date;
  durationMinutes: number;
  eventWindows: Array<{ start: number; end: number }>;
  earliestStart: number;
}) {
  const slots: Array<{ start: Date; end: Date }> = [];
  const durationMs = params.durationMinutes * 60_000;
  const startMs = Math.max(params.overlapStart.getTime(), params.earliestStart);
  const remainder = startMs % (30 * 60_000);
  let cursor = remainder === 0 ? startMs : startMs + (30 * 60_000 - remainder);

  while (cursor + durationMs <= params.overlapEnd.getTime()) {
    const end = cursor + durationMs;
    if (!hasConflict(cursor, end, params.eventWindows)) {
      slots.push({ start: new Date(cursor), end: new Date(end) });
    }
    cursor += 30 * 60_000;
  }

  return slots;
}

export function getValidMeetingSlots(
  preferences: SchedulingPreferences,
  calendarEvents: CalendarEventSummary[],
  maxSlots = 5
): MeetingSlotComputationResult {
  const now = preferences.now || new Date();
  const userTimezone = preferences.userTimezone || 'UTC';
  const clientTimezone = preferences.clientTimezone || userTimezone;
  const leadTimeMs = now.getTime() + 30 * 60 * 1000;
  const searchStartDate = preferences.searchStartDate || addDays(now, 1);
  const searchDays = Math.max(1, preferences.searchDays || 14);
  const eventWindows = calendarEvents.map((event) => ({
    start: new Date(event.start).getTime(),
    end: new Date(event.end).getTime(),
  }));

  const slots: SuggestedMeetingSlot[] = [];
  const skippedReasons: string[] = [];

  for (let dayOffset = 0; dayOffset < searchDays && slots.length < maxSlots; dayOffset += 1) {
    const candidateDate = addDays(searchStartDate, dayOffset);
    const dayLabel = formatDayLabel(candidateDate, userTimezone);
    const userDateKey = formatDateKey(getDateParts(candidateDate, userTimezone));
    const userStart = toUtc(userDateKey, preferences.workingHoursStart, userTimezone);
    const userEnd = toUtc(userDateKey, preferences.workingHoursEnd, userTimezone);

    const clientDateKey = formatDateKey(getDateParts(candidateDate, clientTimezone));
    const clientStart = toUtc(clientDateKey, '09:00', clientTimezone);
    const clientEnd = toUtc(clientDateKey, '19:00', clientTimezone);

    const overlapStart = new Date(Math.max(userStart.getTime(), clientStart.getTime()));
    const overlapEnd = new Date(Math.min(userEnd.getTime(), clientEnd.getTime()));
    if (overlapStart.getTime() >= overlapEnd.getTime()) {
      skippedReasons.push(`${dayLabel} was skipped because your working hours do not overlap with the client's availability window.`);
      continue;
    }

    const candidates = generateSlots({
      overlapStart,
      overlapEnd,
      durationMinutes: preferences.durationMinutes,
      eventWindows,
      earliestStart: leadTimeMs,
    });

    if (candidates.length === 0) {
      const effectiveStart = Math.max(overlapStart.getTime(), leadTimeMs);
      if (effectiveStart + preferences.durationMinutes * 60_000 > overlapEnd.getTime()) {
        skippedReasons.push(`${dayLabel} was skipped because the remaining overlap window is too short after minimum notice.`);
      } else {
        skippedReasons.push(`${dayLabel} was skipped because all matching slots are blocked by existing calendar events.`);
      }
    }

    for (const candidate of candidates) {
      slots.push({
        start: candidate.start.toISOString(),
        end: candidate.end.toISOString(),
        userDisplayTime: formatDisplayTime(candidate.start, userTimezone),
        clientDisplayTime: formatDisplayTime(candidate.start, clientTimezone),
        timezoneNote:
          preferences.clientTimezone && preferences.clientTimezone !== preferences.userTimezone
            ? `${preferences.userTimezone} / ${preferences.clientTimezone}`
            : preferences.clientTimezone
              ? null
              : 'Client timezone not set. Using your timezone as fallback.',
      });
      if (slots.length >= maxSlots) {
        break;
      }
    }
  }

  if (slots.length > 0) {
    return { slots, noOverlap: false, message: null, nearestOption: null, skippedReasons };
  }

  const nextCandidate = searchStartDate;
  const fallbackDateKey = formatDateKey(getDateParts(nextCandidate, userTimezone));
  const nearestStart = toUtc(fallbackDateKey, preferences.workingHoursEnd, userTimezone);
  return {
    slots: [],
    noOverlap: true,
    message: `No mutual availability found. Your working hours (${preferences.workingHoursStart}–${preferences.workingHoursEnd} ${preferences.userTimezone}) do not overlap with ${clientTimezone} 09:00–19:00.`,
    nearestOption: formatDisplayTime(nearestStart, userTimezone),
    skippedReasons,
  };
}

export function suggestMeetingSlots(
  preferences: SchedulingPreferences,
  calendarEvents: CalendarEventSummary[],
  maxSlots = 5
): MeetingSlotComputationResult {
  return getValidMeetingSlots(preferences, calendarEvents, maxSlots);
}
