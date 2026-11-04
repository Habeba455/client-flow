import Link from 'next/link';
import { EmptyState, StatusPill } from '@/components/workspace-ui';
import { getCurrentUser } from '@/lib/current-user';
import { getDashboardData } from '@/lib/product-data';

export default async function DashboardPage() {
  const current = await getCurrentUser();
  if (!current) {
    return null;
  }

  const data = await getDashboardData(current.user.id);

  return (
    <div className="page-stack dashboard-page">
      <section className="dashboard-hero">
        <div>
          <h1 className="dashboard-hero-title">Welcome back, {current.user.name?.split(' ')[0] || 'there'}</h1>
          <p className="dashboard-hero-subtitle">
            {data.onboardingReady
              ? 'Your central workspace for emails, projects, tasks, and calendar.'
              : 'Complete your profile to personalize your assistant.'}
          </p>
        </div>
        <Link href="/assistant" className="primary-action dashboard-hero-action">
          New Chat
        </Link>
      </section>

      {!data.onboardingReady ? (
        <section className="panel-card onboarding-banner dashboard-banner">
          <div className="banner-copy dashboard-banner-copy">
            <div>
              <h2>Set up your AI assistant</h2>
              <p>Complete a quick onboarding so prompts are calibrated to your firm’s voice, services, and positioning.</p>
            </div>
            <Link href="/assistant" className="ghost-link-button dashboard-banner-action">
              Get Started
            </Link>
          </div>
        </section>
      ) : null}

      <div className="metrics-grid dashboard-metrics-grid">
        {[
          { label: 'Active Projects', value: data.metrics.activeProjects, hint: `${data.metrics.activeProjects} total`, tone: 'neutral', glyph: 'PJ' },
          { label: 'Pending Tasks', value: data.metrics.pendingTasks, hint: `${Math.max(data.metrics.pendingTasks - data.metrics.highPriority, 0)} completed`, tone: 'success', glyph: 'TS' },
          { label: 'High Priority', value: data.metrics.highPriority, hint: 'Require attention', tone: 'warning', glyph: 'HP' },
          { label: 'Overdue', value: data.metrics.overdue, hint: data.metrics.overdue > 0 ? 'Needs recovery' : 'All on track', tone: 'danger', glyph: 'OD' },
        ].map((metric) => (
          <div key={metric.label} className={`metric-card metric-${metric.tone} dashboard-metric-card`}>
            <div className="dashboard-metric-top">
              <div className="metric-label">{metric.label}</div>
              <span className={`dashboard-metric-glyph dashboard-metric-glyph-${metric.tone}`}>{metric.glyph}</span>
            </div>
            <div className="metric-value">{metric.value}</div>
            <div className="metric-hint">{metric.hint}</div>
          </div>
        ))}
      </div>

      <div className="dashboard-grid dashboard-top-grid">
        <section className="panel-card dashboard-card">
          <div className="panel-card-header dashboard-card-header">
            <h2>Priority Emails · Last 24h</h2>
            <Link href="/email-hub" className="dashboard-card-link">
              Open Hub
            </Link>
          </div>
          {data.priorityEmails.length > 0 ? (
            <div className="dashboard-email-list">
              {data.priorityEmails.map((email) => (
                <div key={email.id} className="dashboard-email-row">
                  <span className="dashboard-list-dot" aria-hidden="true" />
                  <div className="dashboard-email-copy">
                    <strong>{email.from}</strong>
                    <p>{email.subject}</p>
                    <small>{email.snippet || 'No snippet available'}</small>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              title="No synced inbox items"
              description="Connect a mailbox through Nylas or wait for email summaries to populate."
              actionHref="/email-hub"
              actionLabel="Open Email Hub"
            />
          )}
        </section>

        <section className="panel-card dashboard-card">
          <div className="panel-card-header dashboard-card-header">
            <h2>{`Today · ${data.todayLabel}`}</h2>
            <Link href="/calendar" className="dashboard-card-link">
              Full view
            </Link>
          </div>
          {data.todayEvents.length > 0 ? (
            <div className="dashboard-events-list">
              {data.todayEvents.map((event) => (
                <div key={event.id} className="dashboard-event-row">
                  <div className="dashboard-event-rail" aria-hidden="true" />
                  <div className="dashboard-event-copy">
                    <strong>{event.title}</strong>
                    <p>
                      {new Date(event.start).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: data.userTimezone })} -{' '}
                      {new Date(event.end).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: data.userTimezone })}
                    </p>
                  </div>
                  <StatusPill tone="neutral">{event.attendeeCount} people</StatusPill>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState title="No meetings today" description="Calendar events synced from Google will appear here." />
          )}
        </section>

        <section className="dashboard-section dashboard-card-full">
          <div className="dashboard-section-header">
            <h2>Quick Actions</h2>
          </div>
          <div className="quick-actions-grid dashboard-quick-actions-grid">
            {data.quickActions.map((action) => (
              <Link key={action.title} href={action.href} className="quick-action-card dashboard-quick-action-card">
                <strong>{action.title}</strong>
                <p>{action.description}</p>
              </Link>
            ))}
          </div>
        </section>

      </div>

      <section className="panel-card dashboard-card dashboard-card-full">
        <div className="panel-card-header dashboard-card-header">
          <h2>Upcoming Tasks</h2>
          <Link href="/tasks" className="dashboard-card-link">
            View all
          </Link>
        </div>
        {data.upcomingTasks.length > 0 ? (
          <div className="task-line-list dashboard-task-list">
            {data.upcomingTasks.map((task) => (
              <div key={task.id} className="task-line dashboard-task-row">
                <div className="task-line-bullet" />
                <div className="dashboard-task-copy">
                  <strong>{task.title}</strong>
                  <p>{task.projectName || 'No project linked'}</p>
                </div>
                <div className="task-line-meta dashboard-task-meta">
                  <StatusPill tone={task.priority === 'high' ? 'danger' : 'neutral'}>{task.priority}</StatusPill>
                  <span>{task.dueLabel}</span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState title="No upcoming tasks" description="Generated tasks and manual tasks will appear here." />
        )}
      </section>
    </div>
  );
}
