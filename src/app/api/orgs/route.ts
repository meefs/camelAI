import * as authDO from '@/lib/auth-do';
import {
  getSessionId,
  jsonResponse,
  errorResponse,
  unauthorizedResponse,
} from '@/lib/auth';

// GET /api/orgs - List user's organizations
export async function GET() {
  try {
    const sessionId = await getSessionId();
    if (!sessionId) {
      return unauthorizedResponse();
    }

    const session = await authDO.getSession(sessionId);
    if (!session) {
      return unauthorizedResponse();
    }

    const orgs = await authDO.getUserOrgs(session.user_id);
    return jsonResponse(orgs);
  } catch (error) {
    console.error('Error listing orgs:', error);
    return errorResponse('Failed to list organizations', 500);
  }
}
