/**
 * Test-only auth endpoint for integration tests.
 * Blocked by middleware in production (returns 404).
 */

import { NextRequest } from 'next/server';
import { signup, login, logout, getAuthState, switchWorkspace } from '@/lib/server-actions/auth';
import { errorResponse, jsonResponse, unauthorizedResponse } from '@/lib/auth';

/**
 * GET /api/test/auth - Get current auth state
 */
export async function GET() {
  const auth = await getAuthState();
  if (!auth) {
    return unauthorizedResponse();
  }
  return jsonResponse(auth);
}

/**
 * POST /api/test/auth - Signup, login, logout, or switch-workspace based on action field
 */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      action?: string;
      email?: string;
      password?: string;
      name?: string;
      workspace_id?: string | null;
    };

    const action = body.action ?? 'login';

    switch (action) {
      case 'signup': {
        const result = await signup(body.email ?? '', body.password ?? '', body.name);
        if (!result.success) {
          return errorResponse(result.error, 400);
        }
        return jsonResponse(result.data);
      }
      case 'login': {
        const result = await login(body.email ?? '', body.password ?? '');
        if (!result.success) {
          return errorResponse(result.error, 400);
        }
        return jsonResponse(result.data);
      }
      case 'logout': {
        await logout();
        return jsonResponse({ success: true });
      }
      case 'switch-workspace': {
        const workspace = await switchWorkspace(body.workspace_id ?? '');
        return jsonResponse({ workspace });
      }
      default:
        return errorResponse(`Invalid action: ${action}`, 400);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Auth operation failed';
    const isValidationError =
      message !== 'Auth operation failed' && !message.includes('unexpected');
    return errorResponse(message, isValidationError ? 400 : 500);
  }
}
