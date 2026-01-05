import { getAuthState } from '@/lib/server-actions/auth';
import { jsonResponse, unauthorizedResponse } from '@/lib/auth';

export async function GET() {
  const auth = await getAuthState();
  if (!auth) {
    return unauthorizedResponse();
  }
  return jsonResponse(auth);
}
