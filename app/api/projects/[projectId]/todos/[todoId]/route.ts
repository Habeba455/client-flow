import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/current-user';

export async function PATCH(request: NextRequest, { params }: { params: { projectId: string; todoId: string } }) {
  const current = await getCurrentUser();
  if (!current) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = (await request.json()) as {
    status?: 'todo' | 'in_progress' | 'done' | 'archived';
    priority?: 'low' | 'medium' | 'high' | 'urgent';
  };

  const todo = await db.queryOne<{
    id: string;
    title: string;
    status: string;
    priority: string;
    due_at: string | null;
  }>(
    `UPDATE todo
     SET status = COALESCE($4::todo_status, status),
         priority = COALESCE($5::todo_priority, priority),
         completed_at = CASE WHEN $4::todo_status = 'done'::todo_status THEN NOW() ELSE completed_at END,
         updated_at = NOW()
     WHERE id = $1 AND user_id = $2 AND project_id = $3
     RETURNING id, title, status::text as status, priority::text as priority, due_at`,
    [params.todoId, current.user.id, params.projectId, body.status || null, body.priority || null]
  );

  if (!todo) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  return NextResponse.json({ todo });
}

export async function DELETE(_request: NextRequest, { params }: { params: { projectId: string; todoId: string } }) {
  const current = await getCurrentUser();
  if (!current) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const deleted = await db.queryOne<{ id: string }>(
    `DELETE FROM todo WHERE id = $1 AND user_id = $2 AND project_id = $3 RETURNING id`,
    [params.todoId, current.user.id, params.projectId]
  );

  if (!deleted) {
    return NextResponse.json({ error: 'Todo not found' }, { status: 404 });
  }

  return NextResponse.json({ ok: true, deletedId: deleted.id });
}
