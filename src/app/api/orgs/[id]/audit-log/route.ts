import { NextRequest } from 'next/server';
import * as authDO from '@/lib/auth-do';
import {
  errorResponse,
  forbiddenResponse,
  getSessionId,
  jsonResponse,
  unauthorizedResponse,
} from '@/lib/auth';

interface RouteParams {
  params: Promise<{ id: string }>;
}

function parseNumber(value: string | null, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (Number.isNaN(parsed) || parsed < 0) return fallback;
  return parsed;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const sessionId = await getSessionId();
    if (!sessionId) {
      return unauthorizedResponse();
    }

    const session = await authDO.getSession(sessionId);
    if (!session) {
      return unauthorizedResponse();
    }

    if (session.org_id !== id) {
      return forbiddenResponse('Organization mismatch');
    }

    const isAdmin = await authDO.isOrgAdmin(session.user_id, id);
    if (!isAdmin) {
      return forbiddenResponse('Only admins can view audit logs');
    }

    const limit = parseNumber(request.nextUrl.searchParams.get('limit'), 100);
    const offset = parseNumber(request.nextUrl.searchParams.get('offset'), 0);
    const log = await authDO.getOrgAuditLog(id, limit, offset);
    return jsonResponse(log);
  } catch (error) {
    console.error('Error fetching org audit log:', error);
    return errorResponse('Failed to fetch audit log', 500);
  }
}
