// Stub file - server actions not yet converted to API routes
// TODO: Convert to API routes

import type { User } from '@/types';

export async function updateUserProfile(
  _updates: { name?: string | null; avatar?: { color: string; content: string } }
): Promise<User> {
  throw new Error('updateUserProfile not yet implemented - requires API route');
}
