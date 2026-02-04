/**
 * SQLite database for session search
 * Uses FTS5 for full-text search
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';

const DB_DIR = join(homedir(), '.chiridion');
const DB_PATH = join(DB_DIR, 'sessions.db');

let db = null;

// Strip ANSI escape codes from text (handles both real escapes and literal \x1b strings)
const ANSI_RE = /(?:\x1b|\u001b|\\x1b|\\u001b|\\033)\[[0-9;]*m/g;
function stripAnsi(text) {
  return text ? text.replace(ANSI_RE, '') : text;
}

/**
 * Initialize the database with schema
 */
export function initDB() {
  if (db) return db;

  // Ensure directory exists
  if (!existsSync(DB_DIR)) {
    mkdirSync(DB_DIR, { recursive: true });
  }

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  // Create sessions table
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_path TEXT NOT NULL,
      session_id TEXT NOT NULL UNIQUE,
      cwd TEXT,
      git_branch TEXT,
      created_at TEXT,
      updated_at TEXT,
      file_path TEXT,
      file_size INTEGER DEFAULT 0,
      last_indexed_pos INTEGER DEFAULT 0
    )
  `);

  // Create messages table
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      uuid TEXT NOT NULL UNIQUE,
      parent_uuid TEXT,
      type TEXT NOT NULL,
      role TEXT,
      content TEXT,
      model TEXT,
      timestamp TEXT,
      is_sidechain INTEGER DEFAULT 0,
      FOREIGN KEY (session_id) REFERENCES sessions(session_id)
    )
  `);

  // Create indexes
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
    CREATE INDEX IF NOT EXISTS idx_messages_type ON messages(type);
    CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
  `);

  // Create FTS5 virtual table for full-text search
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content,
      session_id UNINDEXED,
      uuid UNINDEXED,
      type UNINDEXED,
      role UNINDEXED,
      timestamp UNINDEXED,
      content='messages',
      content_rowid='id'
    )
  `);

  // Create triggers to keep FTS in sync
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content, session_id, uuid, type, role, timestamp)
      VALUES (new.id, new.content, new.session_id, new.uuid, new.type, new.role, new.timestamp);
    END;

    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content, session_id, uuid, type, role, timestamp)
      VALUES ('delete', old.id, old.content, old.session_id, old.uuid, old.type, old.role, old.timestamp);
    END;

    CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content, session_id, uuid, type, role, timestamp)
      VALUES ('delete', old.id, old.content, old.session_id, old.uuid, old.type, old.role, old.timestamp);
      INSERT INTO messages_fts(rowid, content, session_id, uuid, type, role, timestamp)
      VALUES (new.id, new.content, new.session_id, new.uuid, new.type, new.role, new.timestamp);
    END;
  `);

  return db;
}

/**
 * Get or create a session
 */
export function upsertSession(projectPath, sessionId, metadata = {}) {
  const db = initDB();
  const now = new Date().toISOString();

  const existing = db.prepare('SELECT id FROM sessions WHERE session_id = ?').get(sessionId);

  if (existing) {
    db.prepare(`
      UPDATE sessions
      SET updated_at = ?, cwd = COALESCE(?, cwd), git_branch = COALESCE(?, git_branch),
          file_path = COALESCE(?, file_path), file_size = COALESCE(?, file_size)
      WHERE session_id = ?
    `).run(now, metadata.cwd, metadata.gitBranch, metadata.filePath, metadata.fileSize, sessionId);
  } else {
    db.prepare(`
      INSERT INTO sessions (project_path, session_id, cwd, git_branch, created_at, updated_at, file_path, file_size, last_indexed_pos)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(projectPath, sessionId, metadata.cwd, metadata.gitBranch, now, now, metadata.filePath, metadata.fileSize || 0);
  }

  return sessionId;
}

/**
 * Insert a message (skip if uuid already exists)
 */
export function insertMessage(message) {
  const db = initDB();

  // Extract content from message, stripping ANSI codes
  let content = '';
  if (typeof message.message?.content === 'string') {
    content = stripAnsi(message.message.content);
  } else if (Array.isArray(message.message?.content)) {
    // Handle content blocks (text, thinking, tool_use, etc.)
    content = message.message.content
      .map(block => {
        if (block.type === 'text') return stripAnsi(block.text);
        if (block.type === 'thinking') return stripAnsi(block.thinking);
        if (block.type === 'tool_use') return `[Tool: ${block.name}] ${stripAnsi(JSON.stringify(block.input || {}).slice(0, 500))}`;
        if (block.type === 'tool_result') return `[Tool Result] ${typeof block.content === 'string' ? stripAnsi(block.content.slice(0, 500)) : ''}`;
        return '';
      })
      .filter(Boolean)
      .join('\n\n');
  }

  try {
    db.prepare(`
      INSERT OR IGNORE INTO messages (session_id, uuid, parent_uuid, type, role, content, model, timestamp, is_sidechain)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      message.sessionId,
      message.uuid,
      message.parentUuid || null,
      message.type,
      message.message?.role || null,
      content,
      message.message?.model || null,
      message.timestamp,
      message.isSidechain ? 1 : 0
    );
  } catch (err) {
    // Ignore duplicate key errors
    if (!err.message.includes('UNIQUE constraint')) {
      throw err;
    }
  }
}

/**
 * Update session's last indexed position
 */
export function updateSessionIndexPos(sessionId, position) {
  const db = initDB();
  db.prepare('UPDATE sessions SET last_indexed_pos = ? WHERE session_id = ?').run(position, sessionId);
}

/**
 * Get session's last indexed position
 */
export function getSessionIndexPos(sessionId) {
  const db = initDB();
  const row = db.prepare('SELECT last_indexed_pos FROM sessions WHERE session_id = ?').get(sessionId);
  return row?.last_indexed_pos || 0;
}

/**
 * Resolve a partial session ID to full session ID
 * Supports prefix matching (e.g., "68369296" matches "68369296-8fb0-4b32-...")
 */
export function resolveSessionId(partialId) {
  const db = initDB();

  // Try exact match first
  const exact = db.prepare('SELECT session_id FROM sessions WHERE session_id = ?').get(partialId);
  if (exact) return exact.session_id;

  // Try prefix match
  const prefix = db.prepare('SELECT session_id FROM sessions WHERE session_id LIKE ? LIMIT 2').all(`${partialId}%`);
  if (prefix.length === 1) return prefix[0].session_id;
  if (prefix.length > 1) return null; // Ambiguous

  return null; // Not found
}

/**
 * Full-text search across all sessions
 */
export function searchMessages(query, options = {}) {
  const db = initDB();
  let { sessionId, limit = 50, type, role, before, after } = options;

  // Resolve partial session ID
  if (sessionId) {
    const resolved = resolveSessionId(sessionId);
    if (!resolved) {
      return []; // Session not found
    }
    sessionId = resolved;
  }

  let sql = `
    SELECT m.*, s.project_path, s.cwd, s.git_branch,
           snippet(messages_fts, 0, '>>>', '<<<', '...', 64) as snippet,
           (SELECT COUNT(*) FROM messages m2 WHERE m2.session_id = m.session_id AND m2.timestamp <= m.timestamp) as msg_num
    FROM messages_fts
    JOIN messages m ON messages_fts.rowid = m.id
    JOIN sessions s ON m.session_id = s.session_id
    WHERE messages_fts MATCH ?
  `;

  const params = [query];

  if (sessionId) {
    sql += ' AND m.session_id = ?';
    params.push(sessionId);
  }

  if (before) {
    sql += ' AND m.timestamp < ?';
    params.push(before);
  }

  if (after) {
    sql += ' AND m.timestamp > ?';
    params.push(after);
  }

  if (type) {
    sql += ' AND m.type = ?';
    params.push(type);
  }

  if (role) {
    sql += ' AND m.role = ?';
    params.push(role);
  }

  sql += ' ORDER BY rank LIMIT ?';
  params.push(limit);

  return db.prepare(sql).all(...params);
}

/**
 * List all sessions
 */
export function listSessions(options = {}) {
  const db = initDB();
  const { limit = 50, projectPath } = options;

  let sql = `
    SELECT s.*,
           (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.session_id) as message_count,
           (SELECT MAX(timestamp) FROM messages m WHERE m.session_id = s.session_id) as last_message_at
    FROM sessions s
  `;

  const params = [];

  if (projectPath) {
    sql += ' WHERE s.project_path LIKE ?';
    params.push(`%${projectPath}%`);
  }

  sql += ' ORDER BY s.updated_at DESC LIMIT ?';
  params.push(limit);

  return db.prepare(sql).all(...params);
}

/**
 * Get messages from a specific session
 */
export function getSessionMessages(sessionIdInput, options = {}) {
  const db = initDB();
  const { limit = 100, offset = 0, type } = options;

  // Resolve partial session ID
  const sessionId = resolveSessionId(sessionIdInput);
  if (!sessionId) {
    return []; // Session not found
  }

  // Include message number (row_number within session)
  let sql = `
    SELECT m.*,
           (SELECT COUNT(*) FROM messages m2 WHERE m2.session_id = m.session_id AND m2.timestamp <= m.timestamp) as msg_num
    FROM messages m
    WHERE m.session_id = ?
  `;
  const params = [sessionId];

  if (type) {
    sql += ' AND m.type = ?';
    params.push(type);
  }

  sql += ' ORDER BY m.timestamp ASC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  return db.prepare(sql).all(...params);
}

/**
 * Get messages around a specific timestamp in a session
 */
export function getMessagesAround(sessionIdInput, timestamp, context = 5) {
  const db = initDB();

  const sessionId = resolveSessionId(sessionIdInput);
  if (!sessionId) return [];

  // Get messages before
  const before = db.prepare(`
    SELECT *, (SELECT COUNT(*) FROM messages m2 WHERE m2.session_id = ? AND m2.timestamp <= m.timestamp) as msg_num
    FROM messages m
    WHERE session_id = ? AND timestamp < ?
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(sessionId, sessionId, timestamp, context).reverse();

  // Get the target message
  const target = db.prepare(`
    SELECT *, (SELECT COUNT(*) FROM messages m2 WHERE m2.session_id = ? AND m2.timestamp <= m.timestamp) as msg_num
    FROM messages m
    WHERE session_id = ? AND timestamp = ?
  `).all(sessionId, sessionId, timestamp);

  // Get messages after
  const after = db.prepare(`
    SELECT *, (SELECT COUNT(*) FROM messages m2 WHERE m2.session_id = ? AND m2.timestamp <= m.timestamp) as msg_num
    FROM messages m
    WHERE session_id = ? AND timestamp > ?
    ORDER BY timestamp ASC
    LIMIT ?
  `).all(sessionId, sessionId, timestamp, context);

  return [...before, ...target, ...after];
}

/**
 * Get message number within its session
 */
export function getMessageNumber(sessionId, uuid) {
  const db = initDB();
  const row = db.prepare(`
    SELECT COUNT(*) as num FROM messages
    WHERE session_id = ? AND timestamp <= (SELECT timestamp FROM messages WHERE uuid = ?)
  `).get(sessionId, uuid);
  return row?.num || 0;
}

/**
 * Get database stats
 */
export function getStats() {
  const db = initDB();

  const sessions = db.prepare('SELECT COUNT(*) as count FROM sessions').get();
  const messages = db.prepare('SELECT COUNT(*) as count FROM messages').get();
  const byType = db.prepare('SELECT type, COUNT(*) as count FROM messages GROUP BY type').all();
  const byRole = db.prepare('SELECT role, COUNT(*) as count FROM messages WHERE role IS NOT NULL GROUP BY role').all();

  return {
    totalSessions: sessions.count,
    totalMessages: messages.count,
    messagesByType: Object.fromEntries(byType.map(r => [r.type, r.count])),
    messagesByRole: Object.fromEntries(byRole.map(r => [r.role, r.count])),
  };
}

/**
 * Close database connection
 */
export function closeDB() {
  if (db) {
    db.close();
    db = null;
  }
}
