import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/current-user';
import { ApiInputError, errorResponse, readEnum, readJsonObject } from '@/lib/api-validation';
import { INVOICE_STATUSES } from '@/lib/invoices/rules';
import { ensureProjectScopedFinanceColumns } from '@/lib/workspace/schema';

/** Change invoice status. Setting "paid" records paid_at; leaving "paid" clears it. */
export async function PATCH(request: NextRequest, { params }: { params: { projectId: string; invoiceId: string } }) {
  try {
    const current = await getCurrentUser();
    if (!current) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    await ensureProjectScopedFinanceColumns();

    const body = readJsonObject(await request.json().catch(() => null));
    const status = readEnum(body.status, 'Status', INVOICE_STATUSES);
    if (!status) throw new ApiInputError('Status is required.');

    const invoice = await db.queryOne<{ id: string; status: string }>(
      `UPDATE invoices
       SET status = $4,
           paid_at = CASE WHEN $4 = 'paid' THEN COALESCE(paid_at, NOW()) ELSE NULL END,
           updated_at = NOW()
       WHERE id = $1 AND user_id = $2 AND project_id = $3
       RETURNING id, status`,
      [params.invoiceId, current.user.id, params.projectId, status]
    );
    if (!invoice) throw new ApiInputError('Invoice not found', 404);

    return NextResponse.json({ ok: true, invoice });
  } catch (error) {
    return errorResponse(error, 'finance.invoice.update');
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: { projectId: string; invoiceId: string } }) {
  try {
    const current = await getCurrentUser();
    if (!current) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    await ensureProjectScopedFinanceColumns();

    // Items are removed in the same transaction so a failure cannot leave orphan rows.
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const invoice = await client.query<{ id: string }>(
        `SELECT id FROM invoices WHERE id = $1 AND user_id = $2 AND project_id = $3 FOR UPDATE`,
        [params.invoiceId, current.user.id, params.projectId]
      );
      if (!invoice.rows[0]) {
        await client.query('ROLLBACK');
        throw new ApiInputError('Invoice not found', 404);
      }
      await client.query(`DELETE FROM invoice_items WHERE invoice_id = $1`, [params.invoiceId]);
      await client.query(`DELETE FROM invoices WHERE id = $1`, [params.invoiceId]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error, 'finance.invoice.delete');
  }
}
