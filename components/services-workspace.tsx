'use client';

import { FormEvent, useState } from 'react';
import { ConfirmModal } from '@/components/confirm-modal';
import { EmptyState, PageHeader, Panel, StatusPill } from '@/components/workspace-ui';
import type { ServiceListItem } from '@/lib/product-data';

type ServiceFormState = {
  id?: string;
  name: string;
  code: string;
  category: string;
  description: string;
  estimatedDuration: string;
  basePrice: string;
  currency: string;
};

const EMPTY_FORM: ServiceFormState = {
  name: '',
  code: '',
  category: '',
  description: '',
  estimatedDuration: '',
  basePrice: '',
  currency: 'USD',
};

function formFromService(service: ServiceListItem): ServiceFormState {
  return {
    id: service.id,
    name: service.name,
    code: service.code,
    category: service.category,
    description: service.description || '',
    estimatedDuration: service.estimatedDuration || '',
    basePrice: service.basePrice === null ? '' : String(service.basePrice),
    currency: service.currency || 'USD',
  };
}

export function ServicesWorkspace({ initialServices }: { initialServices: ServiceListItem[] }) {
  const [services, setServices] = useState(initialServices);
  const [form, setForm] = useState<ServiceFormState>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!form.name.trim() || !form.category.trim()) {
      setMessage('Service name and category are required.');
      return;
    }

    setSaving(true);
    setMessage(null);
    try {
      const method = editingId ? 'PATCH' : 'POST';
      const response = await fetch('/api/services', {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: editingId,
          name: form.name.trim(),
          code: form.code.trim() || undefined,
          category: form.category.trim(),
          description: form.description.trim() || null,
          estimatedDuration: form.estimatedDuration.trim() || null,
          basePrice: form.basePrice.trim() ? Number(form.basePrice) : null,
          currency: form.currency.trim() || 'USD',
        }),
      });
      const data = (await response.json()) as { error?: string; services?: ServiceListItem[] };
      if (!response.ok || !data.services) {
        throw new Error(data.error || 'Failed to save service');
      }
      setServices(data.services);
      setForm(EMPTY_FORM);
      setEditingId(null);
      setMessage(editingId ? 'Service updated.' : 'Service added.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to save service');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/services?id=${id}`, { method: 'DELETE' });
      const data = (await response.json()) as { error?: string; services?: ServiceListItem[] };
      if (!response.ok || !data.services) {
        throw new Error(data.error || 'Failed to delete service');
      }
      setServices(data.services);
      if (editingId === id) {
        setEditingId(null);
        setForm(EMPTY_FORM);
      }
      setConfirmDeleteId(null);
      setMessage('Service deleted.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to delete service');
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (service: ServiceListItem) => {
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch('/api/services', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: service.id, isActive: !service.isActive }),
      });
      const data = (await response.json()) as { error?: string; services?: ServiceListItem[] };
      if (!response.ok || !data.services) {
        throw new Error(data.error || 'Failed to update service');
      }
      setServices(data.services);
      setMessage(service.isActive ? 'Service archived.' : 'Service reactivated.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to update service');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="page-stack">
      <PageHeader
        title="Services"
        subtitle="Build the catalog the recommendation engine can actually use."
      />

      <div className="clients-shell">
        <Panel title={editingId ? 'Edit Service' : 'Add Service'}>
          <form onSubmit={submit} className="clients-form">
            <div className="form-row">
              <label htmlFor="service-name">Service Name</label>
              <input id="service-name" value={form.name} onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))} />
            </div>
            <div className="form-row">
              <label htmlFor="service-code">Code</label>
              <input id="service-code" value={form.code} onChange={(e) => setForm((prev) => ({ ...prev, code: e.target.value }))} placeholder="Optional" />
            </div>
            <div className="form-row">
              <label htmlFor="service-category">Category</label>
              <input id="service-category" value={form.category} onChange={(e) => setForm((prev) => ({ ...prev, category: e.target.value }))} />
            </div>
            <div className="form-row">
              <label htmlFor="service-duration">Estimated Duration</label>
              <input id="service-duration" value={form.estimatedDuration} onChange={(e) => setForm((prev) => ({ ...prev, estimatedDuration: e.target.value }))} />
            </div>
            <div className="form-row">
              <label htmlFor="service-price">Base Price</label>
              <input id="service-price" value={form.basePrice} onChange={(e) => setForm((prev) => ({ ...prev, basePrice: e.target.value }))} />
            </div>
            <div className="form-row">
              <label htmlFor="service-currency">Currency</label>
              <input id="service-currency" value={form.currency} onChange={(e) => setForm((prev) => ({ ...prev, currency: e.target.value }))} />
            </div>
            <div className="form-row">
              <label htmlFor="service-description">Description</label>
              <textarea id="service-description" value={form.description} onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))} />
            </div>
            <div className="inline-button-row">
              <button type="submit" className="primary-action" disabled={saving}>
                {saving ? 'Saving...' : editingId ? 'Update service' : 'Add service'}
              </button>
              {editingId ? (
                <button
                  type="button"
                  className="ghost-link-button"
                  onClick={() => {
                    setEditingId(null);
                    setForm(EMPTY_FORM);
                  }}
                >
                  Cancel
                </button>
              ) : null}
            </div>
            {message ? <p className="clients-message">{message}</p> : null}
          </form>
        </Panel>

        <Panel title="Catalog">
          {services.length === 0 ? (
            <EmptyState title="No services yet" description="Add services here, then use Get Recommendations from the Clients page." />
          ) : (
            <div className="services-table">
              {services.map((service) => (
                <div key={service.id} className="services-row">
                  <div>
                    <strong>{service.name}</strong>
                    <p>{service.code} · {service.category}</p>
                    <p>{service.description || 'No description'}</p>
                  </div>
                  <div className="services-row-meta">
                    <StatusPill tone={service.isActive ? 'success' : 'neutral'}>{service.isActive ? 'Active' : 'Archived'}</StatusPill>
                    <button type="button" className="ghost-link-button" onClick={() => {
                      setEditingId(service.id);
                      setForm(formFromService(service));
                    }}>
                      Edit
                    </button>
                    <button type="button" className="ghost-link-button" onClick={() => toggleActive(service)}>
                      {service.isActive ? 'Archive' : 'Reactivate'}
                    </button>
                    <button type="button" className="ghost-link-button danger-link" onClick={() => setConfirmDeleteId(service.id)}>
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>

      <ConfirmModal
        open={Boolean(confirmDeleteId)}
        title="Delete service?"
        description="This will remove the service from your catalog. It will no longer be available for client recommendations."
        confirmLabel="Delete service"
        pending={saving}
        onConfirm={() => {
          if (confirmDeleteId) {
            void remove(confirmDeleteId);
          }
        }}
        onCancel={() => setConfirmDeleteId(null)}
      />
    </div>
  );
}
