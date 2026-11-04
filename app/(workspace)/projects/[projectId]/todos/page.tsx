import { ProjectTodosWorkspace } from '@/components/project-todos-workspace';
import { getCurrentUser } from '@/lib/current-user';
import { getProjectDetail } from '@/lib/product-data';

export default async function ProjectTodosPage({ params }: { params: { projectId: string } }) {
  const current = await getCurrentUser();
  if (!current) {
    return null;
  }

  const project = await getProjectDetail(current.user.id, params.projectId);
  if (!project) {
    return null;
  }

  return <ProjectTodosWorkspace projectId={params.projectId} initialTodos={project.todos} />;
}
