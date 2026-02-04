#!/usr/bin/env node
/**
 * Session search CLI
 * Search and query indexed Claude sessions
 */

import { program } from 'commander';
import { readdirSync, statSync, existsSync, createReadStream } from 'fs';
import { createInterface } from 'readline';
import { join, basename, dirname } from 'path';
import { homedir } from 'os';
import {
  initDB,
  searchMessages,
  listSessions,
  getSessionMessages,
  getStats,
  closeDB,
  upsertSession,
  insertMessage,
  updateSessionIndexPos,
  getSessionIndexPos,
} from './db.mjs';

// Initialize DB on startup
initDB();

const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects');

/**
 * Index a single session file
 */
async function indexSessionFile(filePath) {
  if (!existsSync(filePath)) return null;

  const sessionId = basename(filePath, '.jsonl');
  const projectPath = basename(dirname(filePath));
  const stats = statSync(filePath);
  const fileSize = stats.size;
  const lastPos = getSessionIndexPos(sessionId);

  if (lastPos >= fileSize) {
    return { sessionId, skipped: true };
  }

  let linesIndexed = 0;
  let metadata = {};
  const sessionsEnsured = new Set();

  return new Promise((resolve) => {
    const stream = createReadStream(filePath, { start: lastPos, encoding: 'utf-8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const entry = JSON.parse(line);
        if (!metadata.cwd && entry.cwd) {
          metadata.cwd = entry.cwd;
          metadata.gitBranch = entry.gitBranch;
        }
        if (['user', 'assistant', 'system', 'summary'].includes(entry.type) && entry.uuid) {
          const entrySessionId = entry.sessionId || sessionId;
          if (!sessionsEnsured.has(entrySessionId)) {
            upsertSession(projectPath, entrySessionId, { cwd: entry.cwd, gitBranch: entry.gitBranch });
            sessionsEnsured.add(entrySessionId);
          }
          insertMessage(entry);
          linesIndexed++;
        }
      } catch (err) {
        // Skip invalid JSON
      }
    });

    rl.on('close', () => {
      upsertSession(projectPath, sessionId, { ...metadata, filePath, fileSize });
      updateSessionIndexPos(sessionId, fileSize);
      resolve({ sessionId, linesIndexed, fileSize });
    });
  });
}

/**
 * Index all session files in a project directory
 */
async function indexProject(projectDir) {
  const files = readdirSync(projectDir);
  let totalIndexed = 0;

  for (const file of files) {
    const filePath = join(projectDir, file);
    try {
      const stats = statSync(filePath);
      if (stats.isFile() && file.endsWith('.jsonl')) {
        const result = await indexSessionFile(filePath);
        if (result && !result.skipped) totalIndexed += result.linesIndexed;
      } else if (stats.isDirectory()) {
        const subFiles = readdirSync(filePath);
        for (const subFile of subFiles) {
          if (subFile.endsWith('.jsonl')) {
            const result = await indexSessionFile(join(filePath, subFile));
            if (result && !result.skipped) totalIndexed += result.linesIndexed;
          }
          if (subFile === 'subagents') {
            const agentFiles = readdirSync(join(filePath, subFile));
            for (const agentFile of agentFiles) {
              if (agentFile.endsWith('.jsonl')) {
                const result = await indexSessionFile(join(filePath, subFile, agentFile));
                if (result && !result.skipped) totalIndexed += result.linesIndexed;
              }
            }
          }
        }
      }
    } catch (err) {
      // Skip unreadable files
    }
  }
  return totalIndexed;
}

/**
 * Format timestamp for display
 */
function formatTime(timestamp) {
  if (!timestamp) return 'N/A';
  const d = new Date(timestamp);
  return d.toLocaleString();
}

/**
 * Truncate text for display
 */
function truncate(text, maxLen = 100) {
  if (!text) return '';
  const clean = text.replace(/\n/g, ' ').trim();
  return clean.length > maxLen ? clean.slice(0, maxLen) + '...' : clean;
}

program
  .name('session-search')
  .description('Search and query Claude session history')
  .version('1.0.0');

// List sessions
program
  .command('list')
  .alias('ls')
  .description('List all indexed sessions')
  .option('-l, --limit <n>', 'Max sessions to show', '20')
  .option('-p, --project <name>', 'Filter by project name')
  .action((options) => {
    const sessions = listSessions({
      limit: parseInt(options.limit),
      projectPath: options.project,
    });

    if (sessions.length === 0) {
      console.log('No sessions found. Run the daemon first: npm run daemon');
      return;
    }

    console.log(`\nFound ${sessions.length} sessions:\n`);
    console.log('SESSION ID                            | MESSAGES | LAST ACTIVE          | PROJECT');
    console.log('-'.repeat(100));

    for (const s of sessions) {
      const id = s.session_id.slice(0, 36);
      const msgs = String(s.message_count || 0).padStart(8);
      const lastActive = formatTime(s.last_message_at).padEnd(20);
      const project = truncate(s.project_path, 30);
      console.log(`${id} | ${msgs} | ${lastActive} | ${project}`);
    }
    console.log();
  });

// Search messages
program
  .command('search <query>')
  .alias('s')
  .description('Full-text search across all sessions')
  .option('-s, --session <id>', 'Search within a specific session')
  .option('-t, --type <type>', 'Filter by message type (user, assistant)')
  .option('-r, --role <role>', 'Filter by role (user, assistant)')
  .option('-l, --limit <n>', 'Max results', '20')
  .option('--full', 'Show full content instead of snippets')
  .action((query, options) => {
    const results = searchMessages(query, {
      sessionId: options.session,
      type: options.type,
      role: options.role,
      limit: parseInt(options.limit),
    });

    if (results.length === 0) {
      console.log('No results found.');
      return;
    }

    console.log(`\nFound ${results.length} results for "${query}":\n`);

    for (const r of results) {
      const time = formatTime(r.timestamp);
      const role = (r.role || r.type || '').toUpperCase().padEnd(10);
      const session = r.session_id.slice(0, 8);

      console.log(`[${time}] ${role} (session: ${session}...)`);

      if (options.full) {
        console.log(r.content);
      } else {
        // Show snippet with highlights
        const snippet = r.snippet || truncate(r.content, 200);
        console.log(`  ${snippet.replace(/>>>/g, '\x1b[33m').replace(/<<</g, '\x1b[0m')}`);
      }
      console.log();
    }
  });

// Show session messages
program
  .command('show <session-id>')
  .description('Show messages from a specific session')
  .option('-l, --limit <n>', 'Max messages', '50')
  .option('-o, --offset <n>', 'Offset for pagination', '0')
  .option('-t, --type <type>', 'Filter by type')
  .option('--full', 'Show full content')
  .action((sessionId, options) => {
    const messages = getSessionMessages(sessionId, {
      limit: parseInt(options.limit),
      offset: parseInt(options.offset),
      type: options.type,
    });

    if (messages.length === 0) {
      console.log('No messages found for this session.');
      return;
    }

    console.log(`\nSession: ${sessionId}\nMessages: ${messages.length}\n`);

    for (const m of messages) {
      const time = formatTime(m.timestamp);
      const role = (m.role || m.type || '').toUpperCase();

      console.log(`--- ${time} [${role}] ---`);
      if (options.full) {
        console.log(m.content);
      } else {
        console.log(truncate(m.content, 300));
      }
      console.log();
    }
  });

// Show stats
program
  .command('stats')
  .description('Show database statistics')
  .action(() => {
    const stats = getStats();

    console.log('\n=== Session Search Stats ===\n');
    console.log(`Total Sessions: ${stats.totalSessions}`);
    console.log(`Total Messages: ${stats.totalMessages}`);
    console.log('\nMessages by Type:');
    for (const [type, count] of Object.entries(stats.messagesByType)) {
      console.log(`  ${type}: ${count}`);
    }
    console.log('\nMessages by Role:');
    for (const [role, count] of Object.entries(stats.messagesByRole)) {
      console.log(`  ${role}: ${count}`);
    }
    console.log();
  });

// Index sessions (one-time)
program
  .command('index')
  .description('Index all session files (run before searching)')
  .option('-q, --quiet', 'Suppress progress output')
  .action(async (options) => {
    if (!existsSync(CLAUDE_PROJECTS_DIR)) {
      console.log('No Claude projects directory found at', CLAUDE_PROJECTS_DIR);
      return;
    }

    const startTime = Date.now();
    if (!options.quiet) console.log('Indexing sessions from', CLAUDE_PROJECTS_DIR);

    let totalIndexed = 0;
    const projects = readdirSync(CLAUDE_PROJECTS_DIR);

    for (const project of projects) {
      if (project.startsWith('.')) continue;
      const projectDir = join(CLAUDE_PROJECTS_DIR, project);
      try {
        const stats = statSync(projectDir);
        if (stats.isDirectory()) {
          const count = await indexProject(projectDir);
          totalIndexed += count;
          if (!options.quiet && count > 0) {
            console.log(`  ${project}: ${count} messages`);
          }
        }
      } catch (err) {
        // Skip non-directories
      }
    }

    const elapsed = Date.now() - startTime;
    if (!options.quiet) {
      console.log(`\nIndexed ${totalIndexed} new messages in ${elapsed}ms`);
      const stats = getStats();
      console.log(`Total: ${stats.totalMessages} messages across ${stats.totalSessions} sessions`);
    }
  });

// Parse and execute
program.parseAsync();

// Cleanup on exit
process.on('exit', () => {
  closeDB();
});
