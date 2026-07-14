import { DurableObject } from 'cloudflare:workers';

interface Env {
  SMOKE_DO: DurableObjectNamespace<SmokeDurableObject>;
}

export class SmokeDurableObject extends DurableObject {
  private ensureSchema(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS smoke_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
  }

  async fetch(request: Request): Promise<Response> {
    this.ensureSchema();
    const pathname = new URL(request.url).pathname;
    if (pathname === '/seed') {
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO smoke_state (key, value) VALUES ('sentinel', 'preserved')`,
      );
      this.ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO smoke_state (key, value) VALUES ('alarm_runs', '0')`,
      );
      await this.ctx.storage.setAlarm(Date.now() + 1_000);
    }
    const rows = [...this.ctx.storage.sql.exec<{ key: string; value: string }>(
      'SELECT key, value FROM smoke_state ORDER BY key',
    )];
    return Response.json(Object.fromEntries(rows.map((row) => [row.key, row.value])));
  }

  async alarm(): Promise<void> {
    this.ensureSchema();
    this.ctx.storage.sql.exec(`
      INSERT INTO smoke_state (key, value) VALUES ('alarm_runs', '1')
      ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)
    `);
    await this.ctx.storage.setAlarm(Date.now() + 1_000);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return env.SMOKE_DO.get(env.SMOKE_DO.idFromName('singleton')).fetch(request);
  },
} satisfies ExportedHandler<Env>;
