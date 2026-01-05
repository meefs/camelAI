import { logout } from '@/lib/server-actions/auth';
import { errorResponse, jsonResponse } from '@/lib/auth';

export async function POST() {
  try {
    await logout();
    return jsonResponse({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Logout failed';
    return errorResponse(message, 500);
  }
}
