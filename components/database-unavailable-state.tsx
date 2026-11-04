import { EmptyState, PageHeader, Panel } from '@/components/workspace-ui';

export function DatabaseUnavailableState({
  title = 'Workspace is temporarily unavailable',
  description = 'The database connection dropped while loading this page. Refresh in a moment and try again.',
}: {
  title?: string;
  description?: string;
}) {
  return (
    <div className="page-stack">
      <PageHeader
        title={title}
        subtitle="This is usually a temporary connection issue. The page will load normally again once the database is reachable."
      />

      <Panel title="Connection issue">
        <EmptyState title="Database connection lost" description={description} />
      </Panel>
    </div>
  );
}
