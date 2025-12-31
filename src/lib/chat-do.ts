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

export async function getThreads(org: string): Promise<Thread[]> {
  const rpc = await getRpc();
  return rpc.getThreads(org);
}

export async function createThread(
  org: string,
  title: string | undefined,
  projectId: string,
  createdBy?: string
): Promise<Thread> {
  const rpc = await getRpc();
  return rpc.createThread(org, title, projectId, createdBy);
}

export async function getThread(id: string, org: string): Promise<Thread | null> {
  const rpc = await getRpc();
  return rpc.getThread(id, org);
}

export async function updateThread(id: string, title: string, org: string): Promise<Thread | null> {
  const rpc = await getRpc();
  return rpc.updateThread(id, title, org);
}

export async function deleteThread(id: string, org: string): Promise<void> {
  const rpc = await getRpc();
  await rpc.deleteThread(id, org);
}

export async function getMessages(threadId: string): Promise<Message[]> {
  const rpc = await getRpc();
  return rpc.getMessages(threadId);
}

export async function addMessage(threadId: string, role: string, content: string, org: string): Promise<Message> {
  const rpc = await getRpc();
  return rpc.addMessage(threadId, role, content, org);
}

export async function getProjects(org: string): Promise<Project[]> {
  const rpc = await getRpc();
  return rpc.getProjects(org);
}

export async function getProjectsByUser(org: string, userId: string): Promise<Project[]> {
  const rpc = await getRpc();
  return rpc.getProjectsByUser(org, userId);
}

export async function createProject(org: string, name?: string, createdBy?: string): Promise<Project> {
  const rpc = await getRpc();
  return rpc.createProject(org, name, createdBy);
}

export async function getProject(id: string, org: string): Promise<Project | null> {
  const rpc = await getRpc();
  return rpc.getProject(id, org);
}

export async function updateProject(id: string, name: string, org: string): Promise<Project | null> {
  const rpc = await getRpc();
  return rpc.updateProject(id, name, org);
}

export async function deleteProject(id: string, org: string): Promise<void> {
  const rpc = await getRpc();
  await rpc.deleteProject(id, org);
}
