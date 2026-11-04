'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { signOut } from 'next-auth/react';
import {
  Bot,
  BriefcaseBusiness,
  CalendarDays,
  ChevronLeft,
  Gauge,
  Inbox,
  Linkedin,
  Settings,
  Sparkles,
  SquareCheckBig,
  Users,
  Zap,
} from 'lucide-react';

const NAV_ITEMS = [
  { href: '/', label: 'Dashboard', icon: Gauge },
  { href: '/assistant', label: 'Assistant', icon: Bot },
  { href: '/email-hub', label: 'Email Hub', icon: Inbox },
  { href: '/projects', label: 'Projects', icon: BriefcaseBusiness },
  { href: '/clients', label: 'Clients', icon: Users },
  { href: '/tasks', label: 'Tasks', icon: SquareCheckBig },
  { href: '/calendar', label: 'Calendar', icon: CalendarDays },
  { href: '/automations', label: 'Automations', icon: Zap },
  { href: '/linkedin', label: 'LinkedIn', icon: Linkedin },
  { href: '/settings', label: 'Settings', icon: Settings },
];

function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AppShell({
  userName,
  userEmail,
  children,
}: {
  userName: string | null;
  userEmail: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="sidebar-brand-mark">
            <Sparkles size={18} />
          </div>
          <span>AI ASSISTANT</span>
        </div>

        <nav className="sidebar-nav">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <Link key={item.href} href={item.href} className={`sidebar-link ${isActive(pathname, item.href) ? 'active' : ''}`}>
                <Icon size={18} />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="sidebar-footer">
          <button type="button" className="sidebar-collapse">
            <ChevronLeft size={16} />
            <span>Collapse</span>
          </button>

          <button type="button" className="sidebar-user" onClick={() => signOut({ callbackUrl: '/auth/signin' })}>
            <span className="sidebar-user-name">{userName || userEmail}</span>
            <span className="sidebar-user-email">{userEmail}</span>
          </button>
        </div>
      </aside>

      <main className="app-main">
        <div className="page-frame">{children}</div>
      </main>
    </div>
  );
}
