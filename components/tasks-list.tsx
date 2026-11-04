'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { EmptyState, Panel, StatusPill } from '@/components/workspace-ui';
import { TaskForm, TaskFormInitial, TaskProjectOption, toLocalDateInput } from '@/components/task-form';

export interface TaskItem {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  due_at: string | null;
  project_id: string | null;
  project_name: string | null;
}

const isDone = (status: string) => status === 'done' || status === 'completed';

export function TasksList({ tasks, projects }: { tasks: TaskItem[]; projects: TaskProjectOption[] }) {
  const router = useRouter();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [taskToDelete, setTaskToDelete] = useState<TaskItem | null>(null);
  const [editing, setEditing] = useState<TaskFormInitial | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toInitial = (task: TaskItem): TaskFormInitial => ({
    id: task.id,
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    dueDate: toLocalDateInput(task.due_at),
    projectId: task.project_id,
  });

  const toggleDone = async (task: TaskItem) => {
    setPendingId(task.id);
    setError(null);
    try {
      const response = await fetch(`/api/todos/${task.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: isDone(task.status) ? 'todo' : 'done' }),
      });
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(data.error || 'Could not update the task');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update the task');
    } finally {
      setPendingId(null);
    }
  };

  const deleteTask = async (task: TaskItem) => {
    setPendingId(task.id);
    setError(null);
    try {
      const response = await fetch(`/api/todos/${task.id}`, { method: 'DELETE' });
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(data.error || 'Failed to delete task');
      setTaskToDelete(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete task');
    } finally {
      setPendingId(null);
    }
  };

  const toolbar = (
    <div className="inline-button-row" style={{ justifyContent: 'flex-end', marginBottom: '0.75rem' }}>
      <button type="button" className="primary-action" onClick={() => setCreating(true)}>
        New task
      </button>
    </div>
  );

  return (
    <>
      <Panel title="All Tasks">
        {toolbar}
        {error ? <p className="error-text">{error}</p> : null}
        {tasks.length === 0 ? (
          <EmptyState
            title="No tasks yet"
            description="Create a task manually, or let the assistant generate tasks from emails and meetings."
          />
        ) : (
          <div className="table-like-list">
            {tasks.map((task) => (
              <div key={task.id} className="table-like-row">
                <div>
                  <strong>{task.title}</strong>
                  <p>{task.project_name || 'No project linked'}</p>
                </div>
                <StatusPill tone={task.priority === 'high' || task.priority === 'urgent' ? 'danger' : task.priority === 'medium' ? 'warning' : 'neutral'}>
                  {task.priority}
                </StatusPill>
                <StatusPill tone={isDone(task.status) ? 'success' : 'neutral'}>{task.status}</StatusPill>
                <span>{task.due_at ? new Date(task.due_at).toLocaleDateString() : 'No due date'}</span>
                <div className="inline-button-row">
                  <button
                    type="button"
                    className="ghost-link-button"
                    onClick={() => toggleDone(task)}
                    disabled={pendingId === task.id}
                  >
                    {isDone(task.status) ? 'Reopen' : 'Mark done'}
                  </button>
                  <button type="button" className="ghost-link-button" onClick={() => setEditing(toInitial(task))} disabled={pendingId === task.id}>
                    Edit
                  </button>
                  <button
                    type="button"
                    className="ghost-link-button danger-button"
                    onClick={() => setTaskToDelete(task)}
                    disabled={pendingId === task.id}
                    aria-label={`Delete ${task.title}`}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>

      {creating ? (
        <TaskForm
          mode="create"
          initial={{ title: '', description: null, status: 'todo', priority: 'medium', dueDate: '', projectId: null }}
          projects={projects}
          onClose={() => setCreating(false)}
        />
      ) : null}

      {editing ? <TaskForm mode="edit" initial={editing} projects={projects} onClose={() => setEditing(null)} /> : null}

      {taskToDelete ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="delete-task-title">
          <div className="modal-card">
            <h3 id="delete-task-title">Delete task?</h3>
            <p>
              Remove <strong>{taskToDelete.title}</strong>. This cannot be undone.
            </p>
            <div className="inline-button-row">
              <button type="button" className="ghost-link-button" onClick={() => setTaskToDelete(null)} disabled={!!pendingId}>
                Cancel
              </button>
              <button
                type="button"
                className="primary-action danger-button"
                onClick={() => deleteTask(taskToDelete)}
                disabled={pendingId === taskToDelete.id}
              >
                {pendingId === taskToDelete.id ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
