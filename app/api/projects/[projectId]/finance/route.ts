import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/current-user';
import { ApiInputError, errorResponse, readEnum, readIsoDateTime, readJsonObject, readOptionalText } from '@/lib/api-validation';
import { INVOICE_STATUSES, linkedClientIdForProject, parseLineItems, resolveInvoiceTotal } from '@/lib/invoices/rules';
import { ensureProjectScopedFinanceColumns } from '@/lib/workspace/schema';

type FinanceBody =
  | {
      kind: 'invoice';
      invoiceNumber?: unknown;
      total?: unknown;
      dueDate?: unknown;
      currency?: unknown;
      status?: unknown;
      notes?: unknown;
      lineItems?: unknown;
    }
  | {
      kind: 'expense';
      description?: string;
      amount?: number;
      category?: string | null;
      entryDate?: string;
      currency?: string;
    };

export async function POST(request: NextRequest, { params }: { params: { projectId: string } }) {
  try {
    const current = await getCurrentUser();
    if (!current) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    await ensureProjectScopedFinanceColumns();

    const project = await db.queryOne<{ id: string }>(`SELECT id FROM projects WHERE id = $1 AND user_id = $2`, [
      params.projectId,
      current.user.id,
    ]);
    if (!project) throw new ApiInputError('Project not found', 404);

    const body = readJsonObject(await request.json().catch(() => null)) as unknown as FinanceBody;

    if (body.kind === 'invoice') {
      const invoiceNumber = readOptionalText(body.invoiceNumber, 'Invoice number', 60);
      if (!invoiceNumber) throw new ApiInputError('Invoice number is required.');

      const items = parseLineItems(body.lineItems);
      const total = resolveInvoiceTotal(body.total, items);
      const dueDate = readIsoDateTime(body.dueDate, 'Due date') ?? null;
      const status = readEnum(body.status, 'Status', INVOICE_STATUSES) ?? 'draft';
      const notes = readOptionalText(body.notes, 'Notes', 2000) ?? null;

      let currency = 'USD';
      if (body.currency !== undefined && body.currency !== null && body.currency !== '') {
        if (typeof body.currency !== 'string' || !/^[A-Za-z]{3}$/.test(body.currency.trim())) {
          throw new ApiInputError('Currency must be a 3-letter code such as USD.');
        }
        currency = body.currency.trim().toUpperCase();
      }

      const clientId = await linkedClientIdForProject(current.user.id, params.projectId);
      const invoiceId = randomUUID();
      const paidAt = status === 'paid' ? new Date().toISOString() : null;

      // Invoice and its items are saved together or not at all.
      const client = await db.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO invoices (
             id, user_id, client_id, project_id, invoice_number, share_token, status, currency,
             issue_date, due_date, subtotal, tax_rate, tax_amount, total, notes,
             document_url, created_at, updated_at, paid_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), $9::timestamptz, $10, NULL, NULL, $10, $11, NULL, NOW(), NOW(), $12::timestamptz)`,
          [
            invoiceId,
            current.user.id,
            clientId,
            params.projectId,
            invoiceNumber,
            randomUUID(),
            status,
            currency,
            dueDate,
            total,
            notes,
            paidAt,
          ]
        );
        for (let index = 0; index < items.length; index += 1) {
          const item = items[index];
          await client.query(
            `INSERT INTO invoice_items (id, invoice_id, description, quantity, unit_amount, line_total, sort_order, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
            [randomUUID(), invoiceId, item.description, item.quantity, item.unitAmount, item.lineTotal, index + 1]
          );
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }

      return NextResponse.json({ invoiceId, total, clientId }, { status: 201 });
    }

    // Expense branch (project-scoped). Global expenses go through /api/expenses.
    const description = typeof body.description === 'string' ? body.description.trim() : '';
    if (!description || typeof body.amount !== 'number' || !Number.isFinite(body.amount) || body.amount <= 0) {
      throw new ApiInputError('Expense description and a positive amount are required.');
    }

    const expenseId = randomUUID();
    await db.query(
      `INSERT INTO pnl_entries (
         id, user_id, type, description, category, amount, currency, entry_date, created_at, recurring_cadence,
         recurring_start_date, recurring_end_date, project_id
       )
       VALUES ($1, $2, 'expense', $3, $4, $5, $6, $7::date, NOW(), NULL, NULL, NULL, $8)`,
      [
        expenseId,
        current.user.id,
        description,
        body.category || null,
        Math.round(body.amount * 100) / 100,
        body.currency?.trim() || 'USD',
        body.entryDate || new Date().toISOString().slice(0, 10),
        params.projectId,
      ]
    );

    return NextResponse.json({ expenseId }, { status: 201 });
  } catch (error) {
    return errorResponse(error, 'finance.create');
  }
}
