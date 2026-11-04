import Link from 'next/link';

const TABS = [
  { slug: '', label: 'Overview' },
  { slug: '/documents', label: 'Documents' },
  { slug: '/todos', label: 'To-Dos' },
  { slug: '/assistant', label: 'Assistant' },
  { slug: '/finance', label: 'Finance' },
];

export function ProjectTabs({ projectId, active }: { projectId: string; active: string }) {
  return (
    <div className="project-tabs">
      {TABS.map((tab) => {
        const href = `/projects/${projectId}${tab.slug}`;
        const selected = active === href;
        return (
          <Link key={href} href={href} className={`project-tab ${selected ? 'active' : ''}`}>
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
