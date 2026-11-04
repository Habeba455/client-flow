import { NextRequest, NextResponse } from 'next/server';
import { buildNylasAuthUrl, isNylasConfigured } from '@/lib/nylas/client';
import { getCurrentUser } from '@/lib/current-user';

export async function GET(request: NextRequest) {
  const current = await getCurrentUser();
  if (!current) {
    return NextResponse.redirect(new URL('/auth/signin', request.url));
  }

  if (!isNylasConfigured()) {
    return NextResponse.json({ error: 'Nylas is not configured.' }, { status: 500 });
  }

  const provider = request.nextUrl.searchParams.get('provider');
  const redirectTo = request.nextUrl.searchParams.get('redirect') || '/settings';
  const state = Buffer.from(JSON.stringify({ redirectTo }), 'utf8').toString('base64url');
  const url = buildNylasAuthUrl({
    provider: provider === 'google' || provider === 'microsoft' ? provider : undefined,
    loginHint: current.user.email,
    state,
    baseUrl: request.nextUrl.origin,
  });

  return NextResponse.redirect(url);
}
