'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import type { ClientListItem } from '@/lib/product-data';

export function ProjectClientLink({
  projectId,
  linkedClientId,
  linkedClient,
  clients,
}: {
  projectId: string;
  linkedClientId: string | null;
  linkedClient: ClientListItem | null;
  clients: ClientListItem[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const handleChange = (value: string) => {
    const clientId = value === '' ? null : value;
    startTransition(async () => {
      const response = await fetch(`/api/projects/${projectId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientId }),
      });
      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        alert(data.error || 'Failed to update link');
        return;
      }
      router.refresh();
    });
  };

  return (
    <div className="project-client-link">
      <label htmlFor="project-client-select">
        <strong>Linked client</strong>
      </label>
      <p className="project-client-link-help">
        Link this project to a client so meeting slots and availability use that client&apos;s timezone. Set timezones in the Clients tab.
      </p>
      <select
        id="project-client-select"
        value={linkedClientId ?? ''}
        onChange={(e) => handleChange(e.target.value)}
        disabled={isPending}
        className="project-client-select"
      >
        <option value="">None</option>
        {clients.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
            {c.timezone ? ` (${c.timezone})` : ''}
          </option>
        ))}
      </select>
      {linkedClient && (
        <p className="project-client-link-note">
          Client timezone for this project: <strong>{linkedClient.timezone || 'Not set'}</strong>. Edit in Clients.
        </p>
      )}
    </div>
  );
}
