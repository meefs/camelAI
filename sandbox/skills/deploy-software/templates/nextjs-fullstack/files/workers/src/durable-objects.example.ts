import { DurableObject } from "cloudflare:workers";

/**
 * Example Durable Object with SQLite backend.
 *
 * Each DO instance has its own private SQLite database (up to 10GB).
 * Data persists across requests and survives hibernation.
 *
 * To enable this DO:
 * 1. Export it from index.ts: export { NotesDO } from "./durable-objects.js";
 * 2. Add to wrangler.jsonc durable_objects.bindings and migrations
 */

export interface Note {
  id: string;
  title: string;
  content: string;
  created_at: number;
  updated_at: number;
}

export interface NotesEnv {
  NOTES: DurableObjectNamespace<NotesDO>;
}

/**
 * NotesDO - A simple notes storage with SQLite backend.
 *
 * Usage pattern:
 *   const id = env.NOTES.idFromName("user-123"); // One DO per user
 *   const stub = env.NOTES.get(id);
 *   const notes = await stub.list();
 */
export class NotesDO extends DurableObject<NotesEnv> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: NotesEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;

    // Run migrations synchronously before handling requests
    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
    });
  }

  /**
   * Schema migrations - versioned and idempotent.
   * Each migration only runs once, tracked in _schema_version table.
   */
  private migrate() {
    // Create schema version table
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS _schema_version (
        version INTEGER PRIMARY KEY
      )
    `);

    const rows = this.sql
      .exec<{ version: number }>("SELECT version FROM _schema_version LIMIT 1")
      .toArray();
    const version = rows[0]?.version ?? 0;

    // Migration v1: Create notes table
    if (version < 1) {
      this.sql.exec(`
        CREATE TABLE notes (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          content TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      this.sql.exec("CREATE INDEX notes_updated_at ON notes(updated_at DESC)");
      this.sql.exec("INSERT INTO _schema_version (version) VALUES (1)");
    }

    // Add future migrations here:
    // if (version < 2) {
    //   this.sql.exec("ALTER TABLE notes ADD COLUMN archived INTEGER DEFAULT 0");
    //   this.sql.exec("UPDATE _schema_version SET version = 2");
    // }
  }

  /**
   * List all notes, ordered by most recently updated.
   */
  list(): Note[] {
    return this.sql
      .exec("SELECT * FROM notes ORDER BY updated_at DESC")
      .toArray() as unknown as Note[];
  }

  /**
   * Get a single note by ID.
   */
  get(id: string): Note | null {
    const rows = this.sql
      .exec("SELECT * FROM notes WHERE id = ?", id)
      .toArray() as unknown as Note[];
    return rows[0] ?? null;
  }

  /**
   * Create a new note. Returns the created note.
   */
  create(title: string, content: string = ""): Note {
    const id = crypto.randomUUID();
    const now = Date.now();

    this.sql.exec(
      "INSERT INTO notes (id, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      id,
      title,
      content,
      now,
      now
    );

    return { id, title, content, created_at: now, updated_at: now };
  }

  /**
   * Update an existing note. Returns the updated note or null if not found.
   */
  update(id: string, title: string, content: string): Note | null {
    const now = Date.now();

    this.sql.exec(
      "UPDATE notes SET title = ?, content = ?, updated_at = ? WHERE id = ?",
      title,
      content,
      now,
      id
    );

    return this.get(id);
  }

  /**
   * Delete a note by ID. Returns true if deleted.
   */
  delete(id: string): boolean {
    const before = this.sql
      .exec("SELECT COUNT(*) as count FROM notes WHERE id = ?", id)
      .one() as { count: number } | null;

    if (!before || before.count === 0) {
      return false;
    }

    this.sql.exec("DELETE FROM notes WHERE id = ?", id);
    return true;
  }

  /**
   * Search notes by title (case-insensitive).
   */
  search(query: string): Note[] {
    return this.sql
      .exec(
        "SELECT * FROM notes WHERE title LIKE ? ORDER BY updated_at DESC",
        `%${query}%`
      )
      .toArray() as unknown as Note[];
  }

  /**
   * Get total count of notes.
   */
  count(): number {
    const row = this.sql.exec("SELECT COUNT(*) as count FROM notes").one() as {
      count: number;
    } | null;
    return row?.count ?? 0;
  }
}
