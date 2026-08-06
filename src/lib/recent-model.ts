import { resolveStoredLlmModel } from "./llm-provider-config";
import type { LlmModel } from "../types";

const PREFIX = "camelai.recentModel";

export interface RecentModelScope {
  orgId: string;
  workspaceId: string;
}

interface RecentModelOptions {
  orgProvider?: string | null;
}

function keyFor(scope: RecentModelScope): string {
  return `${PREFIX}.${scope.orgId}.${scope.workspaceId}`;
}

function getStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function getRecentModel(
  scope: RecentModelScope,
  options?: RecentModelOptions,
): LlmModel | null {
  const storage = getStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(keyFor(scope));
    return resolveStoredLlmModel(raw, options?.orgProvider);
  } catch {
    return null;
  }
}

export function setRecentModel(
  scope: RecentModelScope,
  model: LlmModel,
): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(keyFor(scope), model);
  } catch {
    // Storage may be unavailable in private browsing or locked-down contexts.
  }
}
