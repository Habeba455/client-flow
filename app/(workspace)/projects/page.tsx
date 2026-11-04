import Link from 'next/link';
import { ProjectCreateButton } from '@/components/project-create-button';
import { EmptyState, PageHeader, Panel, StatusPill } from '@/components/workspace-ui';
import { getCurrentUser } from '@/lib/current-user';
import { getClients, listProjects } from '@/lib/product-data';

function formatStoredDate(value: string | null): string {
  if (!value) return 'No target date';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export default async function ProjectsPage() {
  const current = await getCurrentUser();
  if (!current) {
    return null;
  }

  const [projects, clients] = await Promise.all([listProjects(current.user.id), getClients(current.user.id)]);

  return (
    <div className="page-stack">
      <PageHeader
        title="Projects"
        subtitle="Project memory, documents, tasks, invoices, and AI collaboration in one place."
        action={
          <div className="inline-button-row">
            <ProjectCreateButton clients={clients.map((client) => ({ id: client.id, name: client.name }))} />
            <Link
            href={`/assistant?prompt=${encodeURIComponent('Create a new project record with the required fields, milestones, and an initial team roster.')}`}
            className="primary-action"
          >
              Create With AI
            </Link>
          </div>
        }
      />

      <Panel>
        {projects.length > 0 ? (
          <div className="project-card-grid">
            {projects.map((project) => (
              <Link key={project.id} href={`/projects/${project.id}`} className="project-list-card">
                <div className="project-list-card-top">
                  <div className="project-avatar">{project.name.slice(0, 1).toUpperCase()}</div>
                  <StatusPill tone={project.status === 'active' ? 'success' : 'neutral'}>{project.status}</StatusPill>
                </div>
                <strong>{project.name}</strong>
                <p>{project.description || 'No description added yet.'}</p>
                <p className="project-inline-meta">
                  {[project.clientEntity, project.projectType, project.targetCompletion ? formatStoredDate(project.targetCompletion) : null]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
                <div className="project-list-card-meta">
                  <span>{project.openTasks} open tasks</span>
                  <span>{project.documentCount} documents</span>
                </div>
              </Link>
            ))}
          </div>
        ) : (
          <EmptyState
            title="No projects yet"
            description="Create a project from the assistant or seed one from your first client engagement."
            actionHref={`/assistant?prompt=${encodeURIComponent('Create a new project record with milestones and an empty team roster.')}`}
            actionLabel="Create with AI"
          />
        )}
      </Panel>
    </div>
  );
}
