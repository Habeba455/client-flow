import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export interface InvoicePdfLineItem {
  description: string;
  quantity: number;
  unitPrice: number;
  total: number;
}

export interface InvoicePdfInput {
  invoiceNumber: string;
  issueDate: string;
  dueDate: string;
  currency: string;
  total: number;
  senderName: string | null;
  senderEmail: string | null;
  senderWebsite: string | null;
  senderAddress: string | null;
  recipientName: string | null;
  company: string | null;
  recipientEmail: string | null;
  notes: string | null;
  paymentInstructions: string | null;
  items: InvoicePdfLineItem[];
}

function formatInvoiceMoney(amount: number, currency: string): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency || 'USD',
    maximumFractionDigits: 2,
  }).format(amount);
}

function wrapPdfText(text: string, maxChars = 88): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return [];
  }

  const words = normalized.split(' ');
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }

  if (current) {
    lines.push(current);
  }

  return lines;
}

function formatInvoiceDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(parsed);
}

function drawRule(page: PDFDocument['addPage'] extends (...args: any[]) => infer T ? T : never, y: number) {
  page.drawLine({
    start: { x: 56, y },
    end: { x: 556, y },
    thickness: 1,
    color: rgb(0.9, 0.92, 0.95),
  });
}

export async function buildInvoicePdfAttachment(params: InvoicePdfInput): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  let page = pdf.addPage([612, 792]);
  let y = 740;

  const ensureSpace = (required = 28) => {
    if (y >= required) {
      return;
    }
    page = pdf.addPage([612, 792]);
    y = 740;
  };

  const drawText = (text: string, options?: { x?: number; y?: number; size?: number; bold?: boolean; color?: [number, number, number] }) => {
    ensureSpace((options?.size || 11) + 18);
    page.drawText(text, {
      x: options?.x ?? 56,
      y: options?.y ?? y,
      size: options?.size || 11,
      font: options?.bold ? bold : font,
      color: options?.color ? rgb(options.color[0], options.color[1], options.color[2]) : rgb(0.1, 0.14, 0.23),
    });
    if (options?.y == null) {
      y -= (options?.size || 11) + 8;
    }
  };

  const drawWrapped = (text: string, label?: string) => {
    if (label) {
      drawText(label, { bold: true, size: 11 });
    }
    for (const line of wrapPdfText(text)) {
      drawText(line, { x: 68, size: 10 });
    }
  };

  page.drawRectangle({
    x: 0,
    y: 700,
    width: 612,
    height: 92,
    color: rgb(0.06, 0.14, 0.33),
  });

  drawText(params.senderName || 'Your Firm', { x: 56, y: 748, size: 24, bold: true, color: [1, 1, 1] });
  const senderMeta = [params.senderEmail, params.senderWebsite, params.senderAddress].filter(Boolean).join('  •  ');
  if (senderMeta) {
    drawText(senderMeta, { x: 56, y: 724, size: 10, color: [0.87, 0.91, 0.98] });
  }

  drawText('INVOICE', { x: 450, y: 748, size: 24, bold: true, color: [1, 1, 1] });
  drawText(`#${params.invoiceNumber}`, { x: 470, y: 722, size: 11, color: [0.87, 0.91, 0.98] });

  y = 660;

  page.drawRectangle({
    x: 56,
    y: 548,
    width: 220,
    height: 90,
    color: rgb(0.97, 0.98, 1),
    borderColor: rgb(0.86, 0.9, 0.96),
    borderWidth: 1,
  });
  page.drawRectangle({
    x: 336,
    y: 548,
    width: 220,
    height: 90,
    color: rgb(1, 0.99, 0.97),
    borderColor: rgb(0.94, 0.89, 0.83),
    borderWidth: 1,
  });

  drawText('Bill To', { x: 72, y: 618, size: 12, bold: true });
  drawText(params.recipientName || params.company || 'Client', { x: 72, y: 594, size: 12, bold: true });
  if (params.company && params.company !== params.recipientName) {
    drawText(params.company, { x: 72, y: 576, size: 10 });
  }
  if (params.recipientEmail) {
    drawText(params.recipientEmail, { x: 72, y: 558, size: 10, color: [0.36, 0.43, 0.56] });
  }

  drawText('Invoice Details', { x: 352, y: 618, size: 12, bold: true });
  drawText(`Issue Date: ${formatInvoiceDate(params.issueDate)}`, { x: 352, y: 594, size: 10 });
  drawText(`Due Date: ${formatInvoiceDate(params.dueDate)}`, { x: 352, y: 576, size: 10 });
  drawText(`Total Due: ${formatInvoiceMoney(params.total, params.currency)}`, {
    x: 352,
    y: 558,
    size: 12,
    bold: true,
    color: [0.08, 0.32, 0.68],
  });

  y = 516;
  drawText('Line Items', { size: 13, bold: true });

  page.drawRectangle({
    x: 56,
    y: y - 8,
    width: 500,
    height: 28,
    color: rgb(0.95, 0.97, 1),
  });
  page.drawText('Description', { x: 68, y: y, size: 10, font: bold, color: rgb(0.1, 0.14, 0.23) });
  page.drawText('Qty', { x: 360, y: y, size: 10, font: bold, color: rgb(0.1, 0.14, 0.23) });
  page.drawText('Unit', { x: 418, y: y, size: 10, font: bold, color: rgb(0.1, 0.14, 0.23) });
  page.drawText('Total', { x: 500, y: y, size: 10, font: bold, color: rgb(0.1, 0.14, 0.23) });
  y -= 26;

  for (const item of params.items) {
    ensureSpace(90);
    const descriptionLines = wrapPdfText(item.description, 48);
    const rowTop = y;
    const rowHeight = Math.max(34, descriptionLines.length * 14 + 10);
    page.drawRectangle({
      x: 56,
      y: rowTop - rowHeight + 8,
      width: 500,
      height: rowHeight,
      color: rgb(1, 1, 1),
      borderColor: rgb(0.92, 0.94, 0.97),
      borderWidth: 1,
    });

    descriptionLines.forEach((line, index) => {
      page.drawText(line, {
        x: 68,
        y: rowTop - index * 14,
        size: 10,
        font,
        color: rgb(0.1, 0.14, 0.23),
      });
    });
    page.drawText(String(item.quantity), {
      x: 360,
      y: rowTop,
      size: 10,
      font,
      color: rgb(0.1, 0.14, 0.23),
    });
    page.drawText(formatInvoiceMoney(item.unitPrice, params.currency), {
      x: 418,
      y: rowTop,
      size: 10,
      font,
      color: rgb(0.1, 0.14, 0.23),
    });
    page.drawText(formatInvoiceMoney(item.total, params.currency), {
      x: 500,
      y: rowTop,
      size: 10,
      font: bold,
      color: rgb(0.1, 0.14, 0.23),
    });
    y -= rowHeight + 8;
  }

  y -= 6;
  drawRule(page, y);
  y -= 24;

  ensureSpace(160);
  page.drawRectangle({
    x: 330,
    y: y - 84,
    width: 226,
    height: 84,
    color: rgb(0.97, 0.98, 1),
    borderColor: rgb(0.84, 0.88, 0.95),
    borderWidth: 1,
  });
  drawText('Invoice Summary', { x: 346, y: y - 18, size: 10, bold: true, color: [0.36, 0.43, 0.56] });
  drawText('Subtotal', { x: 346, y: y - 42, size: 10 });
  drawText(formatInvoiceMoney(params.total, params.currency), { x: 468, y: y - 42, size: 10, bold: true });
  drawText('Amount Due', { x: 346, y: y - 68, size: 11, bold: true, color: [0.08, 0.32, 0.68] });
  drawText(formatInvoiceMoney(params.total, params.currency), { x: 440, y: y - 72, size: 18, bold: true, color: [0.08, 0.32, 0.68] });
  y -= 108;

  if (params.notes) {
    drawRule(page, y);
    y -= 20;
    drawWrapped(params.notes, 'Notes');
  }

  if (params.paymentInstructions) {
    y -= 12;
    drawWrapped(params.paymentInstructions, 'Payment Instructions');
  }

  y -= 10;
  drawRule(page, y);
  y -= 18;
  drawText(
    `Thank you for your business.${params.senderName ? ` ${params.senderName}` : ''}${params.senderWebsite ? `  •  ${params.senderWebsite}` : ''}`,
    { x: 56, y, size: 9, color: [0.36, 0.43, 0.56] }
  );

  return Buffer.from(await pdf.save());
}
