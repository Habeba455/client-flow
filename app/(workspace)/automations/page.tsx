import { AutomationsWorkspace } from '@/components/automations-workspace';
import { getCurrentUser } from '@/lib/current-user';
import { getAutomationsData } from '@/lib/product-data';

export default async function AutomationsPage() {
  const current = await getCurrentUser();
  if (!current) {
    return null;
  }

  const automations = await getAutomationsData(current.user.id);

  return <AutomationsWorkspace initialAutomations={automations} />;
}
