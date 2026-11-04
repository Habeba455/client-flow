import { nylasGrantDownload, nylasGrantRequest } from '@/lib/nylas/client';

interface NylasAddress {
  name?: string | null;
  email?: string | null;
}

interface NylasAttachment {
  id?: string;
  filename?: string | null;
  content_type?: string | null;
  size?: number | null;
}

interface NylasMessageRecord {
  id: string;
  thread_id?: string | null;
  subject?: string | null;
  from?: NylasAddress[];
  to?: NylasAddress[];
  cc?: NylasAddress[];
  body?: string | null;
  snippet?: string | null;
  date?: number | string | null;
  attachments?: NylasAttachment[];
}

interface NylasThreadRecord {
  id: string;
  subject?: string | null;
  snippet?: string | null;
  message_ids?: string[];
  latest_draft_or_message?: NylasMessageRecord | null;
  unread?: boolean | null;
}

interface NylasListResponse<T> {
  data?: T[];
  next_cursor?: string | null;
}

interface NylasItemResponse<T> {
  data?: T;
}

export interface GmailAttachmentSummary {
  filename: string;
  mimeType: string;
  attachmentId: string | null;
  messageId: string;
  size: number | null;
  inlineData?: string | null;
}

export interface GmailThreadSummary {
  id: string;
  threadId: string;
  latestMessageId: string | null;
  subject: string;
  from: string;
  to: string;
  snippet: string;
  body: string;
  receivedAt: string | null;
  unread?: boolean;
  hasTodos?: boolean;
  meetingRequested?: boolean;
}

export interface GmailInboxPage {
  items: GmailThreadSummary[];
  nextCursor: string | null;
}

export interface GmailThreadMessage {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  to: string;
  cc: string;
  body: string;
  receivedAt: string | null;
  attachments: GmailAttachmentSummary[];
}

export interface GmailThreadDetail {
  id: string;
  subject: string;
  messages: GmailThreadMessage[];
  participants: string[];
  attachments: GmailAttachmentSummary[];
}

export interface GmailSendResult {
  id: string;
  threadId: string | null;
}

function stripHtml(value: string | null | undefined): string {
  if (!value) {
    return '';
  }
  const stripped = value
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .trim();

  return decodeHtmlEntities(stripped)
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[■-▿▀-▟█▉▊▋▌▍▎▏▓▒░]+/g, ' ')
    .replace(/[│┆┇┊┋╎╏]+/g, ' ')
    .replace(/\s*([:/|])\s*/g, '$1 ')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeHtmlEntities(value: string): string {
  const named = value
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&zwnj;|&#8204;/gi, '')
    .replace(/&zwj;|&#8205;/gi, '')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");

  return named.replace(/&#(\d+);/g, (_, code) => {
    const numeric = Number(code);
    if (!Number.isFinite(numeric)) {
      return '';
    }
    return String.fromCodePoint(numeric);
  });
}

function formatAddress(address: NylasAddress | null | undefined): string {
  if (!address) return '';
  const email = typeof address.email === 'string' ? address.email.trim() : '';
  const name = typeof address.name === 'string' ? address.name.trim() : '';
  if (name && email) return `${name} <${email}>`;
  return email || name;
}

function formatAddressList(addresses: NylasAddress[] | null | undefined): string {
  return (addresses || []).map(formatAddress).filter(Boolean).join(', ');
}

function toIso(value: number | string | null | undefined): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value > 9_999_999_999 ? value : value * 1000).toISOString();
  }
  if (typeof value === 'string' && value.trim()) {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber) && value.trim().length <= 13) {
      return new Date(asNumber > 9_999_999_999 ? asNumber : asNumber * 1000).toISOString();
    }
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}

function normalizeAttachments(message: NylasMessageRecord): GmailAttachmentSummary[] {
  return (message.attachments || [])
    .filter((attachment) => attachment.id || attachment.filename)
    .map((attachment) => ({
      filename: attachment.filename?.trim() || 'attachment',
      mimeType: attachment.content_type?.trim() || 'application/octet-stream',
      attachmentId: attachment.id || null,
      messageId: message.id,
      size: typeof attachment.size === 'number' ? attachment.size : null,
      inlineData: null,
    }));
}

function normalizeMessage(message: NylasMessageRecord): GmailThreadMessage {
  return {
    id: message.id,
    threadId: message.thread_id?.trim() || '',
    subject: message.subject?.trim() || 'Untitled email',
    from: formatAddressList(message.from) || 'Unknown sender',
    to: formatAddressList(message.to),
    cc: formatAddressList(message.cc),
    body: stripHtml(message.body) || message.snippet?.trim() || '',
    receivedAt: toIso(message.date),
    attachments: normalizeAttachments(message),
  };
}

function normalizeParticipants(messages: GmailThreadMessage[]): string[] {
  const participants = new Set<string>();
  for (const message of messages) {
    [message.from, message.to, message.cc]
      .join(', ')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .forEach((entry) => participants.add(entry));
  }
  return [...participants];
}

function normalizeThreadSummary(thread: NylasThreadRecord): GmailThreadSummary {
  const latest = thread.latest_draft_or_message;
  const from = latest?.from?.[0];
  const to = latest?.to?.[0];

  return {
    id: latest?.id || thread.id,
    threadId: thread.id,
    latestMessageId: latest?.id || null,
    subject: thread.subject?.trim() || latest?.subject?.trim() || 'Email thread',
    from: formatAddress(from) || 'Unknown sender',
    to: formatAddress(to),
    snippet: thread.snippet?.trim() || latest?.snippet?.trim() || '',
    body: stripHtml(latest?.body) || latest?.snippet?.trim() || '',
    receivedAt: toIso(latest?.date),
    unread: thread.unread === true,
  };
}

export async function fetchGmailInboxPage(
  userId: string,
  options: { limit?: number; cursor?: string | null } = {}
): Promise<GmailInboxPage> {
  const search = new URLSearchParams({
    limit: String(options.limit ?? 12),
  });
  if (options.cursor?.trim()) {
    search.set('page_token', options.cursor.trim());
  }

  const response = await nylasGrantRequest<NylasListResponse<NylasThreadRecord>>(userId, `/threads?${search.toString()}`);
  const threads = response?.data || [];

  return {
    items: threads.map(normalizeThreadSummary),
    nextCursor: response?.next_cursor?.trim() || null,
  };
}

export async function fetchGmailInbox(userId: string, maxResults = 12): Promise<GmailThreadSummary[]> {
  const page = await fetchGmailInboxPage(userId, { limit: maxResults });
  return page.items;
}

export async function fetchGmailThreadSummaryById(userId: string, threadId: string): Promise<GmailThreadSummary | null> {
  const response = await nylasGrantRequest<NylasItemResponse<NylasThreadRecord>>(userId, `/threads/${threadId}`);
  const thread = response?.data;
  return thread ? normalizeThreadSummary(thread) : null;
}

export async function fetchGmailThread(userId: string, threadId: string): Promise<GmailThreadDetail | null> {
  const threadResponse = await nylasGrantRequest<NylasItemResponse<NylasThreadRecord>>(userId, `/threads/${threadId}`);
  const thread = threadResponse?.data;
  if (!thread) {
    return null;
  }

  const messageIds = thread.message_ids || [];
  const messages = (
    await Promise.all(
      messageIds.map(async (messageId) => {
        const response = await nylasGrantRequest<NylasItemResponse<NylasMessageRecord>>(userId, `/messages/${messageId}`);
        return response?.data ? normalizeMessage(response.data) : null;
      })
    )
  )
    .filter((message): message is GmailThreadMessage => Boolean(message))
    .sort((left, right) => {
      const leftTime = left.receivedAt ? new Date(left.receivedAt).getTime() : 0;
      const rightTime = right.receivedAt ? new Date(right.receivedAt).getTime() : 0;
      return leftTime - rightTime;
    });

  if (messages.length === 0 && thread.latest_draft_or_message) {
    messages.push(normalizeMessage(thread.latest_draft_or_message));
  }

  return {
    id: thread.id,
    subject: thread.subject?.trim() || messages[messages.length - 1]?.subject || 'Email thread',
    messages,
    participants: normalizeParticipants(messages),
    attachments: messages.flatMap((message) => message.attachments),
  };
}

export async function updateGmailThreadUnreadStatus(params: {
  userId: string;
  threadId: string;
  unread: boolean;
}): Promise<GmailThreadDetail | null> {
  const thread = await fetchGmailThread(params.userId, params.threadId);
  if (!thread) {
    return null;
  }

  await Promise.all(
    thread.messages.map((message) =>
      nylasGrantRequest(params.userId, `/messages/${message.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          unread: params.unread,
        }),
      })
    )
  );

  return fetchGmailThread(params.userId, params.threadId);
}

export async function downloadGmailAttachment(params: {
  userId: string;
  messageId: string;
  attachmentId: string | null;
  inlineData?: string | null;
}): Promise<Buffer | null> {
  if (!params.attachmentId) {
    return null;
  }

  return nylasGrantDownload(params.userId, `/attachments/${params.attachmentId}/download`);
}

export async function sendGmailMessage(params: {
  userId: string;
  to: string;
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  attachments?: Array<{ filename: string; mimeType: string; content: Buffer }>;
  replyToMessageId?: string | null;
}): Promise<GmailSendResult | null> {
  const response = await nylasGrantRequest<NylasItemResponse<{ id?: string; thread_id?: string | null }>>(params.userId, '/messages/send', {
    method: 'POST',
    body: JSON.stringify({
      subject: params.subject,
      body: params.body,
      to: [{ email: params.to }],
      cc: (params.cc || []).map((email) => ({ email })),
      bcc: (params.bcc || []).map((email) => ({ email })),
      reply_to_message_id: params.replyToMessageId || undefined,
      attachments: (params.attachments || []).map((attachment) => ({
        filename: attachment.filename,
        content_type: attachment.mimeType,
        content: attachment.content.toString('base64'),
      })),
    }),
  });

  if (!response?.data?.id) {
    return null;
  }

  return {
    id: response.data.id,
    threadId: response.data.thread_id || null,
  };
}
