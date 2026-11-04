import { AssistantConsole } from '@/components/assistant-console';
import { DatabaseUnavailableState } from '@/components/database-unavailable-state';
import { getConversation } from '@/lib/assistant/conversations';
import { getCurrentUser } from '@/lib/current-user';
import { isDatabaseConnectionError } from '@/lib/db';
import { getAssistantData } from '@/lib/product-data';

export default async function AssistantPage({ searchParams }: { searchParams?: { conversationId?: string; prompt?: string } }) {
  const current = await getCurrentUser();
  if (!current) {
    return null;
  }

  try {
    const [data, conversation] = await Promise.all([
      getAssistantData(current.user.id, null),
      searchParams?.conversationId ? getConversation(current.user.id, searchParams.conversationId) : Promise.resolve(null),
    ]);

    return (
      <AssistantConsole
        initialMode={data.profile ? 'assistant' : 'onboarding'}
        initialProfile={data.profile?.profile ?? null}
        initialConversation={conversation}
        conversations={data.conversations}
        pendingApprovals={data.approvals}
        surface="assistant"
        basePath="/assistant"
        initialInput={searchParams?.prompt || ''}
      />
    );
  } catch (error) {
    if (!isDatabaseConnectionError(error)) {
      throw error;
    }

    console.error('[assistant-page] Database connection failed', error);

    return (
      <DatabaseUnavailableState
        title="Assistant is temporarily unavailable"
        description="The assistant could not load your conversation history or profile because the database connection dropped. Refresh this page and try again."
      />
    );
  }
}
