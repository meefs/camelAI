"use server";

import * as authDO from "@/lib/auth-do";
import * as computerDO from "@/lib/computer-do";
import { requireSession } from "@/lib/server-guards";
import type { WorkspaceListResponse, WorkspaceFileRead } from "@/types";

async function requireWorkspaceAccess(workspaceId: string, requireWrite = false) {
  const session = await requireSession();
  const workspace = await authDO.getWorkspace(workspaceId);
  if (!workspace || workspace.org_id !== session.org_id) {
    throw new Error("Workspace not found");
  }
  const access = await authDO.getWorkspaceAccess(workspaceId, session.user_id);
  if (access === "none") {
    throw new Error("Workspace not found");
  }
  if (requireWrite && access !== "full") {
    throw new Error("Write access denied");
  }
  return { session, workspace, access };
}

async function hashContent(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function listWorkspaceFiles(
  workspaceId: string,
  options?: { path?: string; recursive?: boolean; includeHidden?: boolean }
): Promise<WorkspaceListResponse> {
  await requireWorkspaceAccess(workspaceId);
  return computerDO.listWorkspaceEntries(workspaceId, options);
}

export async function readWorkspaceFile(
  workspaceId: string,
  path: string
): Promise<WorkspaceFileRead | null> {
  await requireWorkspaceAccess(workspaceId);
  const readResult = await computerDO.readWorkspaceFile(workspaceId, path);
  if (!readResult) {
    return null;
  }

  const content = readResult.result.content ?? "";
  const version = await hashContent(content);

  // Try to get file metadata
  const parentPath = path === "/" ? "/" : path.split("/").slice(0, -1).join("/") || "/";
  let entry: { size: number; modifiedAt: string } | null = null;
  try {
    const listing = await computerDO.listWorkspaceEntries(workspaceId, {
      path: parentPath,
      recursive: false,
      includeHidden: true,
    });
    entry = listing.entries.find((item) => item.path === path) ?? null;
  } catch {
    // Ignore listing errors
  }

  const encoding = readResult.result.encoding ?? "utf-8";
  return {
    path,
    content,
    version,
    size: readResult.result.size ?? entry?.size ?? null,
    mtime: entry?.modifiedAt ?? null,
    isBinary: Boolean(readResult.result.isBinary),
    encoding: encoding as "utf-8" | "base64",
    mimeType: readResult.result.mimeType ?? null,
  };
}

export async function writeWorkspaceFile(
  workspaceId: string,
  path: string,
  content: string
): Promise<{ success: boolean; error?: string }> {
  await requireWorkspaceAccess(workspaceId, true);
  const result = await computerDO.writeWorkspaceFile(workspaceId, path, content);
  return { success: result?.result?.success ?? false, error: result?.result?.error };
}

export async function createWorkspaceFile(
  workspaceId: string,
  path: string,
  content?: string
): Promise<{ success: boolean; error?: string }> {
  await requireWorkspaceAccess(workspaceId, true);
  const result = await computerDO.createWorkspaceFile(workspaceId, path, content);
  return { success: result?.result?.success ?? false, error: result?.result?.error };
}

export async function mkdirWorkspacePath(
  workspaceId: string,
  path: string
): Promise<{ success: boolean; error?: string }> {
  await requireWorkspaceAccess(workspaceId, true);
  const result = await computerDO.mkdirWorkspacePath(workspaceId, path);
  return { success: result?.result?.success ?? false, error: result?.result?.error };
}

export async function moveWorkspacePath(
  workspaceId: string,
  from: string,
  to: string
): Promise<{ success: boolean; error?: string }> {
  await requireWorkspaceAccess(workspaceId, true);
  const result = await computerDO.moveWorkspacePath(workspaceId, from, to);
  return { success: result?.result?.success ?? false, error: result?.result?.error };
}

export async function deleteWorkspacePath(
  workspaceId: string,
  path: string
): Promise<{ success: boolean; error?: string }> {
  await requireWorkspaceAccess(workspaceId, true);
  const result = await computerDO.deleteWorkspacePath(workspaceId, path);
  return { success: result?.result?.success ?? false, error: result?.result?.error };
}

export async function resetWorkspaceContainer(
  workspaceId: string
): Promise<{ success: boolean }> {
  await requireWorkspaceAccess(workspaceId, true);
  await computerDO.resetSandboxContainer(workspaceId);
  return { success: true };
}
