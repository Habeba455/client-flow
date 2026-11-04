import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/current-user';
import { db } from '@/lib/db';
import {
  ApiInputError,
  errorResponse,
  readDateOnly,
  readEnum,
  readId,
  readJsonObject,
  readOptionalText,
  readRequiredText,
} from '@/lib/api-validation';
import { PROJECT_STATUSES } from '@/lib/tasks/constants';
import { setProjectClient } from '@/lib/workspace/project-links';

function isValidTimezone(value: string): boolean {
  return /^[A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?$/.test(value.trim());
}

export async function PATCH(request: NextRequest, { params }: { params: { projectId: string } }) {
  try {
    const current = await getCurrentUser();
    if (!current) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = readJsonObject(await request.json().catch(() => null));

    const project = await db.queryOne<{ metadata: Record<string, unknown> | null }>(
      `SELECT metadata FROM projects WHERE id = $1 AND user_id = $2`,
      [params.projectId, current.user.id]
    );
    if (!project) throw new ApiInputError('Project not found', 404);

    const name = body.name !== undefined ? readRequiredText(body.name, 'Project name', 200) : undefined;
    const description = readOptionalText(body.description, 'Description', 2000);
    const status = readEnum(body.status, 'Status', PROJECT_STATUSES);
    const projectType = readOptionalText(body.projectType, 'Project type', 100);
    const targetCompletion = readDateOnly(body.targetCompletion, 'Target date');
    const clientId = readId(body.clientId, 'Client');

    const rawTimezone = typeof body.clientTimezone === 'string' ? body.clientTimezone.trim() : undefined;
    if (rawTimezone && !isValidTimezone(rawTimezone)) {
      throw new ApiInputError('Client timezone must be a valid IANA timezone, for example Asia/Dubai.');
    }

    const values: unknown[] = [params.projectId, current.user.id];
    const sets: string[] = [];
    const add = (fragment: string, value: unknown) => {
      values.push(value);
      sets.push(fragment.replace('?', `$${values.length}`));
    };

    if (name !== undefined) {
      add('name = ?', name);
      add('title = ?', name);
    }
    if (description !== undefined) add('description = ?', description);
    if (status !== undefined) add('status = ?', status);

    // Only touch metadata keys that were actually sent; never clear unrelated keys.
    if (projectType !== undefined || targetCompletion !== undefined || rawTimezone !== undefined) {
      const metadata: Record<string, unknown> = { ...(project.metadata || {}) };
      if (projectType !== undefined) metadata.projectType = projectType;
      if (targetCompletion !== undefined) metadata.targetCompletion = targetCompletion;
      if (rawTimezone !== undefined) {
        metadata.clientTimezone = rawTimezone || null;
        if (Array.isArray(metadata.clients)) {
          metadata.clients = metadata.clients.map((entry) =>
            entry && typeof entry === 'object' ? { ...entry, timezone: rawTimezone || null } : entry
          );
        }
      }
      add('metadata = ?::jsonb', JSON.stringify(metadata));
    }

    if (sets.length > 0) {
      sets.push('updated_at = NOW()');
      await db.query(`UPDATE projects SET ${sets.join(', ')} WHERE id = $1 AND user_id = $2`, values);
    }

    if (clientId !== undefined) {
      await setProjectClient(current.user.id, params.projectId, clientId);
    }

    const updated = await db.queryOne<{ id: string; name: string; status: string }>(
      `SELECT id, COALESCE(title, name) AS name, COALESCE(status::text, 'active') AS status FROM projects WHERE id = $1 AND user_id = $2`,
      [params.projectId, current.user.id]
    );

    return NextResponse.json({ ok: true, project: updated, clientTimezone: rawTimezone === undefined ? undefined : rawTimezone || null });
  } catch (error) {
    return errorResponse(error, 'projects.update');
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: { projectId: string } }) {
  try {
    const current = await getCurrentUser();
    if (!current) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    await db.query(`DELETE FROM client_project_links WHERE project_id = $1 AND user_id = $2`, [params.projectId, current.user.id]);
    const deleted = await db.queryOne<{ id: string }>(
      `DELETE FROM projects WHERE id = $1 AND user_id = $2 RETURNING id`,
      [params.projectId, current.user.id]
    );
    if (!deleted) throw new ApiInputError('Project not found', 404);

    return NextResponse.json({ ok: true, deletedId: deleted.id });
  } catch (error) {
    return errorResponse(error, 'projects.delete');
  }
}
