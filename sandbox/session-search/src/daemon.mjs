#!/usr/bin/env node
/**
 * Session indexing daemon
 * Watches ~/.claude/projects/ for new/updated session files and indexes them
 */

import chokidar from 'chokidar';
import { createReadStream, statSync, existsSync } from 'fs';
import { createInterface } from 'readline';
import { join, basename, dirname } from 'path';
import { homedir } from 'os';
import {
  initDB,
  upsertSession,
  insertMessage,
  updateSessionIndexPos,
  getSessionIndexPos,
  closeDB,
} from './db.mjs';

const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects');
const POLL_INTERVAL = 5000; // 5 seconds

/**
 * Parse a JSONL file and index messages
 */
async function indexSessionFile(filePath) {
  if (!existsSync(filePath)) return;

  const sessionId = basename(filePath, '.jsonl');
  const projectPath = basename(dirname(filePath));

  // Get file stats
  const stats = statSync(filePath);
  const fileSize = stats.size;

  // Get last indexed position
  const lastPos = getSessionIndexPos(sessionId);

  // Skip if file hasn't grown
  if (lastPos >= fileSize) {
    return { sessionId, skipped: true, reason: 'no new content' };
  }

  // Read from last position
  let linesIndexed = 0;
  let metadata = {};
  const sessionsEnsured = new Set();

  return new Promise((resolve, reject) => {
    const stream = createReadStream(filePath, {
      start: lastPos,
      encoding: 'utf-8',
    });

    const rl = createInterface({
      input: stream,
      crlfDelay: Infinity,
    });

    rl.on('line', (line) => {
      if (!line.trim()) return;

      try {
        const entry = JSON.parse(line);

        // Extract session metadata from first message
        if (!metadata.cwd && entry.cwd) {
          metadata.cwd = entry.cwd;
          metadata.gitBranch = entry.gitBranch;
        }

        // Only index user/assistant/system/summary messages
        if (['user', 'assistant', 'system', 'summary'].includes(entry.type) && entry.uuid) {
          // Ensure the session exists (using sessionId from entry, not filename)
          const entrySessionId = entry.sessionId || sessionId;
          if (!sessionsEnsured.has(entrySessionId)) {
            upsertSession(projectPath, entrySessionId, {
              cwd: entry.cwd,
              gitBranch: entry.gitBranch,
            });
            sessionsEnsured.add(entrySessionId);
          }

          insertMessage(entry);
          linesIndexed++;
        }
      } catch (err) {
        // Skip invalid JSON lines silently
      }
    });

    rl.on('close', () => {
      // Update session with file info (use filename-based sessionId for tracking indexed position)
      upsertSession(projectPath, sessionId, {
        ...metadata,
        filePath,
        fileSize,
      });

      // Update indexed position for this file
      updateSessionIndexPos(sessionId, fileSize);

      resolve({
        sessionId,
        linesIndexed,
        fileSize,
        fromPos: lastPos,
      });
    });

    rl.on('error', reject);
  });
}

/**
 * Index all session files in a project directory
 */
async function indexProject(projectDir) {
  const { readdirSync, statSync } = await import('fs');

  try {
    const files = readdirSync(projectDir);

    for (const file of files) {
      const filePath = join(projectDir, file);

      try {
        const stats = statSync(filePath);

        if (stats.isFile() && file.endsWith('.jsonl')) {
          // Main session file
          const result = await indexSessionFile(filePath);
          if (result && !result.skipped && result.linesIndexed > 0) {
            console.log(`[indexer] Indexed ${result.linesIndexed} messages from ${result.sessionId}`);
          }
        } else if (stats.isDirectory()) {
          // Check for subagent files in subdirectory
          const subFiles = readdirSync(filePath);
          for (const subFile of subFiles) {
            if (subFile.endsWith('.jsonl')) {
              const subFilePath = join(filePath, subFile);
              const result = await indexSessionFile(subFilePath);
              if (result && !result.skipped && result.linesIndexed > 0) {
                console.log(`[indexer] Indexed ${result.linesIndexed} messages from ${result.sessionId}`);
              }
            }
            // Also check subagents subdirectory
            if (subFile === 'subagents') {
              const subagentsDir = join(filePath, subFile);
              const agentFiles = readdirSync(subagentsDir);
              for (const agentFile of agentFiles) {
                if (agentFile.endsWith('.jsonl')) {
                  const agentFilePath = join(subagentsDir, agentFile);
                  const result = await indexSessionFile(agentFilePath);
                  if (result && !result.skipped && result.linesIndexed > 0) {
                    console.log(`[indexer] Indexed ${result.linesIndexed} messages from ${result.sessionId}`);
                  }
                }
              }
            }
          }
        }
      } catch (err) {
        // Skip files we can't read
      }
    }
  } catch (err) {
    console.error(`[indexer] Error reading project dir:`, err.message);
  }
}

/**
 * Initial full index of all projects
 */
async function fullIndex() {
  const { readdirSync } = await import('fs');

  console.log('[indexer] Starting full index...');
  const startTime = Date.now();

  try {
    const projects = readdirSync(CLAUDE_PROJECTS_DIR);

    for (const project of projects) {
      if (project.startsWith('.')) continue;

      const projectDir = join(CLAUDE_PROJECTS_DIR, project);
      try {
        const stats = statSync(projectDir);
        if (stats.isDirectory()) {
          await indexProject(projectDir);
        }
      } catch (err) {
        // Skip non-directories
      }
    }
  } catch (err) {
    console.error('[indexer] Error during full index:', err.message);
  }

  console.log(`[indexer] Full index complete in ${Date.now() - startTime}ms`);
}

/**
 * Start watching for changes
 */
function startWatcher() {
  console.log(`[indexer] Watching ${CLAUDE_PROJECTS_DIR}`);

  const watcher = chokidar.watch(`${CLAUDE_PROJECTS_DIR}/**/*.jsonl`, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 1000,
      pollInterval: 100,
    },
  });

  watcher.on('add', async (filePath) => {
    console.log(`[indexer] New file: ${basename(filePath)}`);
    try {
      const result = await indexSessionFile(filePath);
      if (result && result.linesIndexed > 0) {
        console.log(`[indexer] Indexed ${result.linesIndexed} messages`);
      }
    } catch (err) {
      console.error(`[indexer] Error:`, err.message);
    }
  });

  watcher.on('change', async (filePath) => {
    try {
      const result = await indexSessionFile(filePath);
      if (result && !result.skipped && result.linesIndexed > 0) {
        console.log(`[indexer] Updated ${basename(filePath)}: +${result.linesIndexed} messages`);
      }
    } catch (err) {
      console.error(`[indexer] Error:`, err.message);
    }
  });

  return watcher;
}

/**
 * Main daemon entry point
 */
async function main() {
  console.log('[indexer] Session search daemon starting...');

  // Initialize database
  initDB();

  // Do initial full index
  await fullIndex();

  // Start watching for changes
  const watcher = startWatcher();

  // Handle shutdown
  process.on('SIGINT', () => {
    console.log('\n[indexer] Shutting down...');
    watcher.close();
    closeDB();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.log('\n[indexer] Shutting down...');
    watcher.close();
    closeDB();
    process.exit(0);
  });

  // Keep process alive
  console.log('[indexer] Daemon running. Press Ctrl+C to stop.');
}

main().catch((err) => {
  console.error('[indexer] Fatal error:', err);
  process.exit(1);
});
