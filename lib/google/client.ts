import { db } from '@/lib/db';

interface GoogleTokenRow {
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: number | null;
}

interface LinkedAccountRow {
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: number | null;
}

async function refreshGoogleAccessToken(userId: string, refreshToken: string): Promise<string | null> {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return null;
  }

  const body = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    cache: 'no-store',
  });

  if (!response.ok) {
    return null;
  }

  const data = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) {
    return null;
  }

  const nextExpiry = Date.now() + (data.expires_in || 3600) * 1000;
  await Promise.all([
    db.query(
      `UPDATE "GoogleTokens"
       SET "accessToken" = $1, "expiresAt" = $2
       WHERE "userId" = $3`,
      [data.access_token, nextExpiry, userId]
    ),
    db.query(
      `UPDATE "LinkedAccount"
       SET "accessToken" = $1, "expiresAt" = $2, "updatedAt" = NOW()
       WHERE "userId" = $3 AND provider = 'google'`,
      [data.access_token, nextExpiry, userId]
    ),
  ]);
  return data.access_token;
}

export async function getGoogleAccessToken(userId: string): Promise<string | null> {
  const row = await db.queryOne<GoogleTokenRow>(
    `SELECT "accessToken", "refreshToken", "expiresAt"
     FROM "GoogleTokens"
     WHERE "userId" = $1`,
    [userId]
  );

  if (!row) {
    const linked = await db.queryOne<LinkedAccountRow>(
      `SELECT "accessToken", "refreshToken", "expiresAt"
       FROM "LinkedAccount"
       WHERE "userId" = $1 AND provider = 'google'
       ORDER BY "isPrimary" DESC, "updatedAt" DESC
       LIMIT 1`,
      [userId]
    );

    if (!linked) {
      return null;
    }

    if (linked.accessToken && linked.expiresAt && linked.expiresAt > Date.now() + 60_000) {
      return linked.accessToken;
    }

    if (linked.refreshToken) {
      return refreshGoogleAccessToken(userId, linked.refreshToken);
    }

    return linked.accessToken;
  }

  if (row.accessToken && row.expiresAt && row.expiresAt > Date.now() + 60_000) {
    return row.accessToken;
  }

  if (row.refreshToken) {
    return refreshGoogleAccessToken(userId, row.refreshToken);
  }

  return row.accessToken;
}

export async function googleAuthenticatedFetch(userId: string, input: string, init?: RequestInit): Promise<Response | null> {
  const accessToken = await getGoogleAccessToken(userId);
  if (!accessToken) {
    return null;
  }

  return fetch(input, {
    ...init,
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(init?.headers || {}),
    },
    cache: 'no-store',
  });
}

export async function googleApiRequest<T>(userId: string, input: string, init?: RequestInit): Promise<T | null> {
  const response = await googleAuthenticatedFetch(userId, input, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers || {}),
    },
  });

  if (!response || !response.ok) {
    return null;
  }

  return (await response.json()) as T;
}
