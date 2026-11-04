'use client';

import { useState } from 'react';
import { PageHeader, Panel, EmptyState } from '@/components/workspace-ui';

interface CalendarEventItem {
  id: string;
  title: string;
  description: string;
  start: string;
  end: string;
  attendeeCount: number;
  noteContent?: string;
}

export function CalendarWorkspace({
  initialDateLabel,
  initialDateIso,
  initialEvents,
  calendarConnected = true,
}: {
  initialDateLabel: string;
  initialDateIso: string;
  initialEvents: CalendarEventItem[];
  calendarConnected?: boolean;
}) {
  const [dateIso, setDateIso] = useState(initialDateIso);
  const [dateLabel, setDateLabel] = useState(initialDateLabel);
  const [events, setEvents] = useState(initialEvents);
  const [dayPlan, setDayPlan] = useState<string | null>(null);
  const [meetingPrep, setMeetingPrep] = useState<Record<string, string>>({});
  const [pendingDayPlan, setPendingDayPlan] = useState(false);
  const [pendingPrepId, setPendingPrepId] = useState<string | null>(null);
  const [loadingDay, setLoadingDay] = useState(false);
  const [editingEventId, setEditingEventId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState<string>('');
  const [savingNote, setSavingNote] = useState(false);

  const loadDay = async (nextDate: Date) => {
    setLoadingDay(true);
    setDayPlan(null);
    setMeetingPrep({});
    try {
      const response = await fetch(`/api/calendar/day?date=${encodeURIComponent(nextDate.toISOString())}`);
      const data = (await response.json()) as {
        error?: string;
        date?: string;
        label?: string;
        events?: CalendarEventItem[];
      };
      if (!response.ok) {
        throw new Error(data.error || 'Failed to load calendar day');
      }
      setDateIso(data.date || nextDate.toISOString());
      setDateLabel(
        data.label || nextDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
      );
      setEvents(Array.isArray(data.events) ? data.events : []);
    } catch (error) {
      setDayPlan(error instanceof Error ? error.message : 'Failed to load day');
    } finally {
      setLoadingDay(false);
    }
  };

  const moveDay = async (offset: number) => {
    const nextDate = new Date(dateIso);
    nextDate.setDate(nextDate.getDate() + offset);
    await loadDay(nextDate);
  };

  const organizeMyDay = async () => {
    setPendingDayPlan(true);
    try {
      const response = await fetch('/api/calendar/organize-day', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ date: dateIso }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Failed to organise your day');
      }
      setDayPlan(data.reply);
    } catch (error) {
      setDayPlan(error instanceof Error ? error.message : 'Failed to organise your day');
    } finally {
      setPendingDayPlan(false);
    }
  };

  const generatePrep = async (event: CalendarEventItem) => {
    setPendingPrepId(event.id);
    try {
      const response = await fetch('/api/calendar/prep', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: event.title,
          description: event.description,
          start: event.start,
          end: event.end,
          attendeeCount: event.attendeeCount,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Failed to generate prep');
      }
      setMeetingPrep((current) => ({ ...current, [event.id]: data.reply }));
    } catch (error) {
      setMeetingPrep((current) => ({ ...current, [event.id]: error instanceof Error ? error.message : 'Failed to generate prep' }));
    } finally {
      setPendingPrepId(null);
    }
  };

  const openNotes = (event: CalendarEventItem) => {
    setEditingEventId(event.id);
    setNoteDraft(event.noteContent || '');
  };

  const saveNotes = async (event: CalendarEventItem) => {
    setSavingNote(true);
    try {
      const response = await fetch('/api/calendar/notes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          eventId: event.id,
          title: event.title,
          meetingDate: event.start,
          content: noteDraft,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Failed to save note');
      }
      setEvents((current) => current.map((item) => (item.id === event.id ? { ...item, noteContent: noteDraft } : item)));
      setEditingEventId(null);
      setNoteDraft('');
    } catch (error) {
      setNoteDraft(error instanceof Error ? error.message : 'Failed to save note');
    } finally {
      setSavingNote(false);
    }
  };

  return (
    <div className="page-stack">
      <PageHeader
        title={dateLabel}
        subtitle="Daily schedule, meeting preparation, and AI-generated planning."
        action={
          <div className="inline-button-row">
            <button type="button" className="ghost-link-button" onClick={() => moveDay(-1)} disabled={loadingDay}>
              Prev
            </button>
            <button type="button" className="ghost-link-button" onClick={() => loadDay(new Date())} disabled={loadingDay}>
              Today
            </button>
            <button type="button" className="ghost-link-button" onClick={() => moveDay(1)} disabled={loadingDay}>
              Next
            </button>
            <button type="button" className="primary-action" onClick={organizeMyDay} disabled={pendingDayPlan || loadingDay}>
              {pendingDayPlan ? 'Planning...' : 'Organise My Day'}
            </button>
          </div>
        }
      />

      <Panel title={`${events.length} meeting${events.length === 1 ? '' : 's'}`}>
        {loadingDay ? (
          <div className="calendar-output-box">
            <p>Loading schedule...</p>
          </div>
        ) : events.length > 0 ? (
          <div className="calendar-event-stack">
            {events.map((event) => (
              <div key={event.id} className="calendar-event-card">
                <div className="calendar-event-main">
                  <strong>{event.title}</strong>
                  <p>
                    {new Date(event.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} -{' '}
                    {new Date(event.end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} (
                    {Math.max(15, Math.round((new Date(event.end).getTime() - new Date(event.start).getTime()) / 60000))}m · {event.attendeeCount}{' '}
                    attendee{event.attendeeCount === 1 ? '' : 's'})
                  </p>
                  {event.noteContent ? <small>Notes saved</small> : null}
                </div>
                <div className="calendar-event-actions">
                  <button type="button" className="primary-action" onClick={() => generatePrep(event)} disabled={pendingPrepId === event.id}>
                    {pendingPrepId === event.id ? 'Preparing...' : 'Gen Prep'}
                  </button>
                  <button type="button" className="ghost-link-button" onClick={() => openNotes(event)}>
                    Add Notes
                  </button>
                </div>

                {meetingPrep[event.id] ? (
                  <div className="calendar-output-box">
                    <strong>Meeting Prep</strong>
                    <p>{meetingPrep[event.id]}</p>
                  </div>
                ) : null}

                {editingEventId === event.id ? (
                  <div className="calendar-output-box">
                    <strong>Meeting Notes</strong>
                    <textarea value={noteDraft} onChange={(eventInput) => setNoteDraft(eventInput.target.value)} rows={5} />
                    <div className="calendar-event-actions">
                      <button type="button" className="primary-action" onClick={() => saveNotes(event)} disabled={savingNote || !noteDraft.trim()}>
                        {savingNote ? 'Saving...' : 'Save Notes'}
                      </button>
                      <button type="button" className="ghost-link-button" onClick={() => setEditingEventId(null)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            title="No meetings scheduled"
            description={
              calendarConnected
                ? 'No events for this day. Try another date or add meetings in Google Calendar / Outlook.'
                : 'Connect your calendar in Settings (Nylas) to see your meetings here. Email and calendar use the same connection.'
            }
            actionHref={!calendarConnected ? '/settings' : undefined}
            actionLabel={!calendarConnected ? 'Open Settings' : undefined}
          />
        )}
      </Panel>

      {dayPlan ? (
        <Panel title="Day Plan">
          <div className="calendar-output-box">
            <p>{dayPlan}</p>
          </div>
        </Panel>
      ) : null}
    </div>
  );
}
