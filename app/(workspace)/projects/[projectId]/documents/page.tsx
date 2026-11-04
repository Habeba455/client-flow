import { ProjectDocumentsWorkspace } from '@/components/project-documents-workspace';
import { getCurrentUser } from '@/lib/current-user';
import { getProjectDetail } from '@/lib/product-data';

export default async function ProjectDocumentsPage({ params }: { params: { projectId: string } }) {
  const current = await getCurrentUser();
  if (!current) {
    return null;
  }

  const project = await getProjectDetail(current.user.id, params.projectId);

  if (!project) {
    return null;
  }

  return (
    <ProjectDocumentsWorkspace
      projectId={params.projectId}
      initialDocuments={project.documents}
    />
  );
}
