import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/current-user';
import { db } from '@/lib/db';
import {
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

/** Manual project creation. The AI creation path (lib/assistant/project-record.ts) is unchanged. */
export async function POST(request: NextRequest) {
  try {
    const current = await getCurrentUser();
    if (!current) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = readJsonObject(await request.json().catch(() => null));
    const name = readRequiredText(body.name, 'Project name', 200);
    const description = readOptionalText(body.description, 'Description', 2000) ?? null;
    const projectType = readOptionalText(body.projectType, 'Project type', 100) ?? null;
    const targetCompletion = readDateOnly(body.targetCompletion, 'Target date') ?? null;
    const status = readEnum(body.status, 'Status', PROJECT_STATUSES) ?? 'active';
    const clientId = readId(body.clientId, 'Client') ?? null;

    const projectId = randomUUID();
    const metadata = { projectType, targetCompletion, clientId: null, source: 'manual' };

    await db.query(
      `INSERT INTO projects (id, user_id, name, title, description, status, metadata, created_at, updated_at)
       VALUES ($1, $2, $3, $3, $4, $5, $6::jsonb, NOW(), NOW())`,
      [projectId, current.user.id, name, description, status, JSON.stringify(metadata)]
    );

    if (clientId) {
      await setProjectClient(current.user.id, projectId, clientId);
    }

    return NextResponse.json({ ok: true, project: { id: projectId, name } }, { status: 201 });
  } catch (error) {
    return errorResponse(error, 'projects.create');
  }
}
