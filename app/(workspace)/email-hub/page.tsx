import { EmailHubWorkspace } from '@/components/email-hub-workspace';
import { getCurrentUser } from '@/lib/current-user';
import { getEmailHubData } from '@/lib/product-data';

export default async function EmailHubPage({ searchParams }: { searchParams?: { threadId?: string } }) {
  const current = await getCurrentUser();
  if (!current) {
    return null;
  }

  const data = await getEmailHubData(current.user.id);

  return (
    <EmailHubWorkspace
      accounts={data.accounts}
      initialInbox={data.inbox}
      initialNextCursor={data.nextCursor}
      initialSelectedThreadId={searchParams?.threadId || null}
    />
  );
}
