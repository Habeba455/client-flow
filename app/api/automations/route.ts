import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/current-user';

export async function GET() {
  const current = await getCurrentUser();
  if (!current) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const rows = await db.query(
    `SELECT id, type, cron_expression, enabled, config, last_run_at, next_run_at
     FROM scheduled_jobs
     WHERE user_id = $1
     ORDER BY created_at DESC`,
    [current.user.id]
  );

  return NextResponse.json({ automations: rows });
}

export async function POST(request: NextRequest) {
  const current = await getCurrentUser();
  if (!current) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = (await request.json()) as {
    type?: string;
    cronExpression?: string;
    enabled?: boolean;
    config?: Record<string, unknown>;
  };

  const type = body.type?.trim() || 'assistant_automation';
  const cronExpression = body.cronExpression?.trim() || '0 * * * *';

  const row = await db.queryOne(
    `INSERT INTO scheduled_jobs (id, user_id, type, cron_expression, enabled, config, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW(), NOW())
     RETURNING id, type, cron_expression, enabled, config, last_run_at, next_run_at`,
    [randomUUID(), current.user.id, type, cronExpression, body.enabled ?? true, JSON.stringify(body.config || {})]
  );

  return NextResponse.json({ automation: row });
}
