import { NextResponse } from 'next/server';
import { getAssistantProfile } from '@/lib/assistant-profile';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/current-user';
import { buildInvoicePdfAttachment } from '@/lib/invoices/pdf';
import { ensureProjectScopedFinanceColumns } from '@/lib/workspace/schema';

export async function GET(_request: Request, { params }: { params: { projectId: string; invoiceId: string } }) {
  const current = await getCurrentUser();
  if (!current) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  await ensureProjectScopedFinanceColumns();

  const invoice = await db.queryOne<{
    invoice_number: string;
    issue_date: string | null;
    due_date: string | null;
    currency: string | null;
    total: string;
    notes: string | null;
    project_id: string;
    client_name: string | null;
    client_email: string | null;
  }>(
    `SELECT
       i.invoice_number,
       i.issue_date,
       i.due_date,
       i.currency,
       i.total::text as total,
       i.notes,
       i.project_id,
       c.name as client_name,
       c.primary_email as client_email
     FROM invoices i
     LEFT JOIN client_project_links cpl ON cpl.project_id = i.project_id AND cpl.user_id = i.user_id
     LEFT JOIN clients c ON c.id = cpl.client_id
     WHERE i.id = $1 AND i.user_id = $2 AND i.project_id = $3
     ORDER BY c.name ASC
     LIMIT 1`,
    [params.invoiceId, current.user.id, params.projectId]
  );

  if (!invoice) {
    return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
  }

  const lineItems = await db.query<{
    description: string;
    quantity: number | null;
    unit_amount: string | null;
    line_total: string;
  }>(
    `SELECT description, quantity, unit_amount::text as unit_amount, line_total::text as line_total
     FROM invoice_items
     WHERE invoice_id = $1
     ORDER BY sort_order ASC, created_at ASC`,
    [params.invoiceId]
  );

  const firmProfile = await getAssistantProfile(current.user.id);

  const pdf = await buildInvoicePdfAttachment({
    invoiceNumber: invoice.invoice_number,
    issueDate: invoice.issue_date || new Date().toISOString(),
    dueDate: invoice.due_date || new Date().toISOString(),
    currency: invoice.currency || 'USD',
    total: Number(invoice.total) || 0,
    senderName: firmProfile?.profile.firm_name || current.user.name || current.user.email,
    senderEmail: firmProfile?.profile.contact_email || current.user.email,
    senderWebsite: firmProfile?.profile.contact_website || null,
    senderAddress: firmProfile?.profile.address || null,
    recipientName: invoice.client_name,
    company: invoice.client_name,
    recipientEmail: invoice.client_email,
    notes: invoice.notes,
    paymentInstructions: null,
    items:
      lineItems.length > 0
        ? lineItems.map((item) => ({
            description: item.description,
            quantity: item.quantity || 1,
            unitPrice: Number(item.unit_amount || item.line_total) || 0,
            total: Number(item.line_total) || 0,
          }))
        : [
            {
              description: `Invoice ${invoice.invoice_number}`,
              quantity: 1,
              unitPrice: Number(invoice.total) || 0,
              total: Number(invoice.total) || 0,
            },
          ],
  });

  const filename = `${invoice.invoice_number.replace(/[^a-z0-9_-]+/gi, '-').toLowerCase() || 'invoice'}.pdf`;
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}
