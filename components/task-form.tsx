'use client';

import { useRouter } from 'next/navigation';
import { FormEvent, useState, useTransition } from 'react';
import { TASK_PRIORITIES, TASK_STATUSES } from '@/lib/tasks/constants';

export interface TaskFormInitial {
  id?: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  dueDate: string; // YYYY-MM-DD local or ''
  projectId: string | null;
}

export interface TaskProjectOption {
  id: string;
  name: string;
}

const STATUS_LABELS: Record<string, string> = { todo: 'To do', in_progress: 'In progress', done: 'Done', archived: 'Archived' };
const PRIORITY_LABELS: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High', urgent: 'Urgent' };

/** Converts an ISO timestamp to a YYYY-MM-DD string in the user's local calendar. */
export function toLocalDateInput(iso: string | null): string {
  if (!iso) return '';
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`;
}

export function TaskForm({
  mode,
  initial,
  projects,
  onClose,
}: {
  mode: 'create' | 'edit';
  initial: TaskFormInitial;
  projects: TaskProjectOption[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [values, setValues] = useState<TaskFormInitial>(initial);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const update = <K extends keyof TaskFormInitial>(key: K, value: TaskFormInitial[K]) =>
    setValues((current) => ({ ...current, [key]: value }));

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    if (!values.title.trim()) {
      setError('Task title is required.');
      return;
    }

    const payload = {
      title: values.title.trim(),
      description: values.description?.trim() || null,
      status: values.status,
      priority: values.priority,
      // Noon local avoids the date shifting by a day when the stored instant is read back in another zone.
      dueAt: values.dueDate ? new Date(`${values.dueDate}T12:00:00`).toISOString() : null,
      projectId: values.projectId || null,
    };

    startTransition(async () => {
      try {
        const response = await fetch(mode === 'create' ? '/api/tasks' : `/api/todos/${initial.id}`, {
          method: mode === 'create' ? 'POST' : 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        if (!response.ok) {
          setError(data.error || 'Could not save the task.');
          return;
        }
        onClose();
        router.refresh();
      } catch {
        setError('Network error. Check your connection and try again.');
      }
    });
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="task-form-title">
      <div className="modal-card modal-card-wide">
        <h3 id="task-form-title">{mode === 'create' ? 'New task' : 'Edit task'}</h3>
        <form onSubmit={submit} className="clients-form clients-form-compact">
          <label>
            Title
            <input value={values.title} onChange={(e) => update('title', e.target.value)} maxLength={300} required disabled={isPending} />
          </label>
          <label>
            Description
            <textarea
              value={values.description ?? ''}
              onChange={(e) => update('description', e.target.value)}
              maxLength={5000}
              rows={3}
              disabled={isPending}
            />
          </label>
          <label>
            Project
            <select value={values.projectId ?? ''} onChange={(e) => update('projectId', e.target.value || null)} disabled={isPending}>
              <option value="">No project</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Priority
            <select value={values.priority} onChange={(e) => update('priority', e.target.value)} disabled={isPending}>
              {TASK_PRIORITIES.map((priority) => (
                <option key={priority} value={priority}>
                  {PRIORITY_LABELS[priority]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Status
            <select value={values.status} onChange={(e) => update('status', e.target.value)} disabled={isPending}>
              {TASK_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {STATUS_LABELS[status]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Due date
            <input type="date" value={values.dueDate} onChange={(e) => update('dueDate', e.target.value)} disabled={isPending} />
          </label>

          {error ? <p className="error-text">{error}</p> : null}

          <div className="modal-actions">
            <button type="button" className="ghost-link-button" onClick={onClose} disabled={isPending}>
              Cancel
            </button>
            <button type="submit" className="primary-action" disabled={isPending}>
              {isPending ? 'Saving...' : mode === 'create' ? 'Create task' : 'Save changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
