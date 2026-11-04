import { AssistantConsole } from '@/components/assistant-console';
import { DatabaseUnavailableState } from '@/components/database-unavailable-state';
import { getConversation } from '@/lib/assistant/conversations';
import { getCurrentUser } from '@/lib/current-user';
import { isDatabaseConnectionError } from '@/lib/db';
import { getAssistantData, getProjectDetail } from '@/lib/product-data';

export default async function ProjectAssistantPage({
  params,
  searchParams,
}: {
  params: { projectId: string };
  searchParams?: { conversationId?: string; prompt?: string };
}) {
  const current = await getCurrentUser();
  if (!current) {
    return null;
  }

  try {
    const [assistantData, project, conversation] = await Promise.all([
      getAssistantData(current.user.id, params.projectId),
      getProjectDetail(current.user.id, params.projectId),
      searchParams?.conversationId ? getConversation(current.user.id, searchParams.conversationId) : Promise.resolve(null),
    ]);

    return (
      <AssistantConsole
        initialMode={assistantData.profile ? 'assistant' : 'onboarding'}
        initialProfile={assistantData.profile?.profile ?? null}
        initialConversation={conversation}
        conversations={assistantData.conversations}
        pendingApprovals={assistantData.approvals}
        projectId={params.projectId}
        projectName={project?.name || 'Project'}
        surface="project_assistant"
        basePath={`/projects/${params.projectId}/assistant`}
        initialInput={searchParams?.prompt || ''}
      />
    );
  } catch (error) {
    if (!isDatabaseConnectionError(error)) {
      throw error;
    }

    console.error('[project-assistant-page] Database connection failed', error);

    return (
      <DatabaseUnavailableState
        title="Project assistant is temporarily unavailable"
        description="The project assistant could not load project context because the database connection dropped. Refresh this page and try again."
      />
    );
  }
}
