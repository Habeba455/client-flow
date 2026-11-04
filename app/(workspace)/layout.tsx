import { redirect } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { AppShell } from '@/components/app-shell';
import { DatabaseUnavailableState } from '@/components/database-unavailable-state';
import { authOptions } from '@/lib/auth';
import { getCurrentUser } from '@/lib/current-user';
import { isDatabaseConnectionError } from '@/lib/db';

export default async function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  let current: Awaited<ReturnType<typeof getCurrentUser>>;

  try {
    current = await getCurrentUser();
  } catch (error) {
    if (!isDatabaseConnectionError(error)) {
      throw error;
    }

    console.error('[workspace-layout] Database connection failed', error);

    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
      redirect('/auth/signin');
    }

    return (
      <AppShell userName={session.user.name || null} userEmail={session.user.email}>
        <DatabaseUnavailableState />
      </AppShell>
    );
  }

  if (!current) {
    redirect('/auth/signin');
  }

  return (
    <AppShell userName={current.user.name} userEmail={current.user.email}>
      {children}
    </AppShell>
  );
}
