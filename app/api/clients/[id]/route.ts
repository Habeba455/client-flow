import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/current-user';
import { db } from '@/lib/db';
import { ensureClientProjectLinksTable, ensureClientsTable } from '@/lib/workspace/schema';
import { getClient, getClientContextData, getServices, listProjects, setClientProjects } from '@/lib/product-data';
import { enrichClientProfile, recommendClientServices } from '@/lib/client-intelligence';
import { resolveTimezoneInput } from '@/lib/timezones';

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const current = await getCurrentUser();
  if (!current) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    name?: string;
    timezone?: string | null;
    company?: string | null;
    primaryEmail?: string | null;
    website?: string | null;
    location?: string | null;
    relationshipNotes?: string | null;
    linkedProjectIds?: string[];
  };
  const name = typeof body.name === 'string' ? body.name.trim() : undefined;
  const rawTimezone = typeof body.timezone === 'string' ? body.timezone.trim() : undefined;
  const resolvedTimezone = rawTimezone !== undefined ? (rawTimezone ? resolveTimezoneInput(rawTimezone) : null) : undefined;
  const company = typeof body.company === 'string' ? body.company.trim() : undefined;
  const primaryEmail = typeof body.primaryEmail === 'string' ? body.primaryEmail.trim() : undefined;
  const website = typeof body.website === 'string' ? body.website.trim() : undefined;
  const location = typeof body.location === 'string' ? body.location.trim() : undefined;
  const relationshipNotes = typeof body.relationshipNotes === 'string' ? body.relationshipNotes.trim() : undefined;
  const linkedProjectIds = Array.isArray(body.linkedProjectIds) ? body.linkedProjectIds.filter((value): value is string => typeof value === 'string') : undefined;

  if (rawTimezone !== undefined && rawTimezone !== '' && !resolvedTimezone) {
    return NextResponse.json(
      { error: 'Timezone could not be recognized. Try a city or country like Colombo, Sri Lanka, or use an IANA timezone like Asia/Colombo.' },
      { status: 400 }
    );
  }

  await ensureClientsTable();

  const existing = await db.queryOne<{ id: string }>(
    `SELECT id FROM clients WHERE id = $1 AND user_id = $2`,
    [params.id, current.user.id]
  );
  if (!existing) {
    return NextResponse.json({ error: 'Client not found' }, { status: 404 });
  }

  if (
    name !== undefined ||
    rawTimezone !== undefined ||
    company !== undefined ||
    primaryEmail !== undefined ||
    website !== undefined ||
    location !== undefined ||
    relationshipNotes !== undefined
  ) {
    const updates: string[] = [];
    const values: (string | null)[] = [];
    let i = 1;
    if (name !== undefined) {
      if (!name) {
        return NextResponse.json({ error: 'Client name cannot be empty.' }, { status: 400 });
      }
      updates.push(`name = $${i++}`);
      values.push(name);
    }
    if (rawTimezone !== undefined) {
      updates.push(`timezone = $${i++}`);
      values.push(resolvedTimezone || null);
    }
    if (company !== undefined) {
      updates.push(`company = $${i++}`);
      values.push(company || null);
    }
    if (primaryEmail !== undefined) {
      updates.push(`primary_email = $${i++}`);
      values.push(primaryEmail || null);
    }
    if (website !== undefined) {
      updates.push(`website = $${i++}`);
      values.push(website || null);
    }
    if (location !== undefined) {
      updates.push(`location = $${i++}`);
      values.push(location || null);
    }
    if (relationshipNotes !== undefined) {
      updates.push(`relationship_notes = $${i++}`);
      values.push(relationshipNotes || null);
    }
    updates.push('updated_at = NOW()');
    values.push(params.id, current.user.id);
    await db.query(
      `UPDATE clients SET ${updates.join(', ')} WHERE id = $${i} AND user_id = $${i + 1}`,
      values
    );
  }

  if (linkedProjectIds !== undefined) {
    await ensureClientProjectLinksTable();
    await setClientProjects(current.user.id, params.id, linkedProjectIds);
  }

  return NextResponse.json({
    ok: true,
    client: await getClient(current.user.id, params.id),
  });
}

export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  const current = await getCurrentUser();
  if (!current) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  await ensureClientsTable();
  const client = await getClient(current.user.id, params.id);
  if (!client) {
    return NextResponse.json({ error: 'Client not found' }, { status: 404 });
  }

  const [context, allProjects] = await Promise.all([
    getClientContextData(current.user.id, params.id),
    listProjects(current.user.id),
  ]);
  return NextResponse.json({ ok: true, client, ...context, allProjects });
}

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const current = await getCurrentUser();
  if (!current) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as { action?: string };
  const client = await getClient(current.user.id, params.id);
  if (!client) {
    return NextResponse.json({ error: 'Client not found' }, { status: 404 });
  }

  if (body.action === 'enrich') {
    const enrichment = await enrichClientProfile({
      name: client.name,
      company: client.company,
      website: client.website,
      location: client.location,
    });

    await db.query(
      `UPDATE clients
       SET enrichment_summary = $3,
           enrichment_sources = $4::jsonb,
           enrichment_updated_at = NOW(),
           updated_at = NOW()
       WHERE id = $1 AND user_id = $2`,
      [params.id, current.user.id, enrichment.summary, JSON.stringify(enrichment.sources)]
    );

    return NextResponse.json({ ok: true, client: await getClient(current.user.id, params.id) });
  }

  if (body.action === 'recommend') {
    const services = (await getServices(current.user.id)).filter((service) => service.isActive);
    const recommendations = await recommendClientServices({
      name: client.name,
      company: client.company,
      website: client.website,
      location: client.location,
      timezone: client.timezone,
      notes: client.relationshipNotes,
      enrichmentSummary: client.enrichmentSummary,
      services: services.map((service) => ({
        code: service.code,
        name: service.name,
        category: service.category,
        description: service.description,
        estimatedDuration: service.estimatedDuration,
        basePrice: service.basePrice,
        currency: service.currency,
      })),
    });

    await db.query(
      `UPDATE clients
       SET recommended_services = $3::jsonb,
           recommendations_updated_at = NOW(),
           updated_at = NOW()
       WHERE id = $1 AND user_id = $2`,
      [params.id, current.user.id, JSON.stringify(recommendations)]
    );

    return NextResponse.json({ ok: true, client: await getClient(current.user.id, params.id) });
  }

  return NextResponse.json({ error: 'Unsupported action' }, { status: 400 });
}

export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  const current = await getCurrentUser();
  if (!current) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const deleted = await db.queryOne<{ id: string }>(
    `DELETE FROM clients WHERE id = $1 AND user_id = $2 RETURNING id`,
    [params.id, current.user.id]
  );

  if (!deleted) {
    return NextResponse.json({ error: 'Client not found' }, { status: 404 });
  }

  return NextResponse.json({ ok: true, deletedId: deleted.id });
}
