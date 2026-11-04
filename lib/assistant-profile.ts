import { db } from '@/lib/db';
import { generatePersonaIntros } from '@/lib/ai/persona-intro-generator';
import type { PersonaIntros, UserProfile } from '@/lib/ai/types';

export interface AssistantProfileRow {
  user_id: string;
  profile_json: UserProfile;
  business_analyst_intro: string | null;
  executive_assistant_intro: string | null;
  managing_partner_intro: string | null;
  updated_at: string;
}

function normalizeProfile(value: unknown): UserProfile {
  const profile = (value || {}) as Partial<UserProfile>;
  return {
    firm_name: profile.firm_name ?? null,
    firm_description: profile.firm_description ?? null,
    primary_industry: profile.primary_industry ?? null,
    secondary_industries: Array.isArray(profile.secondary_industries) ? profile.secondary_industries : [],
    firm_size: profile.firm_size ?? null,
    services: Array.isArray(profile.services) ? profile.services : [],
    client_profile: profile.client_profile ?? null,
    client_problems: Array.isArray(profile.client_problems) ? profile.client_problems : [],
    credentials: Array.isArray(profile.credentials) ? profile.credentials : [],
    geography: Array.isArray(profile.geography) ? profile.geography : [],
    positioning: profile.positioning ?? null,
    contact_email: profile.contact_email ?? null,
    contact_website: profile.contact_website ?? null,
    address: profile.address ?? null,
    user_timezone: profile.user_timezone ?? null,
    working_hours_start: profile.working_hours_start ?? '09:00',
    working_hours_end: profile.working_hours_end ?? '17:00',
  };
}

export async function getAssistantProfile(userId: string): Promise<{ profile: UserProfile; intros: PersonaIntros } | null> {
  const row = await db.queryOne<{
    user_id: string;
    profile_json: unknown;
    business_analyst_intro: string | null;
    executive_assistant_intro: string | null;
    managing_partner_intro: string | null;
    updated_at: string;
  }>(
    `SELECT user_id, profile_json, business_analyst_intro, executive_assistant_intro, managing_partner_intro, updated_at
     FROM assistant_user_profiles
     WHERE user_id = $1`,
    [userId]
  );

  if (!row) {
    return null;
  }

  return {
    profile: normalizeProfile(row.profile_json),
    intros: {
      businessAnalystIntro: row.business_analyst_intro || '',
      executiveAssistantIntro: row.executive_assistant_intro || '',
      managingPartnerIntro: row.managing_partner_intro || '',
    },
  };
}

export async function saveAssistantProfile(userId: string, profile: UserProfile): Promise<{ profile: UserProfile; intros: PersonaIntros }> {
  const intros = await generatePersonaIntros(profile);
  await db.query(
    `INSERT INTO assistant_user_profiles (user_id, profile_json, business_analyst_intro, executive_assistant_intro, managing_partner_intro, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       profile_json = EXCLUDED.profile_json,
       business_analyst_intro = EXCLUDED.business_analyst_intro,
       executive_assistant_intro = EXCLUDED.executive_assistant_intro,
       managing_partner_intro = EXCLUDED.managing_partner_intro,
       updated_at = NOW()`,
    [
      userId,
      JSON.stringify(profile),
      intros.businessAnalystIntro,
      intros.executiveAssistantIntro,
      intros.managingPartnerIntro,
    ]
  );

  return { profile, intros };
}
