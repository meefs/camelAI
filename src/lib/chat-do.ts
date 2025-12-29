import { getCloudflareContext } from '@opennextjs/cloudflare';
import type { Thread, Message, Project } from '@/types';
import type { DoRpcService } from '../../workers/main/src/rpc-service';

interface Env {
  DO_RPC: DoRpcService;
}

async function getRpc(): Promise<DoRpcService> {
  const { env } = getCloudflareContext() as unknown as { env: Env };
  return env.DO_RPC;
}

export async function getThreads(org = 'default'): Promise<Thread[]> {
  const rpc = await getRpc();
  return rpc.getThreads(org);
}

export async function createThread(
  org = 'default',
  title: string | undefined,
  projectId: string,
  createdBy?: string
): Promise<Thread> {
  const rpc = await getRpc();
  return rpc.createThread(org, title, projectId, createdBy);
}

export async function getThread(id: string, org = 'default'): Promise<Thread | null> {
  const rpc = await getRpc();
  return rpc.getThread(id, org);
}

export async function updateThread(id: string, title: string, org = 'default'): Promise<Thread | null> {
  const rpc = await getRpc();
  return rpc.updateThread(id, title, org);
}

export async function deleteThread(id: string, org = 'default'): Promise<void> {
  const rpc = await getRpc();
  await rpc.deleteThread(id, org);
}

export async function getMessages(threadId: string): Promise<Message[]> {
  const rpc = await getRpc();
  return rpc.getMessages(threadId);
}

export async function addMessage(threadId: string, role: string, content: string, org = 'default'): Promise<Message> {
  const rpc = await getRpc();
  return rpc.addMessage(threadId, role, content, org);
}

export async function getProjects(org = 'default'): Promise<Project[]> {
  const rpc = await getRpc();
  return rpc.getProjects(org);
}

export async function getProjectsByUser(org = 'default', userId: string): Promise<Project[]> {
  const rpc = await getRpc();
  return rpc.getProjectsByUser(org, userId);
}

export async function createProject(org = 'default', name?: string, createdBy?: string): Promise<Project> {
  const rpc = await getRpc();
  return rpc.createProject(org, name, createdBy);
}

export async function getProject(id: string, org = 'default'): Promise<Project | null> {
  const rpc = await getRpc();
  return rpc.getProject(id, org);
}

export async function updateProject(id: string, name: string, org = 'default'): Promise<Project | null> {
  const rpc = await getRpc();
  return rpc.updateProject(id, name, org);
}

export async function deleteProject(id: string, org = 'default'): Promise<void> {
  const rpc = await getRpc();
  await rpc.deleteProject(id, org);
}
