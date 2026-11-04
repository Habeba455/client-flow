'use client';

import { FormEvent, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { DateTimePicker } from '@/components/date-time-picker';
import { EmptyState, Panel, StatusPill } from '@/components/workspace-ui';

interface ProjectTodoItem {
  id: string;
  title: string;
  status: string;
  priority: string;
  dueAt: string | null;
}

type TodoFilter = 'all' | 'open' | 'high' | 'done';

export function ProjectTodosWorkspace({
  projectId,
  initialTodos,
}: {
  projectId: string;
  initialTodos: ProjectTodoItem[];
}) {
  const router = useRouter();
  const [todos, setTodos] = useState(initialTodos);
  const [filter, setFilter] = useState<TodoFilter>('all');
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState<'low' | 'medium' | 'high' | 'urgent'>('medium');
  const [dueAt, setDueAt] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [todoToDelete, setTodoToDelete] = useState<ProjectTodoItem | null>(null);

  const visibleTodos = useMemo(() => {
    switch (filter) {
      case 'open':
        return todos.filter((todo) => todo.status !== 'done' && todo.status !== 'completed');
      case 'high':
        return todos.filter((todo) => todo.priority === 'high' || todo.priority === 'urgent');
      case 'done':
        return todos.filter((todo) => todo.status === 'done' || todo.status === 'completed');
      default:
        return todos;
    }
  }, [filter, todos]);

  const addTodo = async (event: FormEvent) => {
    event.preventDefault();
    setPendingId('create');
    setMessage(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/todos`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title, priority, dueAt: dueAt || null }),
      });
      const data = (await response.json()) as {
        error?: string;
        todo?: { id: string; title: string; status: string; priority: string; due_at: string | null };
      };
      if (!response.ok || !data.todo) {
        throw new Error(data.error || 'Failed to add task');
      }
      const createdTodo = data.todo;
      setTodos((current) => [
        {
          id: createdTodo.id,
          title: createdTodo.title,
          status: createdTodo.status,
          priority: createdTodo.priority,
          dueAt: createdTodo.due_at,
        },
        ...current,
      ]);
      setTitle('');
      setPriority('medium');
      setDueAt('');
      setCreating(false);
      setMessage('Task added.');
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to add task');
    } finally {
      setPendingId(null);
    }
  };

  const updateTodo = async (todo: ProjectTodoItem, nextStatus: 'todo' | 'done') => {
    setPendingId(todo.id);
    setMessage(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/todos/${todo.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: nextStatus }),
      });
      const data = (await response.json()) as {
        error?: string;
        todo?: { id: string; title: string; status: string; priority: string; due_at: string | null };
      };
      if (!response.ok || !data.todo) {
        throw new Error(data.error || 'Failed to update task');
      }
      const updatedTodo = data.todo;
      setTodos((current) =>
        current.map((item) =>
          item.id === todo.id
            ? {
                id: updatedTodo.id,
                title: updatedTodo.title,
                status: updatedTodo.status,
                priority: updatedTodo.priority,
                dueAt: updatedTodo.due_at,
              }
            : item
        )
      );
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to update task');
    } finally {
      setPendingId(null);
    }
  };

  const deleteTodo = async (todo: ProjectTodoItem) => {
    setPendingId(todo.id);
    setMessage(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/todos/${todo.id}`, { method: 'DELETE' });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(data.error || 'Failed to delete task');
      }
      setTodos((current) => current.filter((item) => item.id !== todo.id));
      setTodoToDelete(null);
      setMessage('Task deleted.');
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to delete task');
    } finally {
      setPendingId(null);
    }
  };

  return (
    <Panel
      title="Project To-Dos"
      action={
        <div className="inline-status-row">
          <div className="email-filter-row">
            {(['all', 'open', 'high', 'done'] as TodoFilter[]).map((value) => (
              <button
                key={value}
                type="button"
                className={`status-pill filter-chip ${filter === value ? 'filter-chip-active' : ''}`}
                onClick={() => setFilter(value)}
              >
                {value}
              </button>
            ))}
          </div>
          <button type="button" className="primary-action" onClick={() => setCreating((current) => !current)}>
            {creating ? 'Close' : 'Add Task'}
          </button>
        </div>
      }
    >
      {creating ? (
        <form className="inline-form-grid" onSubmit={addTodo}>
          <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Task title" required />
          <select value={priority} onChange={(event) => setPriority(event.target.value as typeof priority)}>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="urgent">Urgent</option>
          </select>
          <DateTimePicker value={dueAt} onChange={setDueAt} includeTime placeholder="Select due date and time" />
          <button type="submit" className="primary-action" disabled={pendingId === 'create'}>
            {pendingId === 'create' ? 'Saving...' : 'Save Task'}
          </button>
        </form>
      ) : null}

      {visibleTodos.length > 0 ? (
        <div className="table-like-list">
          {visibleTodos.map((todo) => (
            <div key={todo.id} className="table-like-row">
              <div>
                <strong>{todo.title}</strong>
                <p>{todo.dueAt ? new Date(todo.dueAt).toLocaleString() : 'No due date'}</p>
              </div>
              <StatusPill tone={todo.priority === 'urgent' || todo.priority === 'high' ? 'danger' : todo.priority === 'medium' ? 'warning' : 'neutral'}>
                {todo.priority}
              </StatusPill>
              <StatusPill tone={todo.status === 'done' || todo.status === 'completed' ? 'success' : 'neutral'}>{todo.status}</StatusPill>
              <button
                type="button"
                className="ghost-link-button"
                onClick={() => updateTodo(todo, todo.status === 'done' ? 'todo' : 'done')}
                disabled={pendingId === todo.id}
              >
                {todo.status === 'done' ? 'Reopen' : 'Mark Done'}
              </button>
              <button
                type="button"
                className="ghost-link-button danger-button"
                onClick={() => setTodoToDelete(todo)}
                disabled={pendingId === todo.id}
                aria-label={`Delete ${todo.title}`}
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState title="No tasks here" description="Add one manually or generate them with AI from project updates." />
      )}

      {message ? <p className="composer-hint">{message}</p> : null}

      {todoToDelete ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="delete-todo-title">
          <div className="modal-card">
            <h3 id="delete-todo-title">Delete task?</h3>
            <p>
              Remove <strong>{todoToDelete.title}</strong>. This cannot be undone.
            </p>
            <div className="inline-button-row">
              <button type="button" className="ghost-link-button" onClick={() => setTodoToDelete(null)} disabled={!!pendingId}>
                Cancel
              </button>
              <button
                type="button"
                className="primary-action danger-button"
                onClick={() => deleteTodo(todoToDelete)}
                disabled={pendingId === todoToDelete.id}
              >
                {pendingId === todoToDelete.id ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </Panel>
  );
}
