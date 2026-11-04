import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/current-user';
import { db } from '@/lib/db';
import {
  errorResponse,
  readEnum,
  readId,
  readIsoDateTime,
  readJsonObject,
  readOptionalText,
  readRequiredText,
} from '@/lib/api-validation';
import { TASK_PRIORITIES, TASK_STATUSES } from '@/lib/tasks/constants';
import { assertProjectOwned } from '@/lib/workspace/project-links';

/** Manual task creation, optionally attached to one of the user's projects. */
export async function POST(request: NextRequest) {
  try {
    const current = await getCurrentUser();
    if (!current) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = readJsonObject(await request.json().catch(() => null));
    const title = readRequiredText(body.title, 'Title', 300);
    const description = readOptionalText(body.description, 'Description', 5000) ?? null;
    const status = readEnum(body.status, 'Status', TASK_STATUSES) ?? 'todo';
    const priority = readEnum(body.priority, 'Priority', TASK_PRIORITIES) ?? 'medium';
    const dueAt = readIsoDateTime(body.dueAt, 'Due date') ?? null;
    const projectId = readId(body.projectId, 'Project') ?? null;
    if (projectId) await assertProjectOwned(current.user.id, projectId);

    const todo = await db.queryOne(
      `INSERT INTO todo (id, user_id, title, description, status, priority, due_at, created_at, updated_at, project_id)
       VALUES ($1, $2, $3, $4, $5::todo_status, $6::todo_priority, $7::timestamptz, NOW(), NOW(), $8)
       RETURNING id, title, description, status::text AS status, priority::text AS priority, due_at, project_id`,
      [randomUUID(), current.user.id, title, description, status, priority, dueAt, projectId]
    );

    return NextResponse.json({ ok: true, todo }, { status: 201 });
  } catch (error) {
    return errorResponse(error, 'tasks.create');
  }
}
