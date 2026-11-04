import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/current-user';
import { getPrimaryNylasGrant, isNylasConfigured } from '@/lib/nylas/client';

function normalizeProvider(value: string | undefined): 'google' | 'microsoft' | null {
  if (value === 'google') {
    return 'google';
  }
  if (value === 'microsoft' || value === 'azure-ad') {
    return 'microsoft';
  }
  return null;
}

function sanitizeRedirect(value: string | undefined): string {
  return typeof value === 'string' && value.startsWith('/') ? value : '/';
}

function grantNeedsReconnect(status: string | null | undefined): boolean {
  return /invalid|expired|revoked|deleted|failed/i.test(status || '');
}

export default async function AuthContinuePage({
  searchParams,
}: {
  searchParams?: { provider?: string; redirect?: string };
}) {
  const current = await getCurrentUser();
  if (!current) {
    redirect('/auth/signin');
  }

  const redirectTo = sanitizeRedirect(searchParams?.redirect);
  if (!isNylasConfigured()) {
    redirect(redirectTo);
  }

  const existingGrant = await getPrimaryNylasGrant(current.user.id);
  if (existingGrant?.grant_id && !grantNeedsReconnect(existingGrant.status)) {
    redirect(redirectTo);
  }

  const params = new URLSearchParams({
    redirect: redirectTo,
  });
  const provider = normalizeProvider(searchParams?.provider);
  if (provider) {
    params.set('provider', provider);
  }

  redirect(`/api/nylas/connect?${params.toString()}`);
}
