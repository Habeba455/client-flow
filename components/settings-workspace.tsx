'use client';

import { FormEvent, useState } from 'react';
import { PageHeader, Panel, StatusPill } from '@/components/workspace-ui';
import type { UserProfile } from '@/lib/ai/types';
import type { ConnectedAccounts } from '@/lib/product-data';

export function SettingsWorkspace({
  initialProfile,
  accounts,
}: {
  initialProfile: UserProfile | null;
  accounts: ConnectedAccounts;
}) {
  const [address, setAddress] = useState(initialProfile?.address || '');
  const [timezone, setTimezone] = useState(initialProfile?.user_timezone || 'UTC');
  const [workingStart, setWorkingStart] = useState(initialProfile?.working_hours_start || '09:00');
  const [workingEnd, setWorkingEnd] = useState(initialProfile?.working_hours_end || '17:00');
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch('/api/settings/profile', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          address,
          user_timezone: timezone,
          working_hours_start: workingStart,
          working_hours_end: workingEnd,
        }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(data.error || 'Failed to save settings');
      }
      setMessage('Scheduling settings saved.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="page-stack">
      <PageHeader title="Settings" subtitle="Assistant profile, connected accounts, and scheduling preferences." />

      <div className="two-column-grid">
        <Panel title="Assistant Profile">
          <div className="settings-list">
            <div>
              <strong>Firm Name</strong>
              <p>{initialProfile?.firm_name || 'Not configured'}</p>
            </div>
            <div>
              <strong>Primary Industry</strong>
              <p>{initialProfile?.primary_industry || 'Not configured'}</p>
            </div>
            <div>
              <strong>Services</strong>
              <p>{initialProfile?.services.join(', ') || 'Not configured'}</p>
            </div>
            <div>
              <strong>Positioning</strong>
              <p>{initialProfile?.positioning || 'Not configured'}</p>
            </div>
          </div>
        </Panel>

        <Panel title="Connected Accounts">
          <div className="settings-list">
            <div className="settings-row">
              <strong>Email via Nylas</strong>
              <StatusPill tone={accounts.emailConnected ? 'success' : 'warning'}>{accounts.emailConnected ? 'Connected' : 'Not connected'}</StatusPill>
            </div>
            <div className="settings-row">
              <strong>Calendar via Nylas</strong>
              <StatusPill tone={accounts.calendarConnected ? 'success' : 'warning'}>
                {accounts.calendarConnected ? 'Connected' : 'Not connected'}
              </StatusPill>
            </div>
            <div className="settings-row">
              <strong>Document storage</strong>
              <StatusPill tone="neutral">Workspace downloads</StatusPill>
            </div>
            {accounts.accountEmail ? (
              <div>
                <strong>Connected account</strong>
                <p>{accounts.accountEmail}{accounts.providerLabel ? ` · ${accounts.providerLabel}` : ''}</p>
              </div>
            ) : null}
            {accounts.connectAvailable ? (
              <div className="inline-button-row">
                <a href="/api/nylas/connect?provider=google&redirect=/settings" className="ghost-link-button">
                  Connect Google
                </a>
                <a href="/api/nylas/connect?provider=microsoft&redirect=/settings" className="ghost-link-button">
                  Connect Microsoft
                </a>
              </div>
            ) : (
              <p className="composer-hint">Add `NYLAS_API_KEY` and `NYLAS_CLIENT_ID` to enable account connections.</p>
            )}
          </div>
        </Panel>
      </div>

      <Panel title="Scheduling Preferences">
        <form className="inline-form-grid" onSubmit={save}>
          <input value={timezone} onChange={(event) => setTimezone(event.target.value)} placeholder="IANA timezone, e.g. Asia/Dubai" required />
          <input value={workingStart} onChange={(event) => setWorkingStart(event.target.value)} type="time" required />
          <input value={workingEnd} onChange={(event) => setWorkingEnd(event.target.value)} type="time" required />
          <input value={address} onChange={(event) => setAddress(event.target.value)} placeholder="Firm address for invoices" />
          <button type="submit" className="primary-action" disabled={saving}>
            {saving ? 'Saving...' : 'Save Settings'}
          </button>
        </form>
        {message ? <p className="composer-hint">{message}</p> : null}
      </Panel>
    </div>
  );
}
