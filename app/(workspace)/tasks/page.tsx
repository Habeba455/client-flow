import { TasksList } from '@/components/tasks-list';
import { PageHeader } from '@/components/workspace-ui';
import { getCurrentUser } from '@/lib/current-user';
import { getTasksData, listProjects } from '@/lib/product-data';

export default async function TasksPage() {
  const current = await getCurrentUser();
  if (!current) {
    return null;
  }

  const [tasks, projects] = await Promise.all([getTasksData(current.user.id), listProjects(current.user.id)]);

  return (
    <div className="page-stack">
      <PageHeader title="Tasks" subtitle="Manually added and AI-generated work items, across all projects." />

      <TasksList
        projects={projects.map((project) => ({ id: project.id, name: project.name }))}
        tasks={tasks.map((t) => ({
          id: t.id,
          title: t.title,
          description: t.description ?? null,
          status: t.status,
          priority: t.priority,
          due_at: t.due_at,
          project_id: t.project_id ?? null,
          project_name: t.project_name ?? null,
        }))}
      />
    </div>
  );
}
