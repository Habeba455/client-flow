import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/db';

export async function getCurrentUser() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return null;
  }

  const user = await db.queryOne<{ id: string; name: string | null; email: string; image: string | null }>(
    'SELECT id, name, email, image FROM "User" WHERE email = $1',
    [session.user.email]
  );

  if (!user) {
    return null;
  }

  return {
    session,
    user,
  };
}
