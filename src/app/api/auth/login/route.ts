import { NextRequest } from 'next/server';
import { login } from '@/lib/server-actions/auth';
import { errorResponse, jsonResponse } from '@/lib/auth';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { email?: string; password?: string };
    const result = await login(body.email ?? '', body.password ?? '');

    if (!result.success) {
      return errorResponse(result.error, 400);
    }

    return jsonResponse(result.data);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Login failed';
    return errorResponse(message, 500);
  }
}
