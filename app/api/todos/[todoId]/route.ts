import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/current-user';
import { db } from '@/lib/db';
import {
  ApiInputError,
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

const RETURNING = `RETURNING id, title, description, status::text AS status, priority::text AS priority, due_at, project_id`;

/** Edit any field of a task the user owns. Used by the Tasks page. */
export async function PATCH(request: NextRequest, { params }: { params: { todoId: string } }) {
  try {
    const current = await getCurrentUser();
    if (!current) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = readJsonObject(await request.json().catch(() => null));
    const title = body.title !== undefined ? readRequiredText(body.title, 'Title', 300) : undefined;
    const description = readOptionalText(body.description, 'Description', 5000);
    const status = readEnum(body.status, 'Status', TASK_STATUSES);
    const priority = readEnum(body.priority, 'Priority', TASK_PRIORITIES);
    const dueAt = readIsoDateTime(body.dueAt, 'Due date');
    const projectId = readId(body.projectId, 'Project');
    if (projectId) await assertProjectOwned(current.user.id, projectId);

    const values: unknown[] = [params.todoId, current.user.id];
    const sets: string[] = [];
    const add = (fragment: string, value: unknown) => {
      values.push(value);
      sets.push(fragment.split('?').join(`$${values.length}`));
    };

    if (title !== undefined) add('title = ?', title);
    if (description !== undefined) add('description = ?', description);
    if (status !== undefined) {
      add('status = ?::todo_status', status);
      add("completed_at = CASE WHEN ?::todo_status = 'done'::todo_status THEN COALESCE(completed_at, NOW()) ELSE NULL END", status);
    }
    if (priority !== undefined) add('priority = ?::todo_priority', priority);
    if (dueAt !== undefined) add('due_at = ?::timestamptz', dueAt);
    if (projectId !== undefined) add('project_id = ?', projectId);

    if (sets.length === 0) throw new ApiInputError('No editable fields were provided.');
    sets.push('updated_at = NOW()');

    const todo = await db.queryOne(
      `UPDATE todo SET ${sets.join(', ')} WHERE id = $1 AND user_id = $2 ${RETURNING}`,
      values
    );
    if (!todo) throw new ApiInputError('Task not found', 404);

    return NextResponse.json({ ok: true, todo });
  } catch (error) {
    return errorResponse(error, 'todos.update');
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: { todoId: string } }) {
  try {
    const current = await getCurrentUser();
    if (!current) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const deleted = await db.queryOne<{ id: string }>(
      `DELETE FROM todo WHERE id = $1 AND user_id = $2 RETURNING id`,
      [params.todoId, current.user.id]
    );
    if (!deleted) throw new ApiInputError('Task not found', 404);

    return NextResponse.json({ ok: true, deletedId: deleted.id });
  } catch (error) {
    return errorResponse(error, 'todos.delete');
  }
}
