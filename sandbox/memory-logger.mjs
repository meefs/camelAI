/**
 * Episodic Memory - Utility Functions
 *
 * The actual memory logging is done by the memory-logger subagent (defined in ws-server.mjs).
 * This module provides utilities for loading memory context at session start.
 *
 * Memory is stored in ~/.chiridion/memory/YYYY-MM-DD.md
 */

import { mkdir, readFile, readdir } from 'fs/promises';

const SYNC_DIR = process.env.R2_MOUNT_DIR || '/home/claude';
export const MEMORY_DIR = `${SYNC_DIR}/.chiridion/memory`;

// Ensure memory directory exists
let memoryDirPromise = null;
export function ensureMemoryDir() {
  if (!memoryDirPromise) {
    memoryDirPromise = mkdir(MEMORY_DIR, { recursive: true }).catch((err) => {
      console.error('[memory] Failed to create memory dir:', err?.message || String(err));
    });
  }
  return memoryDirPromise;
}

/**
 * Load recent memory for session context
 *
 * Reads the last N days of memory and returns the content.
 * Call this at session start to provide context to the agent.
 *
 * @param {number} daysBack - Number of days to look back (default: 3)
 * @returns {Promise<string|null>} Memory content or null if no memory exists
 */
export async function loadRecentMemory(daysBack = 3) {
  try {
    await ensureMemoryDir();

    // Get list of memory files
    const files = await readdir(MEMORY_DIR).catch(() => []);
    if (files.length === 0) return null;

    // Sort by date descending
    const mdFiles = files
      .filter(f => f.endsWith('.md'))
      .sort()
      .reverse()
      .slice(0, daysBack);

    if (mdFiles.length === 0) return null;

    // Read and combine
    const memories = [];
    for (const file of mdFiles) {
      try {
        const content = await readFile(`${MEMORY_DIR}/${file}`, 'utf-8');
        const date = file.replace('.md', '');
        memories.push(`# ${date}\n${content}`);
      } catch {
        // Skip unreadable files
      }
    }

    if (memories.length === 0) return null;

    console.log('[memory] Loaded recent memory', { days: memories.length, files: mdFiles });
    return memories.join('\n\n---\n\n');
  } catch (error) {
    console.error('[memory] Failed to load memory:', error?.message || String(error));
    return null;
  }
}

/**
 * Get memory context formatted for system prompt injection
 *
 * @param {number} daysBack - Number of days to look back
 * @param {number} maxLength - Maximum length before truncation
 * @returns {Promise<string|null>} Formatted memory context or null
 */
export async function getMemoryContext(daysBack = 3, maxLength = 3000) {
  const memory = await loadRecentMemory(daysBack);
  if (!memory) return null;

  // Truncate if too long
  if (memory.length > maxLength) {
    return memory.slice(0, maxLength) + '\n\n[...older entries truncated]';
  }

  return memory;
}
