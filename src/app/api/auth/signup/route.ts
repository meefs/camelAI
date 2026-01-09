import { NextRequest } from 'next/server';
import { signup } from '@/lib/server-actions/auth';
import { errorResponse, jsonResponse } from '@/lib/auth';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { email?: string; password?: string; name?: string };
    const result = await signup(body.email ?? '', body.password ?? '', body.name);

    if (!result.success) {
      return errorResponse(result.error, 400);
    }

    return jsonResponse(result.data);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Signup failed';
    return errorResponse(message, 500);
  }
}
