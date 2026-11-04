'use client';

import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import { DateTimePicker } from '@/components/date-time-picker';
import { EmptyState, MetricCard, Panel, StatusPill } from '@/components/workspace-ui';

interface ProjectInvoiceItem {
  id: string;
  invoiceNumber: string;
  status: string;
  total: number;
  dueDate: string | null;
}

interface ProjectExpenseItem {
  id: string;
  description: string;
  amount: number;
  entryDate: string;
}

function currency(value: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value || 0);
}

export function ProjectFinanceWorkspace({
  projectId,
  initialInvoices,
  initialExpenses,
}: {
  projectId: string;
  initialInvoices: ProjectInvoiceItem[];
  initialExpenses: ProjectExpenseItem[];
}) {
  const router = useRouter();
  const [invoices, setInvoices] = useState(initialInvoices);
  const [expenses, setExpenses] = useState(initialExpenses);
  const [invoiceFormOpen, setInvoiceFormOpen] = useState(false);
  const [expenseFormOpen, setExpenseFormOpen] = useState(false);
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [invoiceTotal, setInvoiceTotal] = useState('');
  const [invoiceDueDate, setInvoiceDueDate] = useState('');
  const [expenseDescription, setExpenseDescription] = useState('');
  const [expenseAmount, setExpenseAmount] = useState('');
  const [expenseDate, setExpenseDate] = useState(new Date().toISOString().slice(0, 10));
  const [message, setMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<'invoice' | 'expense' | null>(null);
  const [pendingInvoiceId, setPendingInvoiceId] = useState<string | null>(null);

  const totalInvoiced = invoices.reduce((sum, invoice) => sum + invoice.total, 0);
  const paid = invoices.filter((invoice) => invoice.status === 'paid').reduce((sum, invoice) => sum + invoice.total, 0);
  const outstanding = totalInvoiced - paid;
  const totalExpenses = expenses.reduce((sum, expense) => sum + expense.amount, 0);

  const submitInvoice = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting('invoice');
    setMessage(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/finance`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'invoice',
          invoiceNumber,
          total: Number(invoiceTotal),
          dueDate: invoiceDueDate || null,
          status: 'draft',
          currency: 'USD',
        }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(data.error || 'Failed to save invoice');
      }
      setInvoices((current) => [
        {
          id: `local-${Date.now()}`,
          invoiceNumber,
          status: 'draft',
          total: Number(invoiceTotal),
          dueDate: invoiceDueDate || null,
        },
        ...current,
      ]);
      setInvoiceNumber('');
      setInvoiceTotal('');
      setInvoiceDueDate('');
      setInvoiceFormOpen(false);
      setMessage('Invoice saved.');
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to save invoice');
    } finally {
      setSubmitting(null);
    }
  };

  const submitExpense = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting('expense');
    setMessage(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/finance`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'expense',
          description: expenseDescription,
          amount: Number(expenseAmount),
          entryDate: expenseDate,
          currency: 'USD',
        }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(data.error || 'Failed to save expense');
      }
      setExpenses((current) => [
        {
          id: `local-${Date.now()}`,
          description: expenseDescription,
          amount: Number(expenseAmount),
          entryDate: expenseDate,
        },
        ...current,
      ]);
      setExpenseDescription('');
      setExpenseAmount('');
      setExpenseDate(new Date().toISOString().slice(0, 10));
      setExpenseFormOpen(false);
      setMessage('Expense saved.');
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to save expense');
    } finally {
      setSubmitting(null);
    }
  };

  const deleteInvoice = async (invoiceId: string) => {
    setPendingInvoiceId(invoiceId);
    setMessage(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/finance/${invoiceId}`, { method: 'DELETE' });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(data.error || 'Failed to delete invoice');
      }
      setInvoices((current) => current.filter((invoice) => invoice.id !== invoiceId));
      setMessage('Invoice deleted.');
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to delete invoice');
    } finally {
      setPendingInvoiceId(null);
    }
  };

  const updateInvoiceStatus = async (invoiceId: string, status: string) => {
    setPendingInvoiceId(invoiceId);
    setMessage(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/finance/${invoiceId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(data.error || 'Failed to update invoice status');
      }
      setInvoices((current) => current.map((invoice) => (invoice.id === invoiceId ? { ...invoice, status } : invoice)));
      setMessage('Invoice status updated.');
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to update invoice status');
    } finally {
      setPendingInvoiceId(null);
    }
  };

  return (
    <div className="page-stack">
      <div className="metrics-grid">
        <MetricCard label="Total Invoiced" value={currency(totalInvoiced)} hint="Project-linked invoices" />
        <MetricCard label="Paid" value={currency(paid)} hint="Collected" tone="success" />
        <MetricCard label="Outstanding" value={currency(outstanding)} hint="Pending collection" tone="warning" />
        <MetricCard label="Expenses" value={currency(totalExpenses)} hint="Tracked spend" tone="danger" />
      </div>

      <Panel
        title="Invoices"
        action={
          <button type="button" className="ghost-link-button" onClick={() => setInvoiceFormOpen((current) => !current)}>
            {invoiceFormOpen ? 'Close' : 'Add'}
          </button>
        }
      >
        {invoiceFormOpen ? (
          <form className="inline-form-grid" onSubmit={submitInvoice}>
            <input value={invoiceNumber} onChange={(event) => setInvoiceNumber(event.target.value)} placeholder="Invoice number" required />
            <input value={invoiceTotal} onChange={(event) => setInvoiceTotal(event.target.value)} placeholder="Total" inputMode="decimal" required />
            <DateTimePicker value={invoiceDueDate} onChange={setInvoiceDueDate} placeholder="Select due date" />
            <button type="submit" className="primary-action" disabled={submitting === 'invoice'}>
              {submitting === 'invoice' ? 'Saving...' : 'Save Invoice'}
            </button>
          </form>
        ) : null}

        {invoices.length > 0 ? (
          <div className="table-like-list">
            {invoices.map((invoice) => (
              <div key={invoice.id} className="table-like-row">
                <div>
                  <strong>{invoice.invoiceNumber}</strong>
                  <p>{invoice.dueDate ? new Date(invoice.dueDate).toLocaleDateString() : 'No due date'}</p>
                </div>
                <span>{currency(invoice.total)}</span>
                <StatusPill tone={invoice.status === 'paid' ? 'success' : invoice.status === 'sent' ? 'warning' : 'neutral'}>
                  {invoice.status === 'draft' ? 'Draft' : invoice.status}
                </StatusPill>
                <select
                  aria-label={`Status for invoice ${invoice.invoiceNumber}`}
                  value={invoice.status}
                  onChange={(event) => updateInvoiceStatus(invoice.id, event.target.value)}
                  disabled={pendingInvoiceId === invoice.id}
                >
                  {['draft', 'sent', 'paid', 'overdue', 'void'].map((status) => (
                    <option key={status} value={status}>
                      {status}
                    </option>
                  ))}
                </select>
                <a
                  className="ghost-link-button"
                  href={`/api/projects/${projectId}/finance/${invoice.id}/pdf`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open PDF
                </a>
                <button
                  type="button"
                  className="ghost-link-button danger-button"
                  onClick={() => deleteInvoice(invoice.id)}
                  disabled={pendingInvoiceId === invoice.id}
                >
                  {pendingInvoiceId === invoice.id ? 'Deleting...' : 'Delete'}
                </button>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState title="No invoices yet" description="Generate invoices through the assistant or add them manually." />
        )}
      </Panel>

      <Panel
        title="Expenses"
        action={
          <button type="button" className="ghost-link-button" onClick={() => setExpenseFormOpen((current) => !current)}>
            {expenseFormOpen ? 'Close' : 'Add'}
          </button>
        }
      >
        {expenseFormOpen ? (
          <form className="inline-form-grid" onSubmit={submitExpense}>
            <input value={expenseDescription} onChange={(event) => setExpenseDescription(event.target.value)} placeholder="Expense description" required />
            <input value={expenseAmount} onChange={(event) => setExpenseAmount(event.target.value)} placeholder="Amount" inputMode="decimal" required />
            <DateTimePicker value={expenseDate} onChange={setExpenseDate} placeholder="Select expense date" />
            <button type="submit" className="primary-action" disabled={submitting === 'expense'}>
              {submitting === 'expense' ? 'Saving...' : 'Save Expense'}
            </button>
          </form>
        ) : null}

        {expenses.length > 0 ? (
          <div className="table-like-list">
            {expenses.map((expense) => (
              <div key={expense.id} className="table-like-row">
                <div>
                  <strong>{expense.description}</strong>
                  <p>{new Date(expense.entryDate).toLocaleDateString()}</p>
                </div>
                <span>{currency(expense.amount)}</span>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState title="No expenses logged" description="Expenses you add or link from receipts will appear here." />
        )}
      </Panel>

      {message ? <p className="composer-hint">{message}</p> : null}
    </div>
  );
}
