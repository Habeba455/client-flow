'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { RefreshCw } from 'lucide-react';
import { ConfirmModal } from '@/components/confirm-modal';
import { useToast } from '@/components/toast-provider';
import { EmptyState, PageHeader, StatusPill } from '@/components/workspace-ui';
import type { ClientEmailSummaryItem, ClientListItem, ClientMeetingItem, ProjectListItem } from '@/lib/product-data';
import { resolveTimezoneInput } from '@/lib/timezones';

type ClientDetailResponse = {
  ok: boolean;
  client: ClientListItem;
  linkedProjects: Array<{ id: string; name: string; status: string }>;
  upcomingMeetings: ClientMeetingItem[];
  previousMeetings: ClientMeetingItem[];
  emailSummaries: ClientEmailSummaryItem[];
  allProjects: ProjectListItem[];
};

type ClientFormState = {
  name: string;
  timezone: string;
  company: string;
  primaryEmail: string;
  website: string;
  location: string;
  relationshipNotes: string;
};

const EMPTY_FORM: ClientFormState = {
  name: '',
  timezone: '',
  company: '',
  primaryEmail: '',
  website: '',
  location: '',
  relationshipNotes: '',
};

function formFromClient(client: ClientListItem | null): ClientFormState {
  if (!client) return EMPTY_FORM;
  return {
    name: client.name,
    timezone: client.timezone || '',
    company: client.company || '',
    primaryEmail: client.primaryEmail || '',
    website: client.website || '',
    location: client.location || '',
    relationshipNotes: client.relationshipNotes || '',
  };
}

function formatStamp(value: string | null): string {
  if (!value) return 'Never';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString('en-US', { month: 'short', day: 'numeric' });
}

function clientMatchesQuery(client: ClientListItem, query: string): boolean {
  const haystack = [client.name, client.company, client.primaryEmail, client.location, client.timezone].filter(Boolean).join(' ').toLowerCase();
  return haystack.includes(query.toLowerCase());
}

function TimezoneHint({ value }: { value: string }) {
  const resolved = value.trim() ? resolveTimezoneInput(value) : null;
  if (!value.trim()) {
    return <p className="clients-field-hint">Type a city, country, or timezone. Example: `Colombo`, `Sri Lanka`, or `Asia/Colombo`.</p>;
  }
  if (resolved) {
    return <p className="clients-field-hint success">Resolved timezone: {resolved}</p>;
  }
  return <p className="clients-field-hint error">Timezone not recognized yet.</p>;
}

function AccordionStamp({
  count,
  onRefresh,
  disabled,
  label,
}: {
  count: number | string;
  onRefresh: () => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <span className="clients-accordion-tools">
      <button
        type="button"
        className="clients-refresh-button"
        aria-label={`Refresh ${label}`}
        title={`Refresh ${label}`}
        disabled={disabled}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onRefresh();
        }}
      >
        <RefreshCw size={14} />
      </button>
      <span className="clients-stamp">{count}</span>
    </span>
  );
}

export function ClientsWorkspace({ initialClients }: { initialClients: ClientListItem[] }) {
  const { pushToast } = useToast();
  const [clients, setClients] = useState(initialClients);
  const [selectedId, setSelectedId] = useState(initialClients[0]?.id ?? null);
  const [selectedClient, setSelectedClient] = useState<ClientListItem | null>(initialClients[0] ?? null);
  const [linkedProjects, setLinkedProjects] = useState<Array<{ id: string; name: string; status: string }>>([]);
  const [allProjects, setAllProjects] = useState<ProjectListItem[]>([]);
  const [upcomingMeetings, setUpcomingMeetings] = useState<ClientMeetingItem[]>([]);
  const [previousMeetings, setPreviousMeetings] = useState<ClientMeetingItem[]>([]);
  const [emailSummaries, setEmailSummaries] = useState<ClientEmailSummaryItem[]>([]);
  const [createForm, setCreateForm] = useState<ClientFormState>(EMPTY_FORM);
  const [editForm, setEditForm] = useState<ClientFormState>(formFromClient(initialClients[0] ?? null));
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [search, setSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(initialClients.length === 0);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);

  const filteredClients = useMemo(
    () => clients.filter((client) => clientMatchesQuery(client, search)),
    [clients, search]
  );

  const selectedSummary = useMemo(() => clients.find((client) => client.id === selectedId) || null, [clients, selectedId]);

  useEffect(() => {
    setSelectedClient(selectedSummary);
    setEditForm(formFromClient(selectedSummary));
  }, [selectedSummary]);

  useEffect(() => {
    if (!selectedId) {
      setLinkedProjects([]);
      return;
    }

    let cancelled = false;
    setLoadingDetail(true);
    fetch(`/api/clients/${selectedId}`)
      .then(async (response) => {
        const data = (await response.json()) as ClientDetailResponse | { error?: string };
        if (!response.ok) {
          throw new Error('error' in data ? data.error || 'Failed to load client' : 'Failed to load client');
        }
        return data as ClientDetailResponse;
      })
      .then((data) => {
        if (cancelled) return;
        setSelectedClient(data.client);
        setLinkedProjects(data.linkedProjects);
        setAllProjects(data.allProjects);
        setUpcomingMeetings(data.upcomingMeetings);
        setPreviousMeetings(data.previousMeetings);
        setEmailSummaries(data.emailSummaries);
        setClients((prev) => prev.map((item) => (item.id === data.client.id ? data.client : item)));
        setEditForm(formFromClient(data.client));
      })
      .catch((error) => {
        if (!cancelled) {
          setMessage(error instanceof Error ? error.message : 'Failed to load client');
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingDetail(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const refreshSelected = async (id: string) => {
    const response = await fetch(`/api/clients/${id}`);
    const data = (await response.json()) as ClientDetailResponse;
    setSelectedClient(data.client);
    setLinkedProjects(data.linkedProjects);
    setAllProjects(data.allProjects);
    setUpcomingMeetings(data.upcomingMeetings);
    setPreviousMeetings(data.previousMeetings);
    setEmailSummaries(data.emailSummaries);
    setClients((prev) => prev.map((item) => (item.id === id ? data.client : item)).sort((a, b) => a.name.localeCompare(b.name)));
    setEditForm(formFromClient(data.client));
  };

  const saveNew = async (event: FormEvent) => {
    event.preventDefault();
    if (!createForm.name.trim()) {
      setMessage('Client name is required.');
      pushToast('Client name is required.', 'error');
      return;
    }

    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch('/api/clients', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...createForm,
          name: createForm.name.trim(),
          timezone: createForm.timezone.trim() || null,
        }),
      });
      const data = (await response.json()) as { error?: string; client?: ClientListItem };
      if (!response.ok || !data.client) {
        throw new Error(data.error || 'Failed to add client');
      }
      const nextClients = [...clients, data.client].sort((a, b) => a.name.localeCompare(b.name));
      setClients(nextClients);
      setCreateForm(EMPTY_FORM);
      setCreateOpen(false);
      setSelectedId(data.client.id);
      setMessage('Client added.');
      pushToast('Client added.', 'success');
    } catch (error) {
      const nextMessage = error instanceof Error ? error.message : 'Failed to add client';
      setMessage(nextMessage);
      pushToast(nextMessage, 'error');
    } finally {
      setSaving(false);
    }
  };

  const saveEdit = async () => {
    if (!selectedId) return;
    if (!editForm.name.trim()) {
      setMessage('Client name cannot be empty.');
      pushToast('Client name cannot be empty.', 'error');
      return;
    }

    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/clients/${selectedId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...editForm,
          name: editForm.name.trim(),
          timezone: editForm.timezone.trim() || null,
        }),
      });
      const data = (await response.json()) as { error?: string; client?: ClientListItem };
      if (!response.ok || !data.client) {
        throw new Error(data.error || 'Failed to update client');
      }
      setClients((prev) => prev.map((item) => (item.id === data.client!.id ? data.client! : item)).sort((a, b) => a.name.localeCompare(b.name)));
      setSelectedClient(data.client);
      setMessage('Client updated.');
      pushToast('Client updated.', 'success');
    } catch (error) {
      const nextMessage = error instanceof Error ? error.message : 'Failed to update client';
      setMessage(nextMessage);
      pushToast(nextMessage, 'error');
    } finally {
      setSaving(false);
    }
  };

  const runAction = async (action: 'enrich') => {
    if (!selectedId) return;
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/clients/${selectedId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(data.error || `Failed to ${action}`);
      }
      await refreshSelected(selectedId);
      setMessage('Client enrichment updated.');
      pushToast('Client enrichment updated.', 'success');
    } catch (error) {
      const nextMessage = error instanceof Error ? error.message : `Failed to ${action}`;
      setMessage(nextMessage);
      pushToast(nextMessage, 'error');
    } finally {
      setSaving(false);
    }
  };

  const deleteClient = async () => {
    if (!selectedId) return;
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/clients/${selectedId}`, { method: 'DELETE' });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(data.error || 'Failed to delete client');
      }
      const nextClients = clients.filter((item) => item.id !== selectedId);
      setClients(nextClients);
      setSelectedId(nextClients[0]?.id ?? null);
      setSelectedClient(nextClients[0] ?? null);
      setLinkedProjects([]);
      setUpcomingMeetings([]);
      setPreviousMeetings([]);
      setEmailSummaries([]);
      setConfirmDeleteOpen(false);
      setMessage('Client removed.');
      pushToast('Client removed.', 'success');
    } catch (error) {
      const nextMessage = error instanceof Error ? error.message : 'Failed to delete client';
      setMessage(nextMessage);
      pushToast(nextMessage, 'error');
    } finally {
      setSaving(false);
    }
  };

  const saveLinkedProjects = async (projectIds: string[]) => {
    if (!selectedId) return;
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/clients/${selectedId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ linkedProjectIds: projectIds }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(data.error || 'Failed to update project links');
      }
      await refreshSelected(selectedId);
      pushToast('Project links updated.', 'success');
    } catch (error) {
      const nextMessage = error instanceof Error ? error.message : 'Failed to update project links';
      setMessage(nextMessage);
      pushToast(nextMessage, 'error');
    } finally {
      setSaving(false);
    }
  };

  const linkedProjectIdSet = useMemo(() => new Set(linkedProjects.map((project) => project.id)), [linkedProjects]);

  return (
    <div className="page-stack">
      <PageHeader
        title="Clients"
        subtitle="Client records should stay compact: scan the list, then open only the sections you need."
        action={
          <button type="button" className="primary-action" onClick={() => setCreateOpen((prev) => !prev)}>
            {createOpen ? 'Hide New Client' : 'New Client'}
          </button>
        }
      />

      {message ? <p className="clients-message">{message}</p> : null}

      <div className="clients-shell">
        <section className="clients-rail">
          <div className="clients-rail-header">
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search clients"
              className="clients-search-input"
            />
            <span className="clients-count">{filteredClients.length} clients</span>
          </div>

          {createOpen ? (
            <details open className="clients-create-card">
              <summary>Create Client</summary>
              <form onSubmit={saveNew} className="clients-form clients-form-compact">
                <div className="form-row">
                  <label htmlFor="client-name">Name</label>
                  <input id="client-name" value={createForm.name} onChange={(e) => setCreateForm((prev) => ({ ...prev, name: e.target.value }))} />
                </div>
                <div className="form-row">
                  <label htmlFor="client-timezone">Timezone</label>
                  <input
                    id="client-timezone"
                    value={createForm.timezone}
                    onChange={(e) => setCreateForm((prev) => ({ ...prev, timezone: e.target.value }))}
                    onBlur={() => {
                      const resolved = resolveTimezoneInput(createForm.timezone);
                      if (resolved) {
                        setCreateForm((prev) => ({ ...prev, timezone: resolved }));
                      }
                    }}
                    placeholder="Colombo, Sri Lanka, or Asia/Colombo"
                  />
                  <TimezoneHint value={createForm.timezone} />
                </div>
                <div className="form-row">
                  <label htmlFor="client-company">Company</label>
                  <input id="client-company" value={createForm.company} onChange={(e) => setCreateForm((prev) => ({ ...prev, company: e.target.value }))} />
                </div>
                <div className="form-row">
                  <label htmlFor="client-email">Primary Email</label>
                  <input id="client-email" value={createForm.primaryEmail} onChange={(e) => setCreateForm((prev) => ({ ...prev, primaryEmail: e.target.value }))} />
                </div>
                <button type="submit" className="primary-action" disabled={saving}>
                  {saving ? 'Saving...' : 'Add client'}
                </button>
              </form>
            </details>
          ) : null}

          <div className="clients-rail-list">
            {filteredClients.length === 0 ? (
              <EmptyState title="No matching clients" description="Try a different search or add a new client." />
            ) : (
              <ul className="clients-list clients-list-rail">
                {filteredClients.map((client) => (
                  <li key={client.id}>
                    <button
                      type="button"
                      className={`clients-rail-item${client.id === selectedId ? ' is-selected' : ''}`}
                      onClick={() => {
                        setSelectedId(client.id);
                        setMessage(null);
                      }}
                    >
                      <div className="clients-rail-main">
                        <strong>{client.name}</strong>
                        <span>{client.company || client.primaryEmail || 'No company or email yet'}</span>
                      </div>
                      <div className="clients-rail-tags">
                        <span className="clients-mini-pill">{client.timezone || 'No timezone'}</span>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        <section className="clients-detail-pane">
          {!selectedClient ? (
            <EmptyState title="Select a client" description="Pick a client from the left rail to open their profile, linked projects, meetings, and email history." />
          ) : loadingDetail ? (
            <div className="clients-detail-card">
              <p className="clients-message">Loading client detail...</p>
            </div>
          ) : (
            <div className="clients-detail-card">
              <div className="clients-hero">
                <div>
                  <p className="clients-eyebrow">Client Record</p>
                  <h2>{selectedClient.name}</h2>
                  <p className="clients-hero-subtitle">
                    {selectedClient.company || 'Independent contact'}
                    {selectedClient.primaryEmail ? ` · ${selectedClient.primaryEmail}` : ''}
                  </p>
                </div>
                <div className="clients-hero-meta">
                  <span className="clients-mini-pill">{selectedClient.timezone || 'No timezone'}</span>
                  <span className="clients-mini-pill">{linkedProjects.length} linked project{linkedProjects.length === 1 ? '' : 's'}</span>
                </div>
              </div>

              <div className="clients-action-bar">
                <button type="button" className="ghost-link-button" onClick={() => setEditForm(formFromClient(selectedClient))} disabled={saving}>
                  Reset
                </button>
                <button type="button" className="ghost-link-button" onClick={() => runAction('enrich')} disabled={saving}>
                  {saving ? 'Working...' : 'Refresh Enrichment'}
                </button>
                <button
                  type="button"
                  className="ghost-link-button danger-link"
                  onClick={() => setConfirmDeleteOpen(true)}
                  disabled={saving}
                >
                  Delete
                </button>
                <button type="button" className="primary-action" onClick={saveEdit} disabled={saving}>
                  {saving ? 'Saving...' : 'Save'}
                </button>
              </div>

              <div className="clients-accordion-stack">
                <details open className="clients-accordion">
                  <summary>
                    <span>Profile</span>
                    <span className="clients-stamp">Editable</span>
                  </summary>
                  <div className="clients-accordion-body">
                    <div className="clients-edit-grid clients-edit-grid-split">
                      <label className="clients-field">
                        <span>Name</span>
                        <input value={editForm.name} onChange={(e) => setEditForm((prev) => ({ ...prev, name: e.target.value }))} />
                      </label>
                      <label className="clients-field">
                        <span>Timezone</span>
                        <input
                          value={editForm.timezone}
                          onChange={(e) => setEditForm((prev) => ({ ...prev, timezone: e.target.value }))}
                          onBlur={() => {
                            const resolved = resolveTimezoneInput(editForm.timezone);
                            if (resolved) {
                              setEditForm((prev) => ({ ...prev, timezone: resolved }));
                            }
                          }}
                          placeholder="Colombo, Sri Lanka, or Asia/Colombo"
                        />
                        <TimezoneHint value={editForm.timezone} />
                      </label>
                      <label className="clients-field">
                        <span>Company</span>
                        <input value={editForm.company} onChange={(e) => setEditForm((prev) => ({ ...prev, company: e.target.value }))} />
                      </label>
                      <label className="clients-field">
                        <span>Primary Email</span>
                        <input value={editForm.primaryEmail} onChange={(e) => setEditForm((prev) => ({ ...prev, primaryEmail: e.target.value }))} />
                      </label>
                      <label className="clients-field">
                        <span>Website</span>
                        <input value={editForm.website} onChange={(e) => setEditForm((prev) => ({ ...prev, website: e.target.value }))} />
                      </label>
                      <label className="clients-field">
                        <span>Location</span>
                        <input value={editForm.location} onChange={(e) => setEditForm((prev) => ({ ...prev, location: e.target.value }))} />
                      </label>
                      <label className="clients-field clients-field-full">
                        <span>Relationship Notes</span>
                        <textarea value={editForm.relationshipNotes} onChange={(e) => setEditForm((prev) => ({ ...prev, relationshipNotes: e.target.value }))} />
                      </label>
                    </div>
                  </div>
                </details>

                <details className="clients-accordion">
                  <summary>
                    <span>Linked Projects</span>
                    <AccordionStamp count={linkedProjects.length} onRefresh={() => void refreshSelected(selectedId!)} disabled={loadingDetail || saving || !selectedId} label="linked projects" />
                  </summary>
                  <div className="clients-accordion-body">
                    <div className="clients-linked-projects-panel">
                      <div className="clients-linked-projects-selector">
                        <div className="clients-linked-projects-heading">
                          <strong>Attach this client to projects</strong>
                          <p>Select any active or completed project this client should belong to.</p>
                        </div>
                        {allProjects.length > 0 ? (
                          <div className="clients-project-choice-list">
                            {allProjects.map((project) => {
                              const checked = linkedProjectIdSet.has(project.id);
                              return (
                                <button
                                  key={project.id}
                                  type="button"
                                  className={`clients-project-choice${checked ? ' is-selected' : ''}`}
                                  onClick={() => {
                                    const nextIds = checked
                                      ? linkedProjects.map((item) => item.id).filter((id) => id !== project.id)
                                      : [...linkedProjects.map((item) => item.id), project.id];
                                    void saveLinkedProjects(nextIds);
                                  }}
                                  disabled={saving}
                                >
                                  <div className="clients-project-choice-copy">
                                    <strong>{project.name}</strong>
                                    <span>{project.status}</span>
                                  </div>
                                  <span className={`clients-project-choice-indicator${checked ? ' is-selected' : ''}`}>
                                    {checked ? 'Linked' : 'Link'}
                                  </span>
                                </button>
                              );
                            })}
                          </div>
                        ) : (
                          <p className="clients-message">No projects available yet.</p>
                        )}
                      </div>

                      <div className="clients-linked-projects-summary">
                        <div className="clients-linked-projects-heading">
                          <strong>Currently linked</strong>
                          <p>Open a linked project directly from here.</p>
                        </div>
                        {linkedProjects.length > 0 ? (
                          <div className="clients-linked-projects-stack">
                            {linkedProjects.map((project) => (
                              <div key={project.id} className="clients-linked-project-card">
                                <div>
                                  <strong>{project.name}</strong>
                                  <p>{project.status}</p>
                                </div>
                                <Link href={`/projects/${project.id}`} className="ghost-link-button">
                                  Open
                                </Link>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="clients-linked-projects-empty">
                            <strong>No linked projects yet</strong>
                            <p>Use the selector to attach this client to one or more projects.</p>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </details>

                <details className="clients-accordion">
                  <summary>
                    <span>Upcoming Meetings</span>
                    <AccordionStamp count={upcomingMeetings.length} onRefresh={() => void refreshSelected(selectedId!)} disabled={loadingDetail || saving || !selectedId} label="upcoming meetings" />
                  </summary>
                  <div className="clients-accordion-body">
                    {upcomingMeetings.length > 0 ? (
                      <div className="clients-project-list">
                        {upcomingMeetings.map((meeting) => (
                          <div key={meeting.id} className="clients-project-row clients-context-row">
                            <div>
                              <strong>{meeting.title}</strong>
                              <p>{meeting.meetingDate ? new Date(meeting.meetingDate).toLocaleString() : 'Date not set'}</p>
                              <p>{meeting.projectName ? `Project: ${meeting.projectName}` : 'Standalone meeting'}</p>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="clients-message">No upcoming meetings recorded for this client yet.</p>
                    )}
                  </div>
                </details>

                <details className="clients-accordion">
                  <summary>
                    <span>Previous Meetings / Notes</span>
                    <AccordionStamp count={previousMeetings.length} onRefresh={() => void refreshSelected(selectedId!)} disabled={loadingDetail || saving || !selectedId} label="previous meetings" />
                  </summary>
                  <div className="clients-accordion-body">
                    {previousMeetings.length > 0 ? (
                      <div className="clients-context-stack">
                        {previousMeetings.map((meeting) => (
                          <div key={meeting.id} className="clients-context-card">
                            <strong>{meeting.title}</strong>
                            <p>{meeting.meetingDate ? new Date(meeting.meetingDate).toLocaleString() : 'Date not set'}</p>
                            {meeting.projectName ? <p>Project: {meeting.projectName}</p> : null}
                            <div className="clients-rich-text">{meeting.content || 'No meeting notes recorded.'}</div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="clients-message">No previous meeting notes recorded for this client yet.</p>
                    )}
                  </div>
                </details>

                <details className="clients-accordion">
                  <summary>
                    <span>Email Discussion Summaries</span>
                    <AccordionStamp count={emailSummaries.length} onRefresh={() => void refreshSelected(selectedId!)} disabled={loadingDetail || saving || !selectedId} label="email summaries" />
                  </summary>
                  <div className="clients-accordion-body">
                    {emailSummaries.length > 0 ? (
                      <div className="clients-context-stack">
                        {emailSummaries.map((email) => (
                          <div key={email.id} className="clients-context-card">
                            <div className="clients-recommendation-header">
                              <strong>{email.subject}</strong>
                              {email.replyNeeded ? <StatusPill tone="warning">Reply needed</StatusPill> : null}
                            </div>
                            <p>{email.lastMessageAt ? new Date(email.lastMessageAt).toLocaleString() : 'No recent date recorded'}</p>
                            {email.projectName ? <p>Project: {email.projectName}</p> : null}
                            <div className="clients-rich-text">{email.summary}</div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="clients-message">No summarized email discussions available for this client yet.</p>
                    )}
                  </div>
                </details>

                <details className="clients-accordion">
                  <summary>
                    <span>Client Enrichment</span>
                    <span className="clients-accordion-tools">
                      <button
                        type="button"
                        className="clients-refresh-button"
                        aria-label="Refresh client enrichment"
                        title="Refresh client enrichment"
                        disabled={loadingDetail || saving || !selectedId}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          void runAction('enrich');
                        }}
                      >
                        <RefreshCw size={14} />
                      </button>
                      <span className="clients-stamp">Updated {formatStamp(selectedClient.enrichmentUpdatedAt)}</span>
                    </span>
                  </summary>
                  <div className="clients-accordion-body">
                    {selectedClient.enrichmentSummary ? (
                      <>
                        <div className="clients-rich-text">{selectedClient.enrichmentSummary}</div>
                        {selectedClient.enrichmentSources.length > 0 ? (
                          <div className="clients-source-list">
                            {selectedClient.enrichmentSources.map((source) => (
                              <a key={source.url} href={source.url} target="_blank" rel="noreferrer" className="clients-source-item">
                                <strong>{source.title}</strong>
                                <span>{source.url}</span>
                              </a>
                            ))}
                          </div>
                        ) : null}
                      </>
                    ) : (
                      <p className="clients-message">No enrichment yet. Run enrichment when you need research context.</p>
                    )}
                  </div>
                </details>

              </div>
            </div>
          )}
        </section>
      </div>

      <ConfirmModal
        open={confirmDeleteOpen}
        title="Delete client?"
        description={`This will remove ${selectedClient?.name || 'this client'} from your workspace. Linked projects remain, but this client record will be deleted.`}
        confirmLabel="Delete client"
        pending={saving}
        onConfirm={deleteClient}
        onCancel={() => setConfirmDeleteOpen(false)}
      />
    </div>
  );
}
