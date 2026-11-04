import { randomUUID } from 'node:crypto';
import { ensureAssistantRuntimeTables } from '@/lib/assistant/schema';
import { db } from '@/lib/db';

interface NylasGrantRow {
  id: string;
  user_id: string;
  grant_id: string;
  provider: string | null;
  email: string | null;
  status: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

interface NylasGrantApiRecord {
  id?: string;
  grant_id?: string;
  provider?: string;
  email?: string;
  grant_status?: string;
  status?: string;
  metadata?: Record<string, unknown>;
}

function getBaseUrl(): string {
  return (process.env.NYLAS_API_URI || 'https://api.us.nylas.com').replace(/\/+$/, '');
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function getClientSecret(): string {
  return process.env.NYLAS_CLIENT_SECRET?.trim() || requireEnv('NYLAS_API_KEY');
}

export function getPublicBaseUrl(override?: string | null): string {
  const value =
    process.env.NYLAS_REDIRECT_BASE_URL?.trim() ||
    process.env.NEXT_PUBLIC_BASE_URL?.trim() ||
    process.env.NEXTAUTH_URL?.trim() ||
    override?.trim();
  if (!value) {
    throw new Error('NYLAS_REDIRECT_BASE_URL, NEXT_PUBLIC_BASE_URL, or NEXTAUTH_URL is required');
  }
  return value.replace(/\/+$/, '');
}

function normalizeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function isNylasConfigured(): boolean {
  return Boolean(process.env.NYLAS_API_KEY && process.env.NYLAS_CLIENT_ID);
}

export function getNylasRedirectUri(baseUrlOverride?: string | null): string {
  return process.env.NYLAS_REDIRECT_URI?.trim() || `${getPublicBaseUrl(baseUrlOverride)}/api/nylas/callback`;
}

export function buildNylasAuthUrl(params: {
  provider?: 'google' | 'microsoft';
  loginHint?: string | null;
  state?: string | null;
  baseUrl?: string | null;
} = {}): string {
  const search = new URLSearchParams({
    client_id: requireEnv('NYLAS_CLIENT_ID'),
    redirect_uri: getNylasRedirectUri(params.baseUrl),
    response_type: 'code',
    access_type: 'offline',
  });

  if (params.provider) {
    search.set('provider', params.provider);
  }
  if (params.loginHint) {
    search.set('login_hint', params.loginHint);
  }
  if (params.state) {
    search.set('state', params.state);
  }
  if (process.env.NYLAS_OAUTH_SCOPES?.trim()) {
    search.set('scope', process.env.NYLAS_OAUTH_SCOPES.trim());
  }

  return `${getBaseUrl()}/v3/connect/auth?${search.toString()}`;
}

async function nylasRequest<T>(path: string, init?: RequestInit): Promise<T | null> {
  const maxAttempts = 4;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await fetch(`${getBaseUrl()}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${requireEnv('NYLAS_API_KEY')}`,
        'content-type': 'application/json',
        ...(init?.headers || {}),
      },
      cache: 'no-store',
    });

    if (response.ok) {
      if (response.status === 204) {
        return null;
      }

      return (await response.json()) as T;
    }

    const detail = await response.text();
    const isRateLimited = response.status === 429;
    if (isRateLimited && attempt < maxAttempts) {
      const retryAfterHeader = response.headers.get('retry-after');
      const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : NaN;
      const delayMs = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : attempt * 800;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      continue;
    }

    throw new Error(`Nylas request failed with ${response.status}: ${detail}`);
  }

  throw new Error('Nylas request failed after retries');
}

export async function exchangeNylasCode(code: string): Promise<{ grantId: string; provider: string | null; email: string | null; status: string | null; metadata: Record<string, unknown> }> {
  const response = await fetch(`${getBaseUrl()}/v3/connect/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      client_id: requireEnv('NYLAS_CLIENT_ID'),
      client_secret: getClientSecret(),
      grant_type: 'authorization_code',
      code,
      redirect_uri: getNylasRedirectUri(),
    }),
    cache: 'no-store',
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Nylas token exchange failed with ${response.status}: ${detail}`);
  }

  const payload = normalizeRecord(await response.json());
  const grantId = typeof payload.grant_id === 'string' ? payload.grant_id : typeof payload.id === 'string' ? payload.id : null;
  if (!grantId) {
    throw new Error('Nylas token response did not include a grant ID.');
  }

  const details = await getGrantDetails(grantId);
  return {
    grantId,
    provider:
      details?.provider ||
      (typeof payload.provider === 'string' ? payload.provider : null),
    email:
      details?.email ||
      (typeof payload.email === 'string' ? payload.email : null),
    status:
      details?.status ||
      (typeof payload.grant_status === 'string' ? payload.grant_status : typeof payload.status === 'string' ? payload.status : null),
    metadata: {
      ...payload,
      ...(details?.metadata || {}),
    },
  };
}

export async function getGrantDetails(grantId: string): Promise<{ provider: string | null; email: string | null; status: string | null; metadata: Record<string, unknown> } | null> {
  const response = await nylasRequest<{ data?: NylasGrantApiRecord }>(`/v3/grants/${grantId}`);
  const grant = normalizeRecord(response?.data);

  return {
    provider: typeof grant.provider === 'string' ? grant.provider : null,
    email: typeof grant.email === 'string' ? grant.email : null,
    status:
      typeof grant.grant_status === 'string'
        ? grant.grant_status
        : typeof grant.status === 'string'
          ? grant.status
          : null,
    metadata: grant,
  };
}

export async function upsertNylasGrant(userId: string, grant: {
  grantId: string;
  provider: string | null;
  email: string | null;
  status: string | null;
  metadata?: Record<string, unknown>;
}) {
  await ensureAssistantRuntimeTables();

  await db.query(
    `INSERT INTO nylas_grants (id, user_id, grant_id, provider, email, status, metadata, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, NOW(), NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       grant_id = EXCLUDED.grant_id,
       provider = EXCLUDED.provider,
       email = EXCLUDED.email,
       status = EXCLUDED.status,
       metadata = EXCLUDED.metadata,
       updated_at = NOW()`,
    [
      randomUUID(),
      userId,
      grant.grantId,
      grant.provider,
      grant.email,
      grant.status,
      JSON.stringify(grant.metadata || {}),
    ]
  );
}

export async function getPrimaryNylasGrant(userId: string): Promise<NylasGrantRow | null> {
  await ensureAssistantRuntimeTables();
  return db.queryOne<NylasGrantRow>(
    `SELECT id, user_id, grant_id, provider, email, status, metadata, created_at, updated_at
     FROM nylas_grants
     WHERE user_id = $1
     ORDER BY updated_at DESC
     LIMIT 1`,
    [userId]
  );
}

export async function nylasGrantRequest<T>(userId: string, path: string, init?: RequestInit): Promise<T | null> {
  const grant = await getPrimaryNylasGrant(userId);
  if (!grant?.grant_id) {
    return null;
  }
  return nylasRequest<T>(`/v3/grants/${grant.grant_id}${path}`, init);
}

export async function nylasGrantDownload(userId: string, path: string): Promise<Buffer | null> {
  const grant = await getPrimaryNylasGrant(userId);
  if (!grant?.grant_id) {
    return null;
  }

  const response = await fetch(`${getBaseUrl()}/v3/grants/${grant.grant_id}${path}`, {
    headers: {
      authorization: `Bearer ${requireEnv('NYLAS_API_KEY')}`,
    },
    cache: 'no-store',
  });

  if (!response.ok) {
    return null;
  }

  return Buffer.from(await response.arrayBuffer());
}
