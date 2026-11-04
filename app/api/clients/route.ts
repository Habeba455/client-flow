import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/current-user';
import { db } from '@/lib/db';
import { ensureClientsTable } from '@/lib/workspace/schema';
import { enrichClientProfile } from '@/lib/client-intelligence';
import { getClient, getClients } from '@/lib/product-data';
import { resolveTimezoneInput } from '@/lib/timezones';

export async function GET() {
  const current = await getCurrentUser();
  if (!current) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return NextResponse.json({
    clients: await getClients(current.user.id),
  });
}

export async function POST(request: NextRequest) {
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
  };
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const rawTimezone = typeof body.timezone === 'string' ? body.timezone.trim() : '';
  const resolvedTimezone = rawTimezone ? resolveTimezoneInput(rawTimezone) : null;
  const company = typeof body.company === 'string' ? body.company.trim() : '';
  const primaryEmail = typeof body.primaryEmail === 'string' ? body.primaryEmail.trim() : '';
  const website = typeof body.website === 'string' ? body.website.trim() : '';
  const location = typeof body.location === 'string' ? body.location.trim() : '';
  const relationshipNotes = typeof body.relationshipNotes === 'string' ? body.relationshipNotes.trim() : '';

  if (!name) {
    return NextResponse.json({ error: 'Client name is required.' }, { status: 400 });
  }
  if (rawTimezone && !resolvedTimezone) {
    return NextResponse.json(
      { error: 'Timezone could not be recognized. Try a city or country like Colombo, Sri Lanka, or use an IANA timezone like Asia/Colombo.' },
      { status: 400 }
    );
  }

  await ensureClientsTable();

  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO clients (
      id, user_id, name, timezone, company, primary_email, website, location, relationship_notes, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
    [id, current.user.id, name, resolvedTimezone || null, company || null, primaryEmail || null, website || null, location || null, relationshipNotes || null]
  );

  try {
    const enrichment = await enrichClientProfile({
      name,
      company: company || null,
      website: website || null,
      location: location || null,
    });

    await db.query(
      `UPDATE clients
       SET enrichment_summary = $3,
           enrichment_sources = $4::jsonb,
           enrichment_updated_at = NOW(),
           updated_at = NOW()
       WHERE id = $1 AND user_id = $2`,
      [id, current.user.id, enrichment.summary, JSON.stringify(enrichment.sources)]
    );
  } catch (error) {
    console.warn('[clients:create] enrichment skipped', error);
  }

  const client = await getClient(current.user.id, id);

  return NextResponse.json({
    ok: true,
    client,
  });
}
