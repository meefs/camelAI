import { NextRequest } from 'next/server';
import { signup } from '@/lib/server-actions/auth';
import { errorResponse, jsonResponse } from '@/lib/auth';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { email?: string; password?: string; name?: string };
    const payload = await signup(body.email ?? '', body.password ?? '', body.name);
    return jsonResponse(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Signup failed';
    return errorResponse(message, 400);
  }
}
