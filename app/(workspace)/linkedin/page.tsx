import Link from 'next/link';
import { PageHeader, Panel, EmptyState } from '@/components/workspace-ui';
import { getAssistantProfile } from '@/lib/assistant-profile';
import { getCurrentUser } from '@/lib/current-user';

const STARTERS = [
  'Draft a LinkedIn post from this week’s client work',
  'Write a direct LinkedIn outreach message for a warm prospect',
  'Turn my latest proposal into a thought-leadership post',
  'Suggest 5 LinkedIn content ideas for my firm',
];

export default async function LinkedInPage() {
  const current = await getCurrentUser();
  if (!current) {
    return null;
  }

  const profile = await getAssistantProfile(current.user.id);

  return (
    <div className="page-stack">
      <PageHeader
        title="LinkedIn"
        subtitle="Use the assistant to draft posts, outreach messages, and thought-leadership from your firm context."
        action={
          <Link href="/assistant" className="primary-action">
            Open Assistant
          </Link>
        }
      />

      <Panel title="Firm Positioning">
        {profile?.profile ? (
          <div className="list-stack">
            <div className="list-row compact">
              <div>
                <strong>{profile.profile.firm_name || 'Your firm'}</strong>
                <p>{profile.profile.positioning || profile.profile.firm_description || 'No positioning set yet.'}</p>
              </div>
            </div>
            <div className="quick-actions-grid">
              {STARTERS.map((prompt) => (
                <Link key={prompt} href={`/assistant?prompt=${encodeURIComponent(prompt)}`} className="quick-action-card">
                  <strong>{prompt}</strong>
                  <p>Use the assistant with your saved firm profile to draft posts and messages.</p>
                </Link>
              ))}
            </div>
          </div>
        ) : (
          <EmptyState
            title="Complete assistant setup first"
            description="Your LinkedIn drafting workflows use the same firm profile as the main assistant."
            actionHref="/assistant"
            actionLabel="Open Assistant"
          />
        )}
      </Panel>
    </div>
  );
}
