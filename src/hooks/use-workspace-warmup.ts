'use client';

import { useCallback, useRef, useEffect } from 'react';
import { warmupWorkspace as warmupAction } from '@/lib/server-actions/workspace';

type WarmupStatus = 'idle' | 'warming' | 'warm' | 'error';

// Cache of workspaces that have been warmed up in this session
// This prevents redundant warmup calls for the same workspace
const warmedWorkspaces = new Set<string>();

// In-flight warmup requests to prevent duplicate calls
const pendingWarmups = new Map<string, Promise<WarmupStatus>>();

/**
 * Trigger a workspace warmup request.
 * This is a fire-and-forget call that returns immediately.
 * Deduplicates requests for the same workspace.
 */
async function triggerWarmup(workspaceId: string): Promise<WarmupStatus> {
  // Skip if already warmed in this session
  if (warmedWorkspaces.has(workspaceId)) {
    return 'warm';
  }

  // Return pending promise if request is in flight
  const pending = pendingWarmups.get(workspaceId);
  if (pending) {
    return pending;
  }

  // Create new warmup request
  const warmupPromise = (async (): Promise<WarmupStatus> => {
    try {
      const result = await warmupAction(workspaceId);

      // Mark as warmed if container is now starting or already warm
      if (result.status === 'warm' || result.status === 'warming') {
        warmedWorkspaces.add(workspaceId);
      }

      return result.status === 'warm' ? 'warm' : 'warming';
    } catch (err) {
      console.warn('[warmup] Error:', err);
      return 'error';
    } finally {
      pendingWarmups.delete(workspaceId);
    }
  })();

  pendingWarmups.set(workspaceId, warmupPromise);
  return warmupPromise;
}

/**
 * Hook to trigger async workspace warmup.
 *
 * Usage:
 * ```tsx
 * const warmup = useWorkspaceWarmup();
 *
 * // Trigger warmup on mount or when workspace changes
 * useEffect(() => {
 *   if (workspaceId) {
 *     warmup(workspaceId);
 *   }
 * }, [workspaceId, warmup]);
 * ```
 *
 * The hook automatically deduplicates requests - calling warmup multiple times
 * for the same workspace will only trigger one request.
 */
export function useWorkspaceWarmup() {
  return useCallback((workspaceId: string) => {
    if (!workspaceId) return;

    // Fire and forget - don't await
    void triggerWarmup(workspaceId);
  }, []);
}

/**
 * Hook that automatically warms up a workspace when the ID changes.
 * Use this for automatic warmup on page/component mount.
 *
 * Usage:
 * ```tsx
 * // Warms up when workspaceId changes
 * useAutoWarmup(currentWorkspace?.id);
 * ```
 */
export function useAutoWarmup(workspaceId: string | null | undefined) {
  const lastWarmedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!workspaceId) return;

    // Only warm up if workspace changed
    if (lastWarmedRef.current === workspaceId) return;
    lastWarmedRef.current = workspaceId;

    // Fire and forget
    void triggerWarmup(workspaceId);
  }, [workspaceId]);
}

/**
 * Clear the warmup cache. Useful for testing or when user logs out.
 */
export function clearWarmupCache() {
  warmedWorkspaces.clear();
  pendingWarmups.clear();
}
