'use client';

import { useRouter } from 'next/navigation';
import { FormEvent, useState, useTransition } from 'react';
import { PROJECT_STATUSES } from '@/lib/tasks/constants';

export interface ProjectFormInitial {
  id?: string;
  name: string;
  description: string | null;
  status: string;
  projectType: string | null;
  targetCompletion: string | null; // YYYY-MM-DD or null
  clientId: string | null;
}

export interface ClientOption {
  id: string;
  name: string;
}

export function ProjectForm({
  mode,
  initial,
  clients,
  onClose,
}: {
  mode: 'create' | 'edit';
  initial: ProjectFormInitial;
  clients: ClientOption[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [values, setValues] = useState<ProjectFormInitial>(initial);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // Keep a legacy/AI-set status visible so editing other fields never silently changes it.
  const statusOptions = (PROJECT_STATUSES as readonly string[]).includes(initial.status)
    ? [...PROJECT_STATUSES]
    : [...PROJECT_STATUSES, initial.status];

  const update = <K extends keyof ProjectFormInitial>(key: K, value: ProjectFormInitial[K]) =>
    setValues((current) => ({ ...current, [key]: value }));

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    if (!values.name.trim()) {
      setError('Project name is required.');
      return;
    }

    const payload: Record<string, unknown> = {
      name: values.name.trim(),
      description: values.description?.trim() || null,
      projectType: values.projectType?.trim() || null,
      targetCompletion: values.targetCompletion || null,
    };
    if (mode === 'create') {
      payload.status = values.status;
      payload.clientId = values.clientId;
    } else {
      if (values.status !== initial.status) payload.status = values.status;
      if (values.clientId !== initial.clientId) payload.clientId = values.clientId;
    }

    startTransition(async () => {
      try {
        const response = await fetch(mode === 'create' ? '/api/projects' : `/api/projects/${initial.id}`, {
          method: mode === 'create' ? 'POST' : 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = (await response.json().catch(() => ({}))) as { error?: string; project?: { id: string } };
        if (!response.ok) {
          setError(data.error || 'Could not save the project.');
          return;
        }
        onClose();
        if (mode === 'create' && data.project?.id) {
          router.push(`/projects/${data.project.id}`);
        } else {
          router.refresh();
        }
      } catch {
        setError('Network error. Check your connection and try again.');
      }
    });
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="project-form-title">
      <div className="modal-card modal-card-wide">
        <h3 id="project-form-title">{mode === 'create' ? 'New project' : 'Edit project'}</h3>
        <form onSubmit={submit} className="clients-form clients-form-compact">
          <label>
            Name
            <input value={values.name} onChange={(e) => update('name', e.target.value)} maxLength={200} required disabled={isPending} />
          </label>
          <label>
            Description
            <textarea
              value={values.description ?? ''}
              onChange={(e) => update('description', e.target.value)}
              maxLength={2000}
              rows={3}
              disabled={isPending}
            />
          </label>
          <label>
            Project type
            <input value={values.projectType ?? ''} onChange={(e) => update('projectType', e.target.value)} maxLength={100} disabled={isPending} />
          </label>
          <label>
            Target date
            <input
              type="date"
              value={values.targetCompletion ?? ''}
              onChange={(e) => update('targetCompletion', e.target.value || null)}
              disabled={isPending}
            />
          </label>
          <label>
            Status
            <select value={values.status} onChange={(e) => update('status', e.target.value)} disabled={isPending}>
              {statusOptions.map((status) => (
                <option key={status} value={status}>
                  {status === 'active' ? 'Active' : status === 'archived' ? 'Archived' : status}
                </option>
              ))}
            </select>
          </label>
          <label>
            Linked client
            <select
              value={values.clientId ?? ''}
              onChange={(e) => update('clientId', e.target.value || null)}
              disabled={isPending}
            >
              <option value="">None</option>
              {clients.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name}
                </option>
              ))}
            </select>
          </label>

          {error ? <p className="error-text">{error}</p> : null}

          <div className="modal-actions">
            <button type="button" className="ghost-link-button" onClick={onClose} disabled={isPending}>
              Cancel
            </button>
            <button type="submit" className="primary-action" disabled={isPending}>
              {isPending ? 'Saving...' : mode === 'create' ? 'Create project' : 'Save changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
