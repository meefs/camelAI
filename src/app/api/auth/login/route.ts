import { NextRequest } from 'next/server';
import { login } from '@/lib/server-actions/auth';
import { errorResponse, jsonResponse } from '@/lib/auth';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { email?: string; password?: string };
    const data = await login(body.email ?? '', body.password ?? '');
    return jsonResponse(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Login failed';
    // Validation errors (invalid email, wrong password) return 400
    // Unexpected errors would have generic message and return 500
    const isValidationError = message !== 'Login failed' && !message.includes('unexpected');
    return errorResponse(message, isValidationError ? 400 : 500);
  }
}
