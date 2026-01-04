import { NextResponse } from 'next/server';
import { getSessionContext, getUserByIdCached } from '@/lib/auth-context';

export async function requireSuperuser(): Promise<
  | { authorized: true; userId: string }
  | { authorized: false; response: NextResponse }
> {
  const sessionContext = await getSessionContext();
  if (!sessionContext) {
    return {
      authorized: false,
      response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    };
  }

  const user = await getUserByIdCached(sessionContext.session.user_id);
  if (!user) {
    return {
      authorized: false,
      response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    };
  }

  if (!user.is_superuser) {
    return {
      authorized: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    };
  }

  return { authorized: true, userId: user.id };
}
