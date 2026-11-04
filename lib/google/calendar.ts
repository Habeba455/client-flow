import { nylasGrantRequest } from '@/lib/nylas/client';

interface NylasParticipant {
  email?: string | null;
}

interface NylasTimespan {
  start_time?: number | string | null;
  end_time?: number | string | null;
  startTime?: number | string | null;
  endTime?: number | string | null;
}

interface NylasEventRecord {
  id: string;
  title?: string | null;
  description?: string | null;
  when?: NylasTimespan | null;
  participants?: NylasParticipant[];
}

interface NylasListResponse<T> {
  data?: T[];
}

interface NylasItemResponse<T> {
  data?: T;
}

export interface CalendarEventSummary {
  id: string;
  title: string;
  description: string;
  start: string;
  end: string;
  attendeeCount: number;
  attendeeEmails: string[];
}

export interface CalendarEventCreateInput {
  title: string;
  description: string;
  start: string;
  end: string;
  attendees: string[];
  location?: string | null;
  videoLink?: 'google_meet' | 'teams' | 'zoom' | null;
}

export interface CalendarEventCreateResult {
  id: string;
  htmlLink?: string;
  hangoutLink?: string;
}

function toIso(value: number | string | null | undefined): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value > 9_999_999_999 ? value : value * 1000).toISOString();
  }
  if (typeof value === 'string' && value.trim()) {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber) && value.trim().length <= 13) {
      return new Date(asNumber > 9_999_999_999 ? asNumber : asNumber * 1000).toISOString();
    }
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}

function normalizeEvent(item: NylasEventRecord): CalendarEventSummary | null {
  const when = item.when;
  const start = when ? toIso(when.start_time ?? when.startTime) : null;
  const end = when ? toIso(when.end_time ?? when.endTime) : null;
  if (!start || !end) {
    return null;
  }

  return {
    id: item.id,
    title: item.title?.trim() || 'Meeting',
    description: item.description?.trim() || '',
    start,
    end,
    attendeeCount: item.participants?.length || 0,
    attendeeEmails: (item.participants || []).map((participant) => participant.email || '').filter(Boolean),
  };
}

function toUnixSeconds(value: string): number {
  return Math.floor(new Date(value).getTime() / 1000);
}

export async function fetchGoogleCalendarEvents(userId: string, options?: { timeMin?: string; timeMax?: string; maxResults?: number }): Promise<CalendarEventSummary[]> {
  try {
    const search = new URLSearchParams();
    search.set('calendar_id', 'primary');
    search.set('limit', String(options?.maxResults ?? 50));
    if (options?.timeMin) {
      search.set('start', String(toUnixSeconds(options.timeMin)));
    }
    if (options?.timeMax) {
      search.set('end', String(toUnixSeconds(options.timeMax)));
    }
    search.set('expand_recurring', 'true');

    const response = await nylasGrantRequest<NylasListResponse<NylasEventRecord>>(userId, `/events?${search.toString()}`);
    if (!response) {
      return [];
    }
    const rawList = Array.isArray(response) ? response : response?.data ?? [];
    return rawList.map(normalizeEvent).filter((item): item is CalendarEventSummary => Boolean(item));
  } catch (err) {
    console.warn('[calendar] Nylas events fetch failed:', err instanceof Error ? err.message : err);
    return [];
  }
}

export async function createGoogleCalendarEvent(
  userId: string,
  input: CalendarEventCreateInput
): Promise<CalendarEventCreateResult | null> {
  const response = await nylasGrantRequest<NylasItemResponse<{ id?: string }>>(userId, '/events?calendar_id=primary&notify_participants=true', {
    method: 'POST',
    body: JSON.stringify({
      title: input.title,
      description: input.description,
      location: input.location || undefined,
      when: {
        start_time: toUnixSeconds(input.start),
        end_time: toUnixSeconds(input.end),
      },
      participants: input.attendees.map((email) => ({ email })),
    }),
  });

  if (!response?.data?.id) {
    return null;
  }

  return {
    id: response.data.id,
  };
}
