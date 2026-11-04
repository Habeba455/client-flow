import { ProjectFinanceWorkspace } from '@/components/project-finance-workspace';
import { getCurrentUser } from '@/lib/current-user';
import { getProjectDetail } from '@/lib/product-data';

export default async function ProjectFinancePage({ params }: { params: { projectId: string } }) {
  const current = await getCurrentUser();
  if (!current) {
    return null;
  }

  const project = await getProjectDetail(current.user.id, params.projectId);
  if (!project) {
    return null;
  }

  return (
    <ProjectFinanceWorkspace
      projectId={params.projectId}
      initialInvoices={project.invoices}
      initialExpenses={project.expenses}
    />
  );
}
