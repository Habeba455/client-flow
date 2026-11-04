'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ClientOption, ProjectForm, ProjectFormInitial } from '@/components/project-form';
import { ProjectTabs } from '@/components/project-tabs';
import { StatusPill } from '@/components/workspace-ui';

function formatStoredDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function ProjectHeader({
  projectId,
  name,
  description,
  status,
  openTasks,
  clientEntity,
  targetCompletion,
  projectType,
  editInitial,
  clients,
}: {
  projectId: string;
  name: string;
  description: string | null;
  status: string;
  openTasks: number;
  clientEntity?: string | null;
  targetCompletion?: string | null;
  projectType?: string | null;
  editInitial: ProjectFormInitial;
  clients: ClientOption[];
}) {
  const pathname = usePathname();
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [isPending, startTransition] = useTransition();

  const runSync = () => {
    startTransition(async () => {
      setSyncMessage(null);
      const response = await fetch(`/api/projects/${projectId}/sync`, { method: 'POST' });
      const data = await response.json();
      if (!response.ok) {
        setSyncMessage(data.error || 'Sync failed');
        return;
      }
      setSyncMessage(
        `Synced ${data.syncedEmails || 0} emails, ${data.syncedMeetings || 0} meetings, ${data.ingestedAttachments || 0} attachments, and ${
          data.generatedTodos || 0
        } AI-generated tasks`
      );
    });
  };

  return (
    <div className="project-header">
      <div className="project-header-top">
        <div>
          <Link href="/projects" className="back-link">
            Back to Projects
          </Link>
          <div className="project-title-row">
            <div className="project-avatar">{name.slice(0, 1).toUpperCase()}</div>
            <div>
              <h1 className="page-title">{name}</h1>
              <p className="page-subtitle">{description || 'No description added yet.'}</p>
              <p className="project-inline-meta">
                {[clientEntity, projectType, formatStoredDate(targetCompletion) ? `Target: ${formatStoredDate(targetCompletion)}` : null, `${openTasks} open tasks`]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
            </div>
          </div>
        </div>
        <div className="project-header-actions">
          <button type="button" className="ghost-link-button" onClick={() => setEditing(true)}>
            Edit
          </button>
          <button type="button" className="ghost-link-button" onClick={runSync} disabled={isPending}>
            {isPending ? 'Syncing...' : 'Sync'}
          </button>
          <StatusPill tone={status === 'active' ? 'success' : 'neutral'}>{status}</StatusPill>
        </div>
      </div>

      {editing ? <ProjectForm mode="edit" initial={editInitial} clients={clients} onClose={() => setEditing(false)} /> : null}
      {syncMessage ? <p className="project-inline-meta">{syncMessage}</p> : null}
      <ProjectTabs projectId={projectId} active={pathname} />
    </div>
  );
}
