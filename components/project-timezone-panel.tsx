'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

export function ProjectTimezonePanel({
  projectId,
  initialTimezone,
}: {
  projectId: string;
  initialTimezone: string | null;
}) {
  const router = useRouter();
  const [timezone, setTimezone] = useState(initialTimezone || '');
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const saveTimezone = () => {
    startTransition(async () => {
      setMessage(null);
      const response = await fetch(`/api/projects/${projectId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientTimezone: timezone.trim() || null }),
      });
      const data = (await response.json()) as { error?: string; clientTimezone?: string | null };
      if (!response.ok) {
        setMessage(data.error || 'Failed to save client timezone.');
        return;
      }
      setTimezone(data.clientTimezone || '');
      setMessage(data.clientTimezone ? `Client timezone saved: ${data.clientTimezone}` : 'Client timezone cleared.');
      router.refresh();
    });
  };

  return (
    <div className="project-timezone-panel">
      <div className="project-timezone-row">
        <input
          value={timezone}
          onChange={(event) => setTimezone(event.target.value)}
          placeholder="IANA timezone, e.g. Asia/Dubai"
          className="project-timezone-input"
        />
        <button type="button" className="ghost-link-button project-timezone-button" onClick={saveTimezone} disabled={isPending}>
          {isPending ? 'Saving...' : 'Save timezone'}
        </button>
      </div>
      <p className="project-timezone-help">
        Valid meeting slots use your working hours and the client 09:00-19:00 window in this timezone.
      </p>
      {message ? <p className="project-timezone-message">{message}</p> : null}
    </div>
  );
}
