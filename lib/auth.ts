import type { NextAuthOptions } from 'next-auth';
import GoogleProvider from 'next-auth/providers/google';
import AzureADProvider from 'next-auth/providers/azure-ad';
import { db } from '@/lib/db';

async function upsertUser(params: {
  name?: string | null;
  email: string;
  image?: string | null;
  provider: string;
}) {
  const existing = await db.queryOne<{ id: string; role: string; authProvider: string }>(
    'SELECT id, role, "authProvider" FROM "User" WHERE email = $1',
    [params.email]
  );

  if (existing) {
    await db.query(
      'UPDATE "User" SET name = $1, image = $2, "authProvider" = $3, "updatedAt" = NOW() WHERE id = $4',
      [params.name || null, params.image || null, params.provider, existing.id]
    );
    return { id: existing.id, role: existing.role, authProvider: existing.authProvider };
  }

  const inserted = await db.queryOne<{ id: string; role: string; authProvider: string }>(
    `INSERT INTO "User" (name, email, image, "authProvider", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, NOW(), NOW())
     RETURNING id, role, "authProvider"`,
    [params.name || null, params.email, params.image || null, params.provider]
  );

  if (!inserted) {
    throw new Error('Failed to create user');
  }

  return inserted;
}

const providers = [];

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  providers.push(
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      allowDangerousEmailAccountLinking: true,
      authorization: {
        params: {
          scope: ['openid', 'email', 'profile'].join(' '),
          prompt: 'consent',
          access_type: 'offline',
        },
      },
    })
  );
}

if (process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET) {
  providers.push(
    AzureADProvider({
      clientId: process.env.MS_CLIENT_ID,
      clientSecret: process.env.MS_CLIENT_SECRET,
      tenantId: process.env.MS_TENANT_ID || 'common',
      allowDangerousEmailAccountLinking: true,
      authorization: {
        params: {
          scope: ['openid', 'email', 'profile', 'offline_access', 'User.Read'].join(' '),
          prompt: 'consent',
        },
      },
    })
  );
}

export const authOptions: NextAuthOptions = {
  secret: process.env.NEXTAUTH_SECRET,
  session: {
    strategy: 'jwt',
    maxAge: 7 * 24 * 60 * 60,
  },
  pages: {
    signIn: '/auth/signin',
  },
  providers,
  callbacks: {
    async signIn({ user, account }) {
      if (!user.email || !account) {
        return false;
      }
      await upsertUser({
        name: user.name,
        email: user.email,
        image: user.image,
        provider: account.provider,
      });
      return true;
    },
    async jwt({ token, user, account }) {
      if (user?.email) {
        const dbUser = await db.queryOne<{ id: string; role: string; authProvider: string }>(
          'SELECT id, role, "authProvider" FROM "User" WHERE email = $1',
          [user.email]
        );
        if (dbUser) {
          token.userId = dbUser.id;
          token.role = dbUser.role;
          token.provider = dbUser.authProvider;
        }
      }
      if (account?.provider) {
        token.provider = account.provider;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = typeof token.userId === 'string' ? token.userId : '';
        session.user.role = typeof token.role === 'string' ? token.role : 'user';
        session.user.authProvider = typeof token.provider === 'string' ? token.provider : undefined;
      }
      return session;
    },
  },
};
