import { getCurrentUser } from '@/lib/current-user';
import { getClients } from '@/lib/product-data';
import { ClientsWorkspace } from '@/components/clients-workspace';

export default async function ClientsPage() {
  const current = await getCurrentUser();
  if (!current) {
    return null;
  }

  const initialClients = await getClients(current.user.id);

  return <ClientsWorkspace initialClients={initialClients} />;
}
