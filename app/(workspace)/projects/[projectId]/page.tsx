import Link from 'next/link';
import { DeleteProjectButton } from '@/components/delete-project-button';
import { EmptyState, Panel, StatusPill } from '@/components/workspace-ui';
import { getCurrentUser } from '@/lib/current-user';
import { getProjectDetail } from '@/lib/product-data';

function formatStoredDate(value: string | null): string {
  if (!value) return 'Not set';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function toneForStatus(status: string): 'neutral' | 'success' | 'warning' | 'danger' {
  const normalized = status.toLowerCase();
  if (normalized.includes('complete') || normalized.includes('done')) return 'success';
  if (normalized.includes('progress') || normalized.includes('hold')) return 'warning';
  if (normalized.includes('risk') || normalized.includes('blocked')) return 'danger';
  return 'neutral';
}

function isSyntheticProjectMemberEmail(value: string): boolean {
  return value.endsWith('@project-member.local');
}

export default async function ProjectOverviewPage({ params }: { params: { projectId: string } }) {
  const current = await getCurrentUser();
  if (!current) {
    return null;
  }

  const project = await getProjectDetail(current.user.id, params.projectId);
  if (!project) {
    return null;
  }

  return (
    <div className="dashboard-grid">
      <Panel
        title="AI Project Summary"
        action={
          <Link
            href={`/projects/${params.projectId}/assistant?prompt=${encodeURIComponent(
              'Summarize the current project record, key milestones, open tasks, recent emails, meetings, and document insights.'
            )}`}
            className="ghost-link-button"
          >
            Generate
          </Link>
        }
        className="full-span"
      >
        <p>{project.summary || project.description || 'Use the Assistant tab to generate a project summary from the current workstream.'}</p>
      </Panel>

      <Panel title="Project Record">
        <div className="list-stack">
          <div className="list-row compact">
            <div>
              <strong>Client / Entity</strong>
              <p>{project.clientEntity || 'Not specified'}</p>
            </div>
          </div>
          <div className="list-row compact">
            <div>
              <strong>Linked Clients</strong>
              <p>
                {project.linkedClients.length > 0
                  ? project.linkedClients.map((client) => client.name).join(', ')
                  : 'Manage client links from the Clients page'}
              </p>
            </div>
          </div>
          <div className="list-row compact">
            <div>
              <strong>Project Type</strong>
              <p>{project.projectType || 'Not specified'}</p>
            </div>
          </div>
          <div className="list-row compact">
            <div>
              <strong>Project Owner</strong>
              <p>{project.projectOwner || 'Not specified'}</p>
            </div>
          </div>
          <div className="list-row compact">
            <div>
              <strong>Timeline</strong>
              <p>
                {formatStoredDate(project.startDate)} to {formatStoredDate(project.targetCompletion)}
              </p>
            </div>
          </div>
          <div className="list-row compact">
            <div>
              <strong>Engagement Value</strong>
              <p>{project.engagementValue || 'TBD'}</p>
            </div>
          </div>
        </div>
      </Panel>

      <Panel
        title="Milestones"
        action={
          <Link
            href={`/projects/${params.projectId}/assistant?prompt=${encodeURIComponent(
              'Show the current project record and update milestones or target dates if needed.'
            )}`}
            className="ghost-link-button"
          >
            Update
          </Link>
        }
      >
        {project.milestones.length > 0 ? (
          <div className="table-like-list">
            {project.milestones.map((milestone) => (
              <div key={`${milestone.title}-${milestone.targetDate || 'none'}`} className="table-like-row">
                <div>
                  <strong>{milestone.title}</strong>
                  <p>{formatStoredDate(milestone.targetDate)}</p>
                </div>
                <StatusPill tone={toneForStatus(milestone.status)}>{milestone.status}</StatusPill>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState title="No milestones yet" description="Use the Assistant to define milestones and anchor project delivery." />
        )}
      </Panel>

      <Panel
        title="Team Roster"
        action={
          <Link
            href={`/projects/${params.projectId}/assistant?prompt=${encodeURIComponent(
              'Show the project record and update the team roster with names, roles, responsibilities, access, and invite any missing team members.'
            )}`}
            className="ghost-link-button"
          >
            Manage
          </Link>
        }
      >
        {project.pendingInvites.length > 0 ? (
          <div className="list-stack" style={{ marginBottom: project.teamMembers.length > 0 ? 16 : 0 }}>
            {project.pendingInvites.map((invite, index) => (
              <div key={`${invite.name}-${index}`} className="list-row compact">
                <div>
                  <strong>{invite.name}</strong>
                  <p>{invite.role || 'Role not specified'}</p>
                  <p>{invite.reason}</p>
                </div>
                <StatusPill tone="warning">Invite Needed</StatusPill>
              </div>
            ))}
          </div>
        ) : null}
        {project.teamMembers.length > 0 ? (
          <div className="table-like-list">
            {project.teamMembers.map((member) => (
              <div key={member.email} className="table-like-row">
                <div>
                  <strong>{member.name}</strong>
                  <p>{isSyntheticProjectMemberEmail(member.email) ? 'Email not captured' : member.email}</p>
                </div>
                <div>
                  <strong>{member.role || 'Team member'}</strong>
                  <p>{member.responsibilities || member.accessLevel || 'No responsibilities captured'}</p>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState title="No team members yet" description="Use the Assistant to add team members and roles so tasks can be assigned." />
        )}
      </Panel>

      <Panel title="Open To-Dos">
        {project.todos.length > 0 ? (
          <div className="list-stack">
            {project.todos.slice(0, 5).map((todo) => (
              <div key={todo.id} className="list-row compact">
                <div>
                  <strong>{todo.title}</strong>
                  <p>
                    {todo.priority}
                    {todo.dueAt ? ` · Due ${formatStoredDate(todo.dueAt)}` : ''}
                  </p>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState title="All tasks complete" description="Add tasks in the To-Dos tab or generate them from the Assistant." />
        )}
      </Panel>

      <Panel title="Recent Emails">
        {project.recentEmails.length > 0 ? (
          <div className="list-stack">
            {project.recentEmails.map((email) => (
              <div key={email.id} className="list-row compact">
                <div>
                  <strong>{email.subject}</strong>
                  <p>{email.summary}</p>
                  <p>{email.lastMessageAt ? formatStoredDate(email.lastMessageAt) : 'No recent date recorded'}</p>
                </div>
                {email.replyNeeded ? <StatusPill tone="warning">Reply Needed</StatusPill> : null}
              </div>
            ))}
          </div>
        ) : (
          <EmptyState title="No project email history yet" description="Run a sync or connect related emails to build project memory." />
        )}
      </Panel>

      <Panel title="Upcoming Meetings">
        {project.meetings.length > 0 ? (
          <div className="list-stack">
            {project.meetings.slice(0, 6).map((meeting) => (
              <div key={meeting.id} className="list-row compact">
                <div>
                  <strong>{meeting.title}</strong>
                  <p>{meeting.meetingDate ? new Date(meeting.meetingDate).toLocaleString() : 'Date not set'}</p>
                  <p>{meeting.content || 'No meeting notes recorded.'}</p>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState title="No upcoming meetings" description="Meeting notes and calendar-linked items will appear here." />
        )}
      </Panel>

      <Panel title="Project Finance">
        <div className="list-stack">
          <div className="list-row compact">
            <div>
              <strong>Invoices</strong>
              <p>{project.invoices.length} linked invoice{project.invoices.length === 1 ? '' : 's'}</p>
            </div>
          </div>
          <div className="list-row compact">
            <div>
              <strong>Expenses</strong>
              <p>{project.expenses.length} project expense entr{project.expenses.length === 1 ? 'y' : 'ies'}</p>
            </div>
          </div>
          <Link href={`/projects/${params.projectId}/finance`} className="ghost-link-button">
            Open Finance Tab
          </Link>
        </div>
      </Panel>

      <Panel title="Danger zone">
        <DeleteProjectButton projectId={params.projectId} projectName={project.name} />
      </Panel>
    </div>
  );
}
