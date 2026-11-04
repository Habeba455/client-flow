import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/current-user';

export async function POST(request: NextRequest, { params }: { params: { projectId: string } }) {
  const current = await getCurrentUser();
  if (!current) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const project = await db.queryOne<{ id: string }>(
    `SELECT id FROM projects WHERE id = $1 AND user_id = $2`,
    [params.projectId, current.user.id]
  );
  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  const body = (await request.json()) as {
    title?: string;
    priority?: 'low' | 'medium' | 'high' | 'urgent';
    dueAt?: string | null;
  };

  if (!body.title?.trim()) {
    return NextResponse.json({ error: 'Task title is required' }, { status: 400 });
  }

  const todo = await db.queryOne<{
    id: string;
    title: string;
    status: string;
    priority: string;
    due_at: string | null;
  }>(
    `INSERT INTO todo (id, user_id, title, description, status, priority, due_at, created_at, updated_at, project_id)
     VALUES ($1, $2, $3, NULL, 'todo'::todo_status, $4::todo_priority, $5::timestamptz, NOW(), NOW(), $6)
     RETURNING id, title, status::text as status, priority::text as priority, due_at`,
    [randomUUID(), current.user.id, body.title.trim(), body.priority || 'medium', body.dueAt || null, params.projectId]
  );

  return NextResponse.json({ todo });
}
