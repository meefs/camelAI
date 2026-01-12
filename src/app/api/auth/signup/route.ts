import { NextRequest } from 'next/server';
import { signup } from '@/lib/server-actions/auth';
import { errorResponse, jsonResponse } from '@/lib/auth';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { email?: string; password?: string; name?: string };
    const data = await signup(body.email ?? '', body.password ?? '', body.name);
    return jsonResponse(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Signup failed';
    // Validation errors (invalid email, weak password, etc.) return 400
    // Unexpected errors would have generic message and return 500
    const isValidationError = message !== 'Signup failed' && !message.includes('unexpected');
    return errorResponse(message, isValidationError ? 400 : 500);
  }
}
