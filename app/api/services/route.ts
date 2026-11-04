import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/current-user';
import { db } from '@/lib/db';
import { getServices } from '@/lib/product-data';
import { ensureServicesTable } from '@/lib/workspace/schema';

function makeCode(name: string): string {
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24);
}

export async function GET() {
  const current = await getCurrentUser();
  if (!current) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return NextResponse.json({ ok: true, services: await getServices(current.user.id) });
}

export async function POST(request: NextRequest) {
  const current = await getCurrentUser();
  if (!current) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    name?: string;
    code?: string;
    category?: string;
    description?: string | null;
    estimatedDuration?: string | null;
    basePrice?: number | null;
    currency?: string | null;
  };

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const category = typeof body.category === 'string' ? body.category.trim() : '';
  const code = typeof body.code === 'string' && body.code.trim() ? body.code.trim().toUpperCase() : makeCode(name);

  if (!name || !category) {
    return NextResponse.json({ error: 'Service name and category are required.' }, { status: 400 });
  }

  await ensureServicesTable();

  const existing = await db.queryOne<{ id: string }>(
    `SELECT id FROM services WHERE user_id = $1 AND code = $2`,
    [current.user.id, code]
  );
  if (existing) {
    return NextResponse.json({ error: 'Service code already exists.' }, { status: 400 });
  }

  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO services (
      id, user_id, name, code, category, description, estimated_duration, base_price, currency, is_active, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE, NOW())`,
    [
      id,
      current.user.id,
      name,
      code,
      category,
      typeof body.description === 'string' ? body.description.trim() || null : null,
      typeof body.estimatedDuration === 'string' ? body.estimatedDuration.trim() || null : null,
      typeof body.basePrice === 'number' && Number.isFinite(body.basePrice) ? body.basePrice : null,
      typeof body.currency === 'string' ? body.currency.trim() || 'USD' : 'USD',
    ]
  );

  return NextResponse.json({ ok: true, services: await getServices(current.user.id) });
}

export async function PATCH(request: NextRequest) {
  const current = await getCurrentUser();
  if (!current) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    id?: string;
    name?: string;
    code?: string;
    category?: string;
    description?: string | null;
    estimatedDuration?: string | null;
    basePrice?: number | null;
    currency?: string | null;
    isActive?: boolean;
  };

  if (!body.id) {
    return NextResponse.json({ error: 'Service id is required.' }, { status: 400 });
  }

  const updates: string[] = [];
  const values: Array<string | number | boolean | null> = [];
  let i = 1;

  const push = (column: string, value: string | number | boolean | null | undefined) => {
    if (value === undefined) return;
    updates.push(`${column} = $${i++}`);
    values.push(value);
  };

  push('name', typeof body.name === 'string' ? body.name.trim() : undefined);
  push('code', typeof body.code === 'string' ? body.code.trim().toUpperCase() : undefined);
  push('category', typeof body.category === 'string' ? body.category.trim() : undefined);
  push('description', typeof body.description === 'string' ? body.description.trim() || null : body.description);
  push('estimated_duration', typeof body.estimatedDuration === 'string' ? body.estimatedDuration.trim() || null : body.estimatedDuration);
  push('base_price', typeof body.basePrice === 'number' && Number.isFinite(body.basePrice) ? body.basePrice : body.basePrice === null ? null : undefined);
  push('currency', typeof body.currency === 'string' ? body.currency.trim() || null : body.currency);
  push('is_active', typeof body.isActive === 'boolean' ? body.isActive : undefined);

  if (updates.length === 0) {
    return NextResponse.json({ error: 'No updates provided.' }, { status: 400 });
  }

  values.push(body.id, current.user.id);
  await db.query(
    `UPDATE services SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${i++} AND user_id = $${i}`,
    values
  );

  return NextResponse.json({ ok: true, services: await getServices(current.user.id) });
}

export async function DELETE(request: NextRequest) {
  const current = await getCurrentUser();
  if (!current) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  if (!id) {
    return NextResponse.json({ error: 'Service id is required.' }, { status: 400 });
  }

  await db.query(`DELETE FROM services WHERE id = $1 AND user_id = $2`, [id, current.user.id]);
  return NextResponse.json({ ok: true, services: await getServices(current.user.id) });
}
