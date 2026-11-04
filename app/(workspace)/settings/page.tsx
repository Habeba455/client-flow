import { SettingsWorkspace } from '@/components/settings-workspace';
import { getCurrentUser } from '@/lib/current-user';
import { getSettingsData } from '@/lib/product-data';

export default async function SettingsPage() {
  const current = await getCurrentUser();
  if (!current) {
    return null;
  }

  const data = await getSettingsData(current.user.id);

  return <SettingsWorkspace initialProfile={data.profile?.profile ?? null} accounts={data.accounts} />;
}
