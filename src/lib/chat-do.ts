import { getCloudflareContext } from '@opennextjs/cloudflare';
import type { Thread, Message } from '@/types';
import type { ChatIndexDO, ChatThreadDO } from '../../worker/durable-objects';

interface Env {
  CHAT_THREAD: DurableObjectNamespace<ChatThreadDO>;
  CHAT_INDEX: DurableObjectNamespace<ChatIndexDO>;
}

async function getEnv(): Promise<Env> {
  const { env } = await getCloudflareContext() as unknown as { env: Env };
  return env;
}

function getIndexStub(env: Env, org: string) {
  return env.CHAT_INDEX.get(env.CHAT_INDEX.idFromName(org));
}

function getThreadStub(env: Env, threadId: string) {
  return env.CHAT_THREAD.get(env.CHAT_THREAD.idFromName(threadId));
}

export async function getThreads(org = 'default'): Promise<Thread[]> {
  const env = await getEnv();
  return getIndexStub(env, org).getThreads();
}

export async function createThread(org = 'default', title?: string): Promise<Thread> {
  const env = await getEnv();
  return getIndexStub(env, org).createThread(title);
}

export async function getThread(id: string, org = 'default'): Promise<Thread | null> {
  const env = await getEnv();
  return getIndexStub(env, org).getThread(id);
}

export async function updateThread(id: string, title: string, org = 'default'): Promise<Thread | null> {
  const env = await getEnv();
  return getIndexStub(env, org).updateThread(id, title);
}

export async function deleteThread(id: string, org = 'default'): Promise<void> {
  const env = await getEnv();
  // Delete messages from thread DO
  await getThreadStub(env, id).deleteAllMessages();
  // Delete from index
  await getIndexStub(env, org).deleteThread(id);
}

export async function getMessages(threadId: string): Promise<Message[]> {
  const env = await getEnv();
  return getThreadStub(env, threadId).getMessages();
}

export async function addMessage(threadId: string, role: string, content: string, org = 'default'): Promise<Message> {
  const env = await getEnv();
  const msg = await getThreadStub(env, threadId).addMessage(role, content);
  // Update thread timestamp in index
  await getIndexStub(env, org).touchThread(threadId);
  return msg;
}
