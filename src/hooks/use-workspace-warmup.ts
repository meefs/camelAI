'use client';

// Cache of workspaces that have been warmed up in this session
// Used to track warmup state for debugging/logging
const warmedWorkspaces = new Set<string>();

/**
 * Clear the warmup cache. Called on logout to ensure
 * next login triggers fresh container warmup.
 */
export function clearWarmupCache() {
  warmedWorkspaces.clear();
}
