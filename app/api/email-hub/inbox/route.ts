import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/current-user';
import { db } from '@/lib/db';
import { fetchGmailInboxPage, type GmailThreadSummary } from '@/lib/google/gmail';
import { enrichInboxThreadsWithAssistantState } from '@/lib/product-data';

interface CachedThreadPayloadMessage {
  id?: string;
  from?: string;
  to?: string;
  body?: string;
  receivedAt?: string | null;
}

interface CachedThreadPayload {
  id?: string;
  subject?: string;
  messages?: CachedThreadPayloadMessage[];
}

function toCachedInboxSummary(row: {
  thread_id: string;
  thread_subject: string | null;
  thread_payload: CachedThreadPayload | null;
}): GmailThreadSummary {
  const messages = Array.isArray(row.thread_payload?.messages) ? row.thread_payload?.messages || [] : [];
  const latest = messages[messages.length - 1] || null;
  const snippetSource = typeof latest?.body === 'string' ? latest.body.trim() : '';
  const snippet = snippetSource.replace(/\s+/g, ' ').trim().slice(0, 220);

  return {
    id: typeof latest?.id === 'string' && latest.id.trim() ? latest.id : row.thread_id,
    threadId: row.thread_id,
    latestMessageId: typeof latest?.id === 'string' && latest.id.trim() ? latest.id : null,
    subject: row.thread_subject?.trim() || row.thread_payload?.subject?.trim() || 'Email thread',
    from: typeof latest?.from === 'string' && latest.from.trim() ? latest.from : 'Unknown sender',
    to: typeof latest?.to === 'string' ? latest.to : '',
    snippet,
    body: snippetSource,
    receivedAt: typeof latest?.receivedAt === 'string' ? latest.receivedAt : null,
    unread: false,
  };
}

export async function GET(request: Request) {
  const current = await getCurrentUser();
  if (!current) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const cursor = searchParams.get('cursor');
  const filter = searchParams.get('filter');
  const query = searchParams.get('q')?.trim() || '';
  const limitParam = Number(searchParams.get('limit') || '20');
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 50) : 20;
  const offsetParam = Number(searchParams.get('offset') || '0');
  const offset = Number.isFinite(offsetParam) ? Math.max(offsetParam, 0) : 0;

  try {
    if (query) {
      const pattern = `%${query.replace(/\s+/g, '%')}%`;
      const rows = await db.query<{ thread_id: string; thread_subject: string | null; thread_payload: CachedThreadPayload | null }>(
        `SELECT thread_id, thread_subject, thread_payload
         FROM email_thread_analysis_cache
         WHERE user_id = $1
           AND (
             thread_subject ILIKE $2
             OR thread_payload::text ILIKE $2
           )
         ORDER BY updated_at DESC
         LIMIT $3 OFFSET $4`,
        [current.user.id, pattern, limit + 1, offset]
      );

      const items = rows.slice(0, limit).map(toCachedInboxSummary);
      const enrichedItems = await enrichInboxThreadsWithAssistantState(current.user.id, items);
      const nextOffset = rows.length > limit ? String(offset + limit) : null;
      return NextResponse.json({ items: enrichedItems, nextCursor: nextOffset });
    }

    if (filter === 'meeting_requests' || filter === 'with_todos') {
      const rows =
        filter === 'meeting_requests'
          ? await db.query<{ thread_id: string; thread_subject: string | null; thread_payload: CachedThreadPayload | null }>(
              `SELECT thread_id, thread_subject, thread_payload
               FROM email_thread_analysis_cache
               WHERE user_id = $1
                 AND COALESCE((analysis->>'meeting_requested')::boolean, FALSE) = TRUE
               ORDER BY updated_at DESC`,
              [current.user.id]
            )
          : await db.query<{ thread_id: string; thread_subject: string | null; thread_payload: CachedThreadPayload | null }>(
              `SELECT cache.thread_id, cache.thread_subject, cache.thread_payload
               FROM todo
               INNER JOIN email_thread_analysis_cache cache
                 ON cache.user_id = todo.user_id
                AND cache.thread_id = todo.related_email_id
               WHERE todo.user_id = $1
                 AND todo.related_email_id IS NOT NULL
               GROUP BY cache.thread_id, cache.thread_subject, cache.thread_payload
               ORDER BY MAX(todo.updated_at) DESC`,
              [current.user.id]
            );

      const pageRows = rows.slice(offset, offset + limit);
      const items = pageRows.map(toCachedInboxSummary);
      const enrichedItems = await enrichInboxThreadsWithAssistantState(current.user.id, items);
      const nextOffset = offset + limit < rows.length ? String(offset + limit) : null;

      return NextResponse.json({ items: enrichedItems, nextCursor: nextOffset });
    }

    const page = await fetchGmailInboxPage(current.user.id, { cursor, limit });
    const enrichedItems = await enrichInboxThreadsWithAssistantState(current.user.id, page.items);
    return NextResponse.json({ ...page, items: enrichedItems });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load inbox';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
