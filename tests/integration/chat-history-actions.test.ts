/**
 * Integration tests for chat history actions.
 *
 * Run with: npm run test:integration
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { serverFetch, signupUser } from './test-utils';

async function createThread(sessionCookie: string, title: string) {
  const response = await serverFetch('/api/threads', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: sessionCookie,
    },
    body: JSON.stringify({ title }),
  });

  expect(response.ok).toBe(true);
  return response.json() as Promise<{ id: string; title: string }>;
}

async function renameThread(sessionCookie: string, id: string, title: string) {
  const response = await serverFetch(`/api/threads/${id}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Cookie: sessionCookie,
    },
    body: JSON.stringify({ title }),
  });

  expect(response.ok).toBe(true);
  return response.json() as Promise<{ id: string; title: string }>;
}

async function deleteThread(sessionCookie: string, id: string) {
  const response = await serverFetch(`/api/threads/${id}`, {
    method: 'DELETE',
    headers: { Cookie: sessionCookie },
  });
  expect(response.ok).toBe(true);
}

async function fetchThread(sessionCookie: string, id: string): Promise<Response> {
  return serverFetch(`/api/threads/${id}`, {
    headers: { Cookie: sessionCookie },
  });
}

describe('Chat History Actions Integration', () => {
  let sessionCookie = '';

  beforeAll(async () => {
    const session = await signupUser({ name: 'History Test' });
    sessionCookie = session.sessionCookie;
  });

  it('renames a chat thread', async () => {
    const thread = await createThread(sessionCookie, 'Original Title');
    const updated = await renameThread(sessionCookie, thread.id, 'Renamed Title');

    expect(updated.title).toBe('Renamed Title');

    const getResponse = await fetchThread(sessionCookie, thread.id);
    expect(getResponse.ok).toBe(true);
    const fetched = await getResponse.json() as { id: string; title: string };
    expect(fetched.title).toBe('Renamed Title');
  });

  it('deletes a chat thread', async () => {
    const thread = await createThread(sessionCookie, 'Delete Me');
    await deleteThread(sessionCookie, thread.id);

    const getResponse = await fetchThread(sessionCookie, thread.id);
    expect(getResponse.status).toBe(404);
  });

  it('deletes multiple chat threads', async () => {
    const threads = await Promise.all([
      createThread(sessionCookie, 'Bulk One'),
      createThread(sessionCookie, 'Bulk Two'),
      createThread(sessionCookie, 'Bulk Three'),
    ]);

    await Promise.all(
      threads.map((thread) => deleteThread(sessionCookie, thread.id))
    );

    const responses = await Promise.all(
      threads.map((thread) => fetchThread(sessionCookie, thread.id))
    );

    for (const response of responses) {
      expect(response.status).toBe(404);
    }
  });
});
