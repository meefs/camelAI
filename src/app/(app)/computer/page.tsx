import { redirect } from 'next/navigation';
import { requireSession } from '@/lib/server-guards';

export default async function ComputerRootPage() {
  const session = await requireSession();
  redirect(`/computer/${session.org_id}`);
}
