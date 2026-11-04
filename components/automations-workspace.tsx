'use client';

import { FormEvent, useState } from 'react';
import { EmptyState, PageHeader, Panel, StatusPill } from '@/components/workspace-ui';

interface AutomationItem {
  id: string;
  type: string;
  cron_expression: string;
  enabled: boolean;
  config: Record<string, unknown> | null;
  last_run_at: string | null;
  next_run_at: string | null;
}

export function AutomationsWorkspace({ initialAutomations }: { initialAutomations: AutomationItem[] }) {
  const [automations, setAutomations] = useState(initialAutomations);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [type, setType] = useState('assistant_automation');
  const [cronExpression, setCronExpression] = useState('0 * * * *');
  const [prompt, setPrompt] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const resetForm = () => {
    setType('assistant_automation');
    setCronExpression('0 * * * *');
    setPrompt('');
    setEditingId(null);
    setCreating(false);
  };

  const saveAutomation = async (event: FormEvent) => {
    event.preventDefault();
    setPendingId(editingId || 'create');
    setMessage(null);
    try {
      const response = await fetch(editingId ? `/api/automations/${editingId}` : '/api/automations', {
        method: editingId ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type,
          cronExpression,
          config: { prompt },
          enabled: true,
        }),
      });
      const data = (await response.json()) as { error?: string; automation?: AutomationItem };
      if (!response.ok || !data.automation) {
        throw new Error(data.error || 'Failed to save automation');
      }

      const savedAutomation = data.automation;

      setAutomations((current) => {
        if (editingId) {
          return current.map((item) => (item.id === savedAutomation.id ? savedAutomation : item));
        }
        return [savedAutomation, ...current];
      });

      resetForm();
      setMessage('Automation saved.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to save automation');
    } finally {
      setPendingId(null);
    }
  };

  const toggleAutomation = async (item: AutomationItem) => {
    setPendingId(item.id);
    setMessage(null);
    try {
      const response = await fetch(`/api/automations/${item.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: !item.enabled }),
      });
      const data = (await response.json()) as { error?: string; automation?: AutomationItem };
      if (!response.ok || !data.automation) {
        throw new Error(data.error || 'Failed to update automation');
      }
      const updatedAutomation = data.automation;
      setAutomations((current) => current.map((entry) => (entry.id === item.id ? updatedAutomation : entry)));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to update automation');
    } finally {
      setPendingId(null);
    }
  };

  const deleteAutomation = async (item: AutomationItem) => {
    setPendingId(item.id);
    setMessage(null);
    try {
      const response = await fetch(`/api/automations/${item.id}`, {
        method: 'DELETE',
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(data.error || 'Failed to delete automation');
      }
      setAutomations((current) => current.filter((entry) => entry.id !== item.id));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to delete automation');
    } finally {
      setPendingId(null);
    }
  };

  const startEdit = (item: AutomationItem) => {
    setEditingId(item.id);
    setCreating(true);
    setType(item.type);
    setCronExpression(item.cron_expression);
    setPrompt(typeof item.config?.prompt === 'string' ? item.config.prompt : '');
  };

  return (
    <div className="page-stack">
      <PageHeader
        title="Automations"
        subtitle="Repeatable AI-powered tasks that run on a schedule."
        action={
          <button type="button" className="primary-action" onClick={() => setCreating((current) => !current)}>
            {creating ? 'Close' : 'New Automation'}
          </button>
        }
      />

      {creating ? (
        <Panel title={editingId ? 'Edit Automation' : 'New Automation'}>
          <form className="inline-form-grid" onSubmit={saveAutomation}>
            <input value={type} onChange={(event) => setType(event.target.value)} placeholder="Type" required />
            <input value={cronExpression} onChange={(event) => setCronExpression(event.target.value)} placeholder="Cron expression" required />
            <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={3} placeholder="Describe what this automation should do" required />
            <div className="inline-button-row">
              <button type="submit" className="primary-action" disabled={Boolean(pendingId)}>
                {pendingId === (editingId || 'create') ? 'Saving...' : editingId ? 'Update Automation' : 'Create Automation'}
              </button>
              <button type="button" className="ghost-link-button" onClick={resetForm}>
                Cancel
              </button>
            </div>
          </form>
        </Panel>
      ) : null}

      <Panel title="Active Jobs">
        {automations.length > 0 ? (
          <div className="automation-list">
            {automations.map((job) => (
              <div key={job.id} className="automation-card automation-card-detailed">
                <div>
                  <div className="inline-status-row">
                    <strong>{job.type}</strong>
                    <StatusPill tone={job.enabled ? 'success' : 'neutral'}>{job.enabled ? 'active' : 'paused'}</StatusPill>
                  </div>
                  <p>{typeof job.config?.prompt === 'string' ? job.config.prompt : 'Natural-language automation configuration'}</p>
                  <small>
                    {job.cron_expression} · Last run {job.last_run_at ? new Date(job.last_run_at).toLocaleString() : 'never'} · Next run{' '}
                    {job.next_run_at ? new Date(job.next_run_at).toLocaleString() : 'not scheduled'}
                  </small>
                </div>
                <div className="automation-actions">
                  <button type="button" className="ghost-link-button" onClick={() => toggleAutomation(job)} disabled={pendingId === job.id}>
                    {job.enabled ? 'Pause' : 'Resume'}
                  </button>
                  <button type="button" className="ghost-link-button" onClick={() => startEdit(job)} disabled={pendingId === job.id}>
                    Edit
                  </button>
                  <button type="button" className="ghost-link-button danger-button" onClick={() => deleteAutomation(job)} disabled={pendingId === job.id}>
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState title="No automations yet" description="Create scheduled research, reporting, and follow-up jobs here." />
        )}
      </Panel>

      {message ? <p className="composer-hint">{message}</p> : null}
    </div>
  );
}
