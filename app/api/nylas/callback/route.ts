import { NextRequest, NextResponse } from 'next/server';
import { exchangeNylasCode, getPublicBaseUrl, upsertNylasGrant } from '@/lib/nylas/client';
import { getCurrentUser } from '@/lib/current-user';

function decodeRedirect(state: string | null): string {
  if (!state) {
    return '/settings';
  }

  try {
    const parsed = JSON.parse(Buffer.from(state, 'base64url').toString('utf8')) as { redirectTo?: string };
    return typeof parsed.redirectTo === 'string' && parsed.redirectTo.startsWith('/') ? parsed.redirectTo : '/settings';
  } catch {
    return '/settings';
  }
}

export async function GET(request: NextRequest) {
  const publicBaseUrl = getPublicBaseUrl(request.nextUrl.origin);
  const buildRedirectUrl = (path: string) => new URL(path, publicBaseUrl);
  const current = await getCurrentUser();
  if (!current) {
    return NextResponse.redirect(buildRedirectUrl('/auth/signin'));
  }

  const code = request.nextUrl.searchParams.get('code');
  const error = request.nextUrl.searchParams.get('error');
  const redirectTo = decodeRedirect(request.nextUrl.searchParams.get('state'));

  if (error) {
    return NextResponse.redirect(buildRedirectUrl(`${redirectTo}?nylas_error=${encodeURIComponent(error)}`));
  }

  if (!code) {
    return NextResponse.redirect(buildRedirectUrl(`${redirectTo}?nylas_error=missing_code`));
  }

  try {
    const grant = await exchangeNylasCode(code);
    await upsertNylasGrant(current.user.id, grant);
    return NextResponse.redirect(buildRedirectUrl(`${redirectTo}?nylas=connected`));
  } catch (exchangeError) {
    const message = exchangeError instanceof Error ? exchangeError.message : 'Nylas connection failed';
    return NextResponse.redirect(buildRedirectUrl(`${redirectTo}?nylas_error=${encodeURIComponent(message)}`));
  }
}
