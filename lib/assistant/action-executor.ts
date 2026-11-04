import { randomUUID } from 'node:crypto';
import { linkedClientIdForProject } from '@/lib/invoices/rules';
import type { ApprovalAction } from '@/lib/ai/types';
import { getAssistantProfile } from '@/lib/assistant-profile';
import { normalizeProjectDocumentStorageProvider } from '@/lib/assistant/document-ingestion';
import { summarizeMeeting, upsertProjectMeetingNote } from '@/lib/assistant/meeting-notes';
import { executeResearchRetrievalPlan, isResearchPlanApprovalPayload } from '@/lib/assistant/research-flow';
import { db } from '@/lib/db';
import { createGoogleCalendarEvent } from '@/lib/google/calendar';
import { sendGmailMessage } from '@/lib/google/gmail';
import { buildInvoicePdfAttachment } from '@/lib/invoices/pdf';
import { ensureProjectScopedFinanceColumns } from '@/lib/workspace/schema';

export interface StoredApprovalAction extends ApprovalAction {
  userId: string;
  outputContent: string | null;
  agentName: string | null;
}

export interface ApprovalExecutionResult {
  message: string;
  payloadPatch?: Record<string, unknown>;
}

interface InvoiceLineItem {
  description: string;
  quantity: number;
  unitPrice: number;
  total: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function getNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const normalized = Number(value.replace(/,/g, ''));
    return Number.isFinite(normalized) ? normalized : null;
  }
  return null;
}

function getStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => getString(item)).filter((item): item is string => Boolean(item));
  }
  const direct = getString(value);
  return direct ? [direct] : [];
}

function truncate(value: string, limit = 480): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64) || 'document';
}

function stripCodeFence(value: string): string {
  return value.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
}

function extractJsonObject(value: string | null | undefined): Record<string, unknown> | null {
  if (!value) {
    return null;
  }

  const cleaned = stripCodeFence(value);
  try {
    const parsed = JSON.parse(cleaned);
    return isRecord(parsed) ? parsed : null;
  } catch {
    // Fall through to brace extraction.
  }

  const start = cleaned.indexOf('{');
  if (start < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < cleaned.length; index += 1) {
    const char = cleaned[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        const candidate = cleaned.slice(start, index + 1);
        try {
          const parsed = JSON.parse(candidate);
          return isRecord(parsed) ? parsed : null;
        } catch {
          return null;
        }
      }
    }
  }

  return null;
}

function combineStructuredPayload(action: StoredApprovalAction): Record<string, unknown> {
  const parsed = extractJsonObject(action.outputContent);
  return {
    ...(parsed || {}),
    ...(action.payload || {}),
  };
}

function normalizeFileContent(value: unknown, fallback: string | null): { mimeType: string; text: string; fileNameSuffix: string } {
  if (typeof value === 'string' && value.trim()) {
    return { mimeType: 'text/markdown', text: value, fileNameSuffix: '.md' };
  }
  if (isRecord(value) || Array.isArray(value)) {
    return { mimeType: 'application/json', text: JSON.stringify(value, null, 2), fileNameSuffix: '.json' };
  }
  return {
    mimeType: 'text/markdown',
    text: fallback?.trim() || 'No content supplied.',
    fileNameSuffix: '.md',
  };
}

async function insertProjectDocument(params: {
  userId: string;
  projectId: string;
  fileName: string;
  mimeType: string;
  text: string;
  summary?: string | null;
  storageProvider?: string | null;
  driveFileId?: string | null;
  driveUrl?: string | null;
  documentType?: string | null;
  tags?: string[];
}) {
  const id = randomUUID();
  const storageProvider = normalizeProjectDocumentStorageProvider(params.storageProvider);
  await db.query(
    `INSERT INTO project_documents (
       id, project_id, user_id, file_name, file_type, file_size, drive_file_id, drive_url, storage_provider,
       summary, key_points, extracted_data, document_type, full_text, tags, analyzed_at, created_at, updated_at
     )
     VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9,
       $10, '[]'::jsonb, '{}'::jsonb, $11, $12, $13::text[], NOW(), NOW(), NOW()
     )`,
    [
      id,
      params.projectId,
      params.userId,
      params.fileName,
      params.mimeType,
      Buffer.byteLength(params.text, 'utf8'),
      params.driveFileId || null,
      params.driveUrl || null,
      storageProvider,
      params.summary || truncate(params.text),
      params.documentType || null,
      params.text,
      params.tags || [],
    ]
  );

  return id;
}

function resolveEmailDraft(action: StoredApprovalAction) {
  const merged = combineStructuredPayload(action);
  const to = getString(merged.to) || getString(merged.recipient_email) || getString(merged.email_recipient);
  const cc = getStringArray(merged.cc);
  const bcc = getStringArray(merged.bcc);
  const subject = getString(merged.subject) || action.title;
  const body =
    getString(merged.body) ||
    getString(merged.output) ||
    action.outputContent ||
    'This message was generated by the workspace assistant.';
  const replyToMessageId = getString(merged.reply_to_message_id);

  return { to, cc, bcc, subject, body, replyToMessageId };
}

function resolveCalendarSpec(action: StoredApprovalAction) {
  const merged = combineStructuredPayload(action);
  const start = getString(merged.start_datetime_utc) || getString(merged.start) || getString(merged.start_datetime);
  const end = getString(merged.end_datetime_utc) || getString(merged.end) || getString(merged.end_datetime);
  const attendees = getStringArray(merged.attendees);

  return {
    title: getString(merged.title) || action.title,
    description: getString(merged.description) || action.outputContent || action.title,
    start,
    end,
    attendees,
    location: getString(merged.location),
    videoLink: getString(merged.video_link) as 'google_meet' | 'teams' | 'zoom' | null,
    userDisplayTime: getString(merged.user_display_time),
    clientDisplayTime: getString(merged.client_display_time),
  };
}

interface ValidApprovalSlot {
  start: string;
  end: string;
  userDisplayTime: string | null;
  clientDisplayTime: string | null;
}

function readValidApprovalSlots(action: StoredApprovalAction): { slots: ValidApprovalSlot[]; noOverlap: boolean; message: string | null } {
  const merged = combineStructuredPayload(action);
  const context =
    merged.context && isRecord(merged.context)
      ? (merged.context as Record<string, unknown>)
      : {};
  const rawSlots = Array.isArray(merged.valid_meeting_slots)
    ? merged.valid_meeting_slots
    : Array.isArray(context.valid_meeting_slots)
      ? context.valid_meeting_slots
      : [];
  const slotConstraints =
    context.slot_constraints && isRecord(context.slot_constraints)
      ? (context.slot_constraints as Record<string, unknown>)
      : {};

  return {
    slots: rawSlots
      .filter((slot): slot is Record<string, unknown> => isRecord(slot))
      .map((slot) => ({
        start: getString(slot.start) || '',
        end: getString(slot.end) || '',
        userDisplayTime: getString(slot.userDisplayTime),
        clientDisplayTime: getString(slot.clientDisplayTime),
      }))
      .filter((slot) => slot.start && slot.end),
    noOverlap: slotConstraints.noOverlap === true,
    message: getString(slotConstraints.message),
  };
}

function resolveInvoiceSpec(action: StoredApprovalAction) {
  const merged = combineStructuredPayload(action);
  const lineItems = Array.isArray(merged.line_items)
    ? merged.line_items
        .map((item) => {
          if (!isRecord(item)) return null;
          const description = getString(item.description);
          const quantity = getNumber(item.quantity);
          const unitPrice = getNumber(item.unit_price);
          const total = getNumber(item.total);
          if (!description || quantity == null || unitPrice == null || total == null) {
            return null;
          }
          return { description, quantity, unitPrice, total } satisfies InvoiceLineItem;
        })
        .filter((item): item is InvoiceLineItem => Boolean(item))
    : [];

  return {
    invoiceNumber: getString(merged.invoice_number),
    issueDate: getString(merged.issue_date),
    dueDate: getString(merged.due_date),
    currency: getString(merged.currency) || 'USD',
    subtotal: getNumber(merged.subtotal),
    total: getNumber(merged.total),
    notes: getString(merged.notes),
    paymentInstructions: getString(merged.payment_instructions),
    recipientEmail: getString(merged.email_recipient) || getString(merged.recipient_email),
    recipientName: isRecord(merged.to) ? getString(merged.to.name) : null,
    company: isRecord(merged.to) ? getString(merged.to.company) : null,
    lineItems,
  };
}


function normalizeDriveFolderId(value: unknown): string | null {
  const folder = getString(value);
  if (!folder) {
    return null;
  }
  if (folder.includes('/')) {
    return null;
  }
  return folder;
}

async function executeEmailAction(action: StoredApprovalAction): Promise<ApprovalExecutionResult> {
  const draft = resolveEmailDraft(action);
  if (!draft.to) {
    throw new Error('This email approval does not have a recipient address.');
  }

  const sent = await sendGmailMessage({
    userId: action.userId,
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    subject: draft.subject,
    body: draft.body,
    replyToMessageId: draft.replyToMessageId,
  });

  if (!sent) {
    throw new Error('Email send failed. Confirm a Nylas-connected mailbox is available.');
  }

  return {
    message: `Email sent to ${draft.to}.`,
    payloadPatch: { gmail_message_id: sent.id, gmail_thread_id: sent.threadId, sent_to: draft.to },
  };
}

async function executeCalendarAction(action: StoredApprovalAction): Promise<ApprovalExecutionResult> {
  const spec = resolveCalendarSpec(action);
  if (!spec.start || !spec.end) {
    throw new Error('This calendar approval is missing a valid start or end time.');
  }

  const availability = readValidApprovalSlots(action);
  if (availability.noOverlap && availability.slots.length === 0) {
    throw new Error(availability.message || 'No mutual availability exists within the configured working-hour overlap.');
  }

  if (availability.slots.length > 0) {
    const matchedSlot = availability.slots.find((slot) => slot.start === spec.start && slot.end === spec.end);
    if (!matchedSlot) {
      throw new Error(
        `This calendar approval proposed a time outside the valid overlap windows. Valid slots: ${availability.slots
          .map((slot) => slot.userDisplayTime || slot.start)
          .join('; ')}.`
      );
    }
  }

  const created = await createGoogleCalendarEvent(action.userId, {
    title: spec.title,
    description: spec.description,
    start: spec.start,
    end: spec.end,
    attendees: spec.attendees,
    location: spec.location,
    videoLink: spec.videoLink,
  });

  if (!created) {
    throw new Error('Calendar event creation failed. Confirm a Nylas-connected calendar is available.');
  }

  if (action.projectId) {
    const meetingSummary = await summarizeMeeting({
      title: spec.title,
      description: spec.description,
      attendees: spec.attendees,
    });

    await upsertProjectMeetingNote({
      userId: action.userId,
      projectId: action.projectId,
      calendarEventId: created.id,
      title: spec.title,
      meetingDate: spec.start,
      attendees: spec.attendees,
      summary: meetingSummary.summary,
      decisions: meetingSummary.decisions,
      actionItems: meetingSummary.action_items,
      rawNotes: spec.description,
      source: 'calendar_agent',
    });

    await db.query(
      `INSERT INTO client_meeting_notes (id, client_id, user_id, title, content, meeting_date, source, external_id, project_id, created_at, updated_at)
       VALUES ($1, NULL, $2, $3, $4, $5::date, 'calendar_agent', $6, $7, NOW(), NOW())
       ON CONFLICT DO NOTHING`,
      [randomUUID(), action.userId, spec.title, spec.description, spec.start, created.id, action.projectId]
    );
  }

  return {
    message: `Calendar event created for ${spec.userDisplayTime || spec.start}.`,
    payloadPatch: { calendar_event_id: created.id, calendar_event_url: created.htmlLink || null, calendar_event_attendees: spec.attendees },
  };
}

async function executeDriveSaveAction(action: StoredApprovalAction): Promise<ApprovalExecutionResult> {
  const saved = await executeProjectDocumentSave(action);
  return {
    message: saved.message.replace('project documents', 'workspace documents'),
    payloadPatch: {
      ...(saved.payloadPatch || {}),
      storage_mode: 'workspace',
    },
  };
}

async function executeProjectDocumentSave(action: StoredApprovalAction): Promise<ApprovalExecutionResult> {
  if (!action.projectId) {
    throw new Error('This approval is not linked to a project, so it cannot be saved into project documents.');
  }

  const merged = combineStructuredPayload(action);
  const content = normalizeFileContent(merged.output ?? merged.document ?? merged.spec ?? action.outputContent, action.outputContent);
  const fileName = getString(merged.filename) || `${slugify(action.title)}${content.fileNameSuffix}`;

  const documentId = await insertProjectDocument({
    userId: action.userId,
    projectId: action.projectId,
    fileName,
    mimeType: content.mimeType,
    text: content.text,
    summary: truncate(content.text),
    storageProvider: 'local',
    documentType: getString(merged.document_type),
    tags: ['generated'],
  });

  return {
    message: `Saved to project documents as ${fileName}.`,
    payloadPatch: { project_document_id: documentId, saved_filename: fileName },
  };
}

async function executeInvoiceSendAction(action: StoredApprovalAction): Promise<ApprovalExecutionResult> {
  await ensureProjectScopedFinanceColumns();

  const spec = resolveInvoiceSpec(action);
  if (!spec.invoiceNumber || !spec.issueDate || !spec.dueDate || spec.total == null) {
    throw new Error('This invoice approval is missing required invoice fields.');
  }

  const itemsTotal = Math.round(spec.lineItems.reduce((sum, item) => sum + item.total, 0) * 100) / 100;
  if (spec.lineItems.length > 0 && Math.abs(spec.total - itemsTotal) > 0.005) {
    throw new Error(`Invoice total ${spec.total.toFixed(2)} does not match its line items (${itemsTotal.toFixed(2)}).`);
  }
  const subtotal = spec.subtotal ?? itemsTotal ?? spec.total;

  // Saved as draft first; marked sent only after the email succeeds, so a failed send never leaves a 'sent' invoice.
  const status = 'draft';
  const clientId = await linkedClientIdForProject(action.userId, action.projectId);
  const invoiceId = randomUUID();
  const shareToken = randomUUID();

  await db.query(
    `INSERT INTO invoices (
       id, user_id, client_id, invoice_number, share_token, status, currency,
       issue_date, due_date, subtotal, tax_rate, tax_amount, total, notes,
       document_url, created_at, updated_at, paid_at, project_id
     )
     VALUES (
       $1, $2, $13, $3, $4, $5, $6,
       $7::timestamptz, $8::timestamptz, $9, NULL, NULL, $10, $11,
       NULL, NOW(), NOW(), NULL, $12
     )`,
    [
      invoiceId,
      action.userId,
      spec.invoiceNumber,
      shareToken,
      status,
      spec.currency,
      spec.issueDate,
      spec.dueDate,
      subtotal,
      spec.total,
      spec.notes || null,
      action.projectId,
      clientId,
    ]
  );

  for (let index = 0; index < spec.lineItems.length; index += 1) {
    const item = spec.lineItems[index];
    await db.query(
      `INSERT INTO invoice_items (id, invoice_id, description, quantity, unit_amount, line_total, sort_order, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [randomUUID(), invoiceId, item.description, item.quantity, item.unitPrice, item.total, index + 1]
    );
  }

  let gmailMessageId: string | null = null;
  if (spec.recipientEmail) {
    const firmProfile = await getAssistantProfile(action.userId);
    const body =
      action.outputContent && !extractJsonObject(action.outputContent)
        ? action.outputContent
        : `${spec.recipientName || spec.company || 'Client'}, attached is Invoice ${spec.invoiceNumber} for ${spec.total.toFixed(2)} ${spec.currency}, due ${spec.dueDate}.`;
    const invoicePdf = await buildInvoicePdfAttachment({
      invoiceNumber: spec.invoiceNumber,
      issueDate: spec.issueDate,
      dueDate: spec.dueDate,
      currency: spec.currency,
      total: spec.total,
      senderName: firmProfile?.profile.firm_name || null,
      senderEmail: firmProfile?.profile.contact_email || null,
      senderWebsite: firmProfile?.profile.contact_website || null,
      senderAddress: firmProfile?.profile.address || null,
      recipientName: spec.recipientName,
      company: spec.company,
      recipientEmail: spec.recipientEmail,
      notes: spec.notes,
      paymentInstructions: spec.paymentInstructions,
      items: spec.lineItems,
    });

    const sent = await sendGmailMessage({
      userId: action.userId,
      to: spec.recipientEmail,
      subject: `Invoice ${spec.invoiceNumber}`,
      body,
      attachments: [
        {
          filename: `${spec.invoiceNumber}.pdf`,
          mimeType: 'application/pdf',
          content: invoicePdf,
        },
      ],
    });

    if (!sent) {
      throw new Error('Invoice was saved, but the follow-up email failed to send.');
    }
    gmailMessageId = sent.id;
    await db.query(`UPDATE invoices SET status = 'sent', updated_at = NOW() WHERE id = $1`, [invoiceId]);
  }

  return {
    message: spec.recipientEmail ? `Invoice ${spec.invoiceNumber} saved and emailed.` : `Invoice ${spec.invoiceNumber} saved as draft.`,
    payloadPatch: { invoice_id: invoiceId, invoice_number: spec.invoiceNumber, gmail_message_id: gmailMessageId, invoice_total: spec.total },
  };
}

export async function executeApprovalAction(action: StoredApprovalAction): Promise<ApprovalExecutionResult> {
  const payload = action.payload;
  if (action.actionType === 'other' && isResearchPlanApprovalPayload(payload)) {
    return executeResearchRetrievalPlan({
      userId: action.userId,
      projectId: action.projectId,
      plan: payload.research_plan,
    });
  }

  switch (action.actionType) {
    case 'email':
      return executeEmailAction(action);
    case 'calendar_event':
      return executeCalendarAction(action);
    case 'save_to_drive':
      return executeDriveSaveAction(action);
    case 'save_to_project_documents':
      return executeProjectDocumentSave(action);
    case 'invoice_send':
      return executeInvoiceSendAction(action);
    default:
      return {
        message: 'Approval completed. No external action was required.',
        payloadPatch: { approved_at: new Date().toISOString() },
      };
  }
}
