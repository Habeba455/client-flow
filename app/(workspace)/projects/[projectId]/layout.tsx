import { notFound } from 'next/navigation';
import { ProjectHeader } from '@/components/project-header';
import { getCurrentUser } from '@/lib/current-user';
import { getClients, getProjectDetail } from '@/lib/product-data';

function toDateInput(value: string | null): string | null {
  return value && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
}

export default async function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: { projectId: string };
}) {
  const current = await getCurrentUser();
  if (!current) {
    return null;
  }

  const [project, clients] = await Promise.all([
    getProjectDetail(current.user.id, params.projectId),
    getClients(current.user.id),
  ]);
  if (!project) {
    notFound();
  }
  const linkedClient = project.linkedClients[0] ?? null;

  return (
    <div className="page-stack">
      <ProjectHeader
        projectId={project.id}
        name={project.name}
        description={project.description}
        status={project.status}
        openTasks={project.openTasks}
        clientEntity={project.clientEntity}
        targetCompletion={project.targetCompletion}
        projectType={project.projectType}
        editInitial={{
          id: project.id,
          name: project.name,
          description: project.description,
          status: project.status,
          projectType: project.projectType,
          targetCompletion: toDateInput(project.targetCompletion),
          clientId: linkedClient?.id ?? null,
        }}
        clients={clients.map((client) => ({ id: client.id, name: client.name }))}
      />
      {children}
    </div>
  );
}
