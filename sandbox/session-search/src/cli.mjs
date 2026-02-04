#!/usr/bin/env node
/**
 * Session search CLI
 * Search and query indexed Claude sessions
 */

import { program } from 'commander';
import {
  initDB,
  searchMessages,
  listSessions,
  getSessionMessages,
  getStats,
  closeDB,
} from './db.mjs';

// Initialize DB on startup
initDB();

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

// Parse and execute
program.parse();

// Cleanup on exit
process.on('exit', () => {
  closeDB();
});
