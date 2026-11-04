import { CalendarWorkspace } from '@/components/calendar-workspace';
import { getCurrentUser } from '@/lib/current-user';
import { getPrimaryNylasGrant } from '@/lib/nylas/client';
import { getCalendarData } from '@/lib/product-data';

export default async function CalendarPage() {
  const current = await getCurrentUser();
  if (!current) {
    return null;
  }

  const today = new Date();
  const [events, grant] = await Promise.all([
    getCalendarData(current.user.id, today),
    getPrimaryNylasGrant(current.user.id),
  ]);

  return (
    <CalendarWorkspace
      initialDateIso={today.toISOString()}
      initialDateLabel={today.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
      initialEvents={events}
      calendarConnected={Boolean(grant?.grant_id)}
    />
  );
}
