import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/current-user';

export async function PATCH(request: NextRequest, { params }: { params: { automationId: string } }) {
  const current = await getCurrentUser();
  if (!current) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = (await request.json()) as {
    enabled?: boolean;
    type?: string;
    cronExpression?: string;
    config?: Record<string, unknown>;
  };

  const existing = await db.queryOne<{ id: string }>(
    `SELECT id FROM scheduled_jobs WHERE id = $1 AND user_id = $2`,
    [params.automationId, current.user.id]
  );
  if (!existing) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const row = await db.queryOne(
    `UPDATE scheduled_jobs
     SET type = COALESCE($3, type),
         cron_expression = COALESCE($4, cron_expression),
         enabled = COALESCE($5, enabled),
         config = COALESCE($6::jsonb, config),
         updated_at = NOW()
     WHERE id = $1 AND user_id = $2
     RETURNING id, type, cron_expression, enabled, config, last_run_at, next_run_at`,
    [
      params.automationId,
      current.user.id,
      body.type?.trim() || null,
      body.cronExpression?.trim() || null,
      typeof body.enabled === 'boolean' ? body.enabled : null,
      body.config ? JSON.stringify(body.config) : null,
    ]
  );

  return NextResponse.json({ automation: row });
}

export async function DELETE(_request: NextRequest, { params }: { params: { automationId: string } }) {
  const current = await getCurrentUser();
  if (!current) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  await db.query(`DELETE FROM scheduled_jobs WHERE id = $1 AND user_id = $2`, [params.automationId, current.user.id]);
  return NextResponse.json({ success: true });
}
