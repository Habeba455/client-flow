import { db } from '@/lib/db';
import { ApiInputError } from '@/lib/api-validation';

export const INVOICE_STATUSES = ['draft', 'sent', 'paid', 'overdue', 'void'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export interface InvoiceLineItem {
  description: string;
  quantity: number;
  unitAmount: number;
  lineTotal: number;
}

export function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function toAmount(value: unknown, field: string): number {
  const parsed = typeof value === 'string' ? Number(value.replace(/,/g, '')) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) {
    throw new ApiInputError(`${field} must be a number.`);
  }
  return parsed;
}

/** Validates client-supplied line items. Missing lineTotal is derived from quantity x unitAmount. */
export function parseLineItems(raw: unknown): InvoiceLineItem[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ApiInputError('Line items must be a list.');

  return raw.map((entry, index) => {
    const label = `Line item ${index + 1}`;
    if (!entry || typeof entry !== 'object') throw new ApiInputError(`${label} is invalid.`);
    const item = entry as Record<string, unknown>;

    const description = typeof item.description === 'string' ? item.description.trim() : '';
    if (!description) throw new ApiInputError(`${label} needs a description.`);

    const quantity = item.quantity === undefined ? 1 : toAmount(item.quantity, `${label} quantity`);
    if (quantity <= 0) throw new ApiInputError(`${label} quantity must be greater than zero.`);

    const unitAmount = item.unitAmount === undefined ? undefined : toAmount(item.unitAmount, `${label} unit amount`);
    const lineTotal =
      item.lineTotal !== undefined
        ? toAmount(item.lineTotal, `${label} total`)
        : unitAmount !== undefined
          ? roundMoney(quantity * unitAmount)
          : undefined;
    if (lineTotal === undefined || lineTotal < 0) {
      throw new ApiInputError(`${label} needs a total or a unit amount.`);
    }

    return {
      description,
      quantity,
      unitAmount: unitAmount ?? roundMoney(lineTotal / quantity),
      lineTotal: roundMoney(lineTotal),
    };
  });
}

/**
 * Invoice total is the sum of line items when items exist; a submitted total that disagrees is rejected
 * rather than silently saved. Without items, the submitted total is used.
 */
export function resolveInvoiceTotal(submitted: unknown, items: InvoiceLineItem[]): number {
  if (items.length > 0) {
    const itemsTotal = roundMoney(items.reduce((sum, item) => sum + item.lineTotal, 0));
    if (itemsTotal <= 0) throw new ApiInputError('Invoice total must be greater than zero.');
    if (submitted !== undefined && submitted !== null && submitted !== '') {
      if (Math.abs(toAmount(submitted, 'Total') - itemsTotal) > 0.005) {
        throw new ApiInputError(`Invoice total must equal the line items total (${itemsTotal.toFixed(2)}).`);
      }
    }
    return itemsTotal;
  }

  if (submitted === undefined || submitted === null || submitted === '') {
    throw new ApiInputError('Invoice total is required.');
  }
  const total = roundMoney(toAmount(submitted, 'Total'));
  if (total <= 0) throw new ApiInputError('Invoice total must be greater than zero.');
  return total;
}

/** Client linked to the project (single-client model), so invoices appear under the client. */
export async function linkedClientIdForProject(userId: string, projectId: string | null): Promise<string | null> {
  if (!projectId) return null;
  const row = await db.queryOne<{ client_id: string }>(
    `SELECT client_id FROM client_project_links WHERE project_id = $1 AND user_id = $2 ORDER BY created_at ASC LIMIT 1`,
    [projectId, userId]
  );
  return row?.client_id ?? null;
}
