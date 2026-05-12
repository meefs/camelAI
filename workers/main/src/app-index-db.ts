import type {
  AdminAppListRow,
  AdminEventType,
  AdminThreadListRow,
  AdminUserSummaryRow,
  AppFilters,
  OrgDirectoryFilters,
  OrgFilters,
  ThreadFilters,
  UserFilters,
  WorkspaceFilters,
} from './admin-index-do.js';

type AppIndexEnv = { APP_DB?: D1Database };

type D1Binding = D1Database | D1DatabaseSession;

async function first<T = Record<string, unknown>>(stmt: D1PreparedStatement): Promise<T | null> {
  return (await stmt.first<T>()) ?? null;
}

function toNumber(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function toBoolean(value: unknown): boolean {
  return value === 1 || value === true;
}

function normalizeSignupIp(ip: string): string | null {
  const normalized = ip.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function normalizeSqlStringList(values: string[] | undefined): string[] {
  return Array.from(new Set((values ?? []).map((value) => value.trim()).filter(Boolean)));
}

function applyOrgDirectoryFilters(
  conditions: string[],
  params: unknown[],
  filters: OrgDirectoryFilters | undefined,
): void {
  if (filters?.archived !== undefined) {
    conditions.push('o.archived = ?');
    params.push(filters.archived ? 1 : 0);
  }
  if (filters?.has_llm_provider === true) conditions.push('o.llm_provider IS NOT NULL');
  if (filters?.has_llm_provider === false) conditions.push('o.llm_provider IS NULL');
  if (filters?.llm_provider) {
    conditions.push('o.llm_provider = ?');
    params.push(filters.llm_provider);
  }
  const excludedOrgIds = normalizeSqlStringList(filters?.exclude_org_ids);
  if (excludedOrgIds.length > 0) {
    conditions.push(`
      NOT EXISTS (
        SELECT 1
        FROM json_each(?) excluded_org_ids
        WHERE excluded_org_ids.value = o.id
      )
    `);
    params.push(JSON.stringify(excludedOrgIds));
  }
  const excludedDomains = normalizeSqlStringList(filters?.exclude_creator_domains).map((domain) => domain.toLowerCase());
  if (excludedDomains.length > 0) {
    conditions.push(`
      (
        u.email IS NULL
        OR INSTR(u.email, '@') <= 0
        OR NOT EXISTS (
          SELECT 1
          FROM json_each(?) excluded_creator_domains
          WHERE excluded_creator_domains.value = LOWER(SUBSTR(u.email, INSTR(u.email, '@') + 1))
        )
      )
    `);
    params.push(JSON.stringify(excludedDomains));
  }
}

function normalizeOrgDirectoryRow(row: any) {
  return {
    ...row,
    archived: toBoolean(row.archived),
    slug: row.slug ?? null,
    billing_status: row.billing_status ?? null,
    creator_email: row.creator_email ?? null,
    creator_name: row.creator_name ?? null,
  };
}

function normalizeWorkspaceRow(row: any) {
  return {
    ...row,
    description: row.description ?? null,
    avatar: {
      color: row.avatar_color || '#666',
      content: row.avatar_content || 'W',
    },
    archived: toBoolean(row.archived),
    archived_at: row.archived_at ?? null,
    archived_by: row.archived_by ?? null,
    compute_tier: row.compute_tier ?? 'standard',
  };
}

const USER_SORT_COLS: Record<string, string> = { created_at: 'created_at', email: 'email', name: 'name' };
const THREAD_SORT_COLS: Record<string, string> = { created_at: 't.created_at', updated_at: 't.updated_at' };
const ORG_SORT_COLS: Record<string, string> = { created_at: 'created_at', name: 'name' };
const ORG_DIRECTORY_SORT_COLS: Record<string, string> = { created_at: 'o.created_at', name: 'o.name' };
const WORKSPACE_SORT_COLS: Record<string, string> = { created_at: 'w.created_at', name: 'w.name' };
const APP_SORT_COLS: Record<string, string> = { created_at: 'a.created_at', updated_at: 'a.updated_at' };
const D1_BATCH_SIZE = 100;

export class AppIndexDatabase {
  private schemaReady: Promise<void> | null = null;

  constructor(private readonly db: D1Binding) {}

  async ensureSchema(): Promise<void> {
    const statements = `
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        name TEXT,
        avatar_color TEXT,
        avatar_content TEXT,
        created_at INTEGER NOT NULL,
        is_superuser INTEGER NOT NULL DEFAULT 0,
        is_orphaned INTEGER NOT NULL DEFAULT 0,
        org_count INTEGER NOT NULL DEFAULT 0,
        signup_ip TEXT
      );
      CREATE TABLE IF NOT EXISTS orgs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT,
        created_at INTEGER NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0,
        billing_status TEXT,
        created_by TEXT,
        member_count INTEGER NOT NULL DEFAULT 0,
        workspace_count INTEGER NOT NULL DEFAULT 0,
        llm_provider TEXT,
        llm_provider_updated_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        org_id TEXT NOT NULL,
        description TEXT,
        avatar_color TEXT,
        avatar_content TEXT,
        created_at INTEGER NOT NULL,
        created_by TEXT,
        archived INTEGER NOT NULL DEFAULT 0,
        archived_at INTEGER,
        archived_by TEXT,
        compute_tier TEXT NOT NULL DEFAULT 'standard',
        thread_count INTEGER NOT NULL DEFAULT 0,
        integration_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        title TEXT,
        model TEXT,
        org_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        created_by TEXT
      );
      CREATE TABLE IF NOT EXISTS apps (
        app_id TEXT PRIMARY KEY,
        script_name TEXT NOT NULL,
        org_id TEXT,
        workspace_id TEXT NOT NULL,
        created_by TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        is_public INTEGER NOT NULL DEFAULT 0,
        preview_status TEXT,
        preview_error TEXT
      );
      CREATE TABLE IF NOT EXISTS invitations (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        email TEXT NOT NULL,
        role TEXT NOT NULL,
        invited_by TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS deleted_users (
        id TEXT PRIMARY KEY,
        deleted_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS blocked_signup_ips (
        ip TEXT PRIMARY KEY,
        blocked_at INTEGER NOT NULL,
        blocked_by TEXT,
        reason TEXT
      );
      CREATE TABLE IF NOT EXISTS org_memberships (
        org_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL,
        joined_at INTEGER NOT NULL,
        PRIMARY KEY (org_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS app_index_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
      CREATE INDEX IF NOT EXISTS idx_orgs_created_at ON orgs(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_orgs_llm_provider_created_at ON orgs(llm_provider, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_workspaces_org_created_at ON workspaces(org_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_threads_org_updated_at ON threads(org_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_threads_workspace_updated_at ON threads(workspace_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_apps_org_updated_at ON apps(org_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_apps_workspace_updated_at ON apps(workspace_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_org_memberships_user_id ON org_memberships(user_id);
      CREATE INDEX IF NOT EXISTS idx_org_memberships_org_joined_at ON org_memberships(org_id, joined_at DESC);
    `;
    this.schemaReady ??= this.db
      .batch(
        statements
          .split(';')
          .map((statement) => statement.trim())
          .filter(Boolean)
          .map((statement) => this.db.prepare(statement)),
      )
      .then(() => undefined);
    await this.schemaReady;
  }

  private getAppId(orgId: string | null | undefined, scriptName: string): string {
    return orgId ? `${orgId}:${scriptName}` : scriptName;
  }

  async isReady(): Promise<boolean> {
    await this.ensureSchema();
    const row = await first<{ value: string }>(
      this.db.prepare("SELECT value FROM app_index_metadata WHERE key = 'ready' LIMIT 1"),
    );
    return row?.value === '1';
  }

  async markReady(): Promise<void> {
    await this.ensureSchema();
    await this.db
      .prepare("INSERT OR REPLACE INTO app_index_metadata (key, value, updated_at) VALUES ('ready', '1', ?)")
      .bind(Date.now())
      .run();
  }

  async markNotReady(): Promise<void> {
    await this.ensureSchema();
    await this.db
      .prepare("INSERT OR REPLACE INTO app_index_metadata (key, value, updated_at) VALUES ('ready', '0', ?)")
      .bind(Date.now())
      .run();
  }

  async clearAdminIndexTable(table: string): Promise<void> {
    await this.ensureSchema();
    switch (table) {
      case 'users':
      case 'orgs':
      case 'workspaces':
      case 'threads':
      case 'apps':
      case 'invitations':
      case 'blocked_signup_ips':
      case 'org_memberships':
        await this.db.prepare(`DELETE FROM ${table}`).run();
        return;
      default:
        throw new Error(`Unsupported app index import table: ${table}`);
    }
  }

  private async all<T = Record<string, unknown>>(query: string, ...params: unknown[]): Promise<T[]> {
    await this.ensureSchema();
    const result = await this.db.prepare(query).bind(...params).all<T>();
    return result.results ?? [];
  }

  async isSignupIpBlocked(ip: string): Promise<boolean> {
    await this.ensureSchema();
    const normalizedIp = normalizeSignupIp(ip);
    if (!normalizedIp) return false;
    const row = await first(this.db.prepare('SELECT 1 FROM blocked_signup_ips WHERE ip = ? LIMIT 1').bind(normalizedIp));
    return Boolean(row);
  }

  async applyAdminEvent(event: AdminEventType): Promise<void> {
    await this.ensureSchema();
    switch (event.type) {
      case 'user_upsert': {
        const u = event.payload;
        const deleted = await first(this.db.prepare('SELECT 1 FROM deleted_users WHERE id = ? LIMIT 1').bind(u.id));
        if (deleted) break;
        const orgCount = typeof u.org_count === 'number' && Number.isFinite(u.org_count) ? u.org_count : null;
        const signupIp = typeof u.signup_ip === 'string' && u.signup_ip.trim() ? u.signup_ip.trim().toLowerCase() : null;
        await this.db
          .prepare(`
            INSERT INTO users (id, email, name, avatar_color, avatar_content, created_at, is_superuser, is_orphaned, org_count, signup_ip)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, COALESCE((SELECT org_count FROM users WHERE id = ?), 0)), COALESCE(?, (SELECT signup_ip FROM users WHERE id = ?)))
            ON CONFLICT(id) DO UPDATE SET
              email=excluded.email,
              name=excluded.name,
              avatar_color=excluded.avatar_color,
              avatar_content=excluded.avatar_content,
              is_superuser=excluded.is_superuser,
              is_orphaned=excluded.is_orphaned,
              org_count=COALESCE(excluded.org_count, users.org_count),
              signup_ip=COALESCE(excluded.signup_ip, users.signup_ip)
          `)
          .bind(u.id, u.email ?? '', u.name ?? null, u.avatar?.color ?? '', u.avatar?.content ?? '', u.created_at ?? Date.now(), u.is_superuser ? 1 : 0, u.is_orphaned ? 1 : 0, orgCount, u.id, signupIp, u.id)
          .run();
        break;
      }
      case 'user_delete':
        await this.db.batch([
          this.db.prepare('INSERT OR REPLACE INTO deleted_users (id, deleted_at) VALUES (?, ?)').bind(event.payload.id, Date.now()),
          this.db.prepare('DELETE FROM org_memberships WHERE user_id = ?').bind(event.payload.id),
          this.db.prepare('DELETE FROM users WHERE id = ?').bind(event.payload.id),
        ]);
        break;
      case 'org_upsert': {
        const o = event.payload;
        const slug = typeof o.slug === 'string' && o.slug.trim() ? o.slug : null;
        const memberCount = typeof o.member_count === 'number' && Number.isFinite(o.member_count) ? o.member_count : null;
        const workspaceCount = typeof o.workspace_count === 'number' && Number.isFinite(o.workspace_count) ? o.workspace_count : null;
        await this.db
          .prepare(`
            INSERT INTO orgs (id, name, slug, created_at, archived, billing_status, created_by, member_count, workspace_count)
            VALUES (?, ?, COALESCE(?, (SELECT slug FROM orgs WHERE id = ?)), ?, ?, ?, ?, COALESCE(?, COALESCE((SELECT member_count FROM orgs WHERE id = ?), 0)), COALESCE(?, COALESCE((SELECT workspace_count FROM orgs WHERE id = ?), 0)))
            ON CONFLICT(id) DO UPDATE SET
              name=excluded.name,
              slug=COALESCE(excluded.slug, orgs.slug),
              archived=excluded.archived,
              billing_status=excluded.billing_status,
              member_count=COALESCE(excluded.member_count, orgs.member_count),
              workspace_count=COALESCE(excluded.workspace_count, orgs.workspace_count)
          `)
          .bind(o.id, o.name, slug, o.id, o.created_at ?? Date.now(), o.archived ? 1 : 0, o.billing_status ?? null, o.created_by ?? null, memberCount, o.id, workspaceCount, o.id)
          .run();
        break;
      }
      case 'org_llm_provider_update':
        await this.db
          .prepare('UPDATE orgs SET llm_provider = ?, llm_provider_updated_at = ? WHERE id = ?')
          .bind(event.payload.provider, event.payload.updated_at, event.payload.org_id)
          .run();
        break;
      case 'workspace_upsert': {
        const w = event.payload;
        const integrationCount = typeof w.integration_count === 'number' && Number.isFinite(w.integration_count) ? w.integration_count : null;
        await this.db
          .prepare(`
            INSERT INTO workspaces (id, name, org_id, description, avatar_color, avatar_content, created_at, created_by, archived, archived_at, archived_by, compute_tier, thread_count, integration_count)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT thread_count FROM workspaces WHERE id = ?), 0), COALESCE(?, COALESCE((SELECT integration_count FROM workspaces WHERE id = ?), 0)))
            ON CONFLICT(id) DO UPDATE SET
              name=excluded.name,
              org_id=excluded.org_id,
              description=excluded.description,
              avatar_color=COALESCE(excluded.avatar_color, workspaces.avatar_color),
              avatar_content=COALESCE(excluded.avatar_content, workspaces.avatar_content),
              created_at=excluded.created_at,
              created_by=excluded.created_by,
              archived=excluded.archived,
              archived_at=excluded.archived_at,
              archived_by=excluded.archived_by,
              compute_tier=COALESCE(excluded.compute_tier, 'standard'),
              integration_count=COALESCE(excluded.integration_count, integration_count)
          `)
          .bind(w.id, w.name, w.org_id, w.description ?? null, w.avatar?.color ?? null, w.avatar?.content ?? null, w.created_at ?? Date.now(), w.created_by ?? null, w.archived ? 1 : 0, w.archived_at ?? null, w.archived_by ?? null, w.compute_tier ?? 'standard', w.id, integrationCount, w.id)
          .run();
        await this.db.prepare('UPDATE orgs SET workspace_count = (SELECT COUNT(*) FROM workspaces WHERE org_id = ?) WHERE id = ?').bind(w.org_id, w.org_id).run();
        break;
      }
      case 'thread_upsert': {
        const t = event.payload;
        await this.db
          .prepare(`
            INSERT INTO threads (id, title, model, org_id, workspace_id, created_at, updated_at, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET title=excluded.title, model=excluded.model, updated_at=excluded.updated_at
          `)
          .bind(t.id, t.title ?? null, t.model ?? 'sonnet', t.org_id, t.workspace_id, t.created_at ?? Date.now(), t.updated_at ?? Date.now(), t.created_by ?? null)
          .run();
        await this.db.prepare('UPDATE workspaces SET thread_count = (SELECT COUNT(*) FROM threads WHERE workspace_id = ?) WHERE id = ?').bind(t.workspace_id, t.workspace_id).run();
        break;
      }
      case 'app_upsert': {
        const a = event.payload;
        await this.db
          .prepare(`
            INSERT INTO apps (app_id, script_name, org_id, workspace_id, created_by, created_at, updated_at, is_public, preview_status, preview_error)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(app_id) DO UPDATE SET
              script_name=excluded.script_name,
              org_id=excluded.org_id,
              workspace_id=excluded.workspace_id,
              created_by=excluded.created_by,
              created_at=excluded.created_at,
              updated_at=excluded.updated_at,
              is_public=excluded.is_public,
              preview_status=excluded.preview_status,
              preview_error=excluded.preview_error
          `)
          .bind(this.getAppId(a.org_id, a.script_name), a.script_name, a.org_id ?? null, a.workspace_id, a.created_by ?? null, a.created_at ?? Date.now(), a.updated_at ?? Date.now(), a.is_public ? 1 : 0, a.preview_status ?? null, a.preview_error ?? null)
          .run();
        break;
      }
      case 'invitation_upsert': {
        const i = event.payload;
        await this.db
          .prepare(`
            INSERT INTO invitations (id, org_id, email, role, invited_by, status, created_at, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET status=excluded.status, role=excluded.role
          `)
          .bind(i.id, i.org_id, i.email, i.role, i.invited_by, i.status ?? 'pending', i.created_at ?? Date.now(), i.expires_at ?? Date.now())
          .run();
        break;
      }
      case 'thread_delete': {
        const workspaceId = event.payload.workspace_id ?? (await first<{ workspace_id: string }>(this.db.prepare('SELECT workspace_id FROM threads WHERE id = ?').bind(event.payload.id)))?.workspace_id ?? null;
        await this.db.prepare('DELETE FROM threads WHERE id = ?').bind(event.payload.id).run();
        if (workspaceId) {
          await this.db.prepare('UPDATE workspaces SET thread_count = (SELECT COUNT(*) FROM threads WHERE workspace_id = ?) WHERE id = ?').bind(workspaceId, workspaceId).run();
        }
        break;
      }
      case 'app_delete':
        await this.db
          .prepare(event.payload.org_id ? 'DELETE FROM apps WHERE app_id = ?' : 'DELETE FROM apps WHERE script_name = ?')
          .bind(event.payload.org_id ? this.getAppId(event.payload.org_id, event.payload.script_name) : event.payload.script_name)
          .run();
        break;
      case 'invitation_delete':
        await this.db.prepare('DELETE FROM invitations WHERE id = ?').bind(event.payload.id).run();
        break;
      case 'workspace_delete':
        await this.db.prepare('DELETE FROM workspaces WHERE id = ?').bind(event.payload.id).run();
        break;
      case 'org_member_delta':
        await this.db.prepare('UPDATE orgs SET member_count = MAX(0, member_count + ?) WHERE id = ?').bind(event.payload.delta, event.payload.org_id).run();
        break;
      case 'user_org_delta':
        await this.db.prepare('UPDATE users SET org_count = MAX(0, org_count + ?) WHERE id = ?').bind(event.payload.delta, event.payload.user_id).run();
        break;
      case 'org_membership_upsert':
        await this.db
          .prepare(`
            INSERT INTO org_memberships (org_id, user_id, role, joined_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(org_id, user_id) DO UPDATE SET role = excluded.role, joined_at = COALESCE(org_memberships.joined_at, excluded.joined_at)
          `)
          .bind(event.payload.org_id, event.payload.user_id, event.payload.role, event.payload.joined_at)
          .run();
        break;
      case 'org_membership_delete':
        await this.db.prepare('DELETE FROM org_memberships WHERE org_id = ? AND user_id = ?').bind(event.payload.org_id, event.payload.user_id).run();
        break;
    }
  }

  async importAdminIndexRows(table: string, rows: Array<Record<string, unknown>>): Promise<number> {
    await this.ensureSchema();
    if (rows.length === 0) return 0;

    const statements = rows.map((row) => {
      switch (table) {
        case 'users':
          return this.db
            .prepare(`
              INSERT INTO users (id, email, name, avatar_color, avatar_content, created_at, is_superuser, is_orphaned, org_count, signup_ip)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                email=excluded.email,
                name=excluded.name,
                avatar_color=excluded.avatar_color,
                avatar_content=excluded.avatar_content,
                created_at=excluded.created_at,
                is_superuser=excluded.is_superuser,
                is_orphaned=excluded.is_orphaned,
                org_count=excluded.org_count,
                signup_ip=excluded.signup_ip
            `)
            .bind(row.id, row.email ?? '', row.name ?? null, row.avatar_color ?? null, row.avatar_content ?? null, row.created_at ?? Date.now(), row.is_superuser ?? 0, row.is_orphaned ?? 0, row.org_count ?? 0, row.signup_ip ?? null);
        case 'orgs':
          return this.db
            .prepare(`
              INSERT INTO orgs (id, name, slug, created_at, archived, billing_status, created_by, member_count, workspace_count, llm_provider, llm_provider_updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                name=excluded.name,
                slug=excluded.slug,
                created_at=excluded.created_at,
                archived=excluded.archived,
                billing_status=excluded.billing_status,
                created_by=excluded.created_by,
                member_count=excluded.member_count,
                workspace_count=excluded.workspace_count,
                llm_provider=excluded.llm_provider,
                llm_provider_updated_at=excluded.llm_provider_updated_at
            `)
            .bind(row.id, row.name ?? '', row.slug ?? null, row.created_at ?? Date.now(), row.archived ?? 0, row.billing_status ?? null, row.created_by ?? null, row.member_count ?? 0, row.workspace_count ?? 0, row.llm_provider ?? null, row.llm_provider_updated_at ?? null);
        case 'workspaces':
          return this.db
            .prepare(`
              INSERT INTO workspaces (id, name, org_id, description, avatar_color, avatar_content, created_at, created_by, archived, archived_at, archived_by, compute_tier, thread_count, integration_count)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                name=excluded.name,
                org_id=excluded.org_id,
                description=excluded.description,
                avatar_color=excluded.avatar_color,
                avatar_content=excluded.avatar_content,
                created_at=excluded.created_at,
                created_by=excluded.created_by,
                archived=excluded.archived,
                archived_at=excluded.archived_at,
                archived_by=excluded.archived_by,
                compute_tier=excluded.compute_tier,
                thread_count=excluded.thread_count,
                integration_count=excluded.integration_count
            `)
            .bind(row.id, row.name ?? '', row.org_id, row.description ?? null, row.avatar_color ?? null, row.avatar_content ?? null, row.created_at ?? Date.now(), row.created_by ?? null, row.archived ?? 0, row.archived_at ?? null, row.archived_by ?? null, row.compute_tier ?? 'standard', row.thread_count ?? 0, row.integration_count ?? 0);
        case 'threads':
          return this.db
            .prepare(`
              INSERT INTO threads (id, title, model, org_id, workspace_id, created_at, updated_at, created_by)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                title=excluded.title,
                model=excluded.model,
                org_id=excluded.org_id,
                workspace_id=excluded.workspace_id,
                created_at=excluded.created_at,
                updated_at=excluded.updated_at,
                created_by=excluded.created_by
            `)
            .bind(row.id, row.title ?? null, row.model ?? null, row.org_id, row.workspace_id, row.created_at ?? Date.now(), row.updated_at ?? Date.now(), row.created_by ?? null);
        case 'apps':
          return this.db
            .prepare(`
              INSERT INTO apps (app_id, script_name, org_id, workspace_id, created_by, created_at, updated_at, is_public, preview_status, preview_error)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(app_id) DO UPDATE SET
                script_name=excluded.script_name,
                org_id=excluded.org_id,
                workspace_id=excluded.workspace_id,
                created_by=excluded.created_by,
                created_at=excluded.created_at,
                updated_at=excluded.updated_at,
                is_public=excluded.is_public,
                preview_status=excluded.preview_status,
                preview_error=excluded.preview_error
            `)
            .bind(row.app_id, row.script_name, row.org_id ?? null, row.workspace_id, row.created_by ?? null, row.created_at ?? Date.now(), row.updated_at ?? Date.now(), row.is_public ?? 0, row.preview_status ?? null, row.preview_error ?? null);
        case 'invitations':
          return this.db
            .prepare(`
              INSERT INTO invitations (id, org_id, email, role, invited_by, status, created_at, expires_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                org_id=excluded.org_id,
                email=excluded.email,
                role=excluded.role,
                invited_by=excluded.invited_by,
                status=excluded.status,
                created_at=excluded.created_at,
                expires_at=excluded.expires_at
            `)
            .bind(row.id, row.org_id, row.email, row.role, row.invited_by, row.status ?? 'pending', row.created_at ?? Date.now(), row.expires_at ?? Date.now());
        case 'blocked_signup_ips':
          return this.db
            .prepare(`
              INSERT INTO blocked_signup_ips (ip, blocked_at, blocked_by, reason)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(ip) DO UPDATE SET
                blocked_at=excluded.blocked_at,
                blocked_by=excluded.blocked_by,
                reason=excluded.reason
            `)
            .bind(row.ip, row.blocked_at, row.blocked_by ?? null, row.reason ?? null);
        case 'org_memberships':
          return this.db
            .prepare(`
              INSERT INTO org_memberships (org_id, user_id, role, joined_at)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(org_id, user_id) DO UPDATE SET
                role=excluded.role,
                joined_at=excluded.joined_at
            `)
            .bind(row.org_id, row.user_id, row.role, row.joined_at);
        default:
          throw new Error(`Unsupported app index import table: ${table}`);
      }
    });

    for (let i = 0; i < statements.length; i += D1_BATCH_SIZE) {
      await this.db.batch(statements.slice(i, i + D1_BATCH_SIZE));
    }
    return rows.length;
  }

  async getOverview() {
    const [totalUsers, totalOrgs, totalMemberships, totalWorkspaces, totalIntegrations, orphanedUsers, users] = await Promise.all([
      first<{ count: number }>(this.db.prepare('SELECT COUNT(*) AS count FROM users')),
      first<{ count: number }>(this.db.prepare('SELECT COUNT(*) AS count FROM orgs')),
      first<{ count: number }>(this.db.prepare('SELECT SUM(member_count) AS count FROM orgs')),
      first<{ count: number }>(this.db.prepare('SELECT COUNT(*) AS count FROM workspaces')),
      first<{ count: number }>(this.db.prepare('SELECT SUM(integration_count) AS count FROM workspaces')),
      first<{ count: number }>(this.db.prepare('SELECT COUNT(*) AS count FROM users WHERE is_orphaned = 1')),
      this.all<any>('SELECT * FROM users'),
    ]);
    return {
      total_users: toNumber(totalUsers?.count),
      total_orgs: toNumber(totalOrgs?.count),
      total_memberships: toNumber(totalMemberships?.count),
      total_workspaces: toNumber(totalWorkspaces?.count),
      total_integrations: toNumber(totalIntegrations?.count),
      orphaned_users: toNumber(orphanedUsers?.count),
      superusers: users.filter((u) => u.is_superuser === 1).map((u) => ({ ...u, avatar: { color: u.avatar_color || '#666', content: u.avatar_content || 'U' }, is_superuser: true, is_orphaned: u.is_orphaned === 1 })),
    };
  }

  async getUsersPaginated(offset: number, limit: number, search?: string, filters?: UserFilters) {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (search) {
      conditions.push('(email LIKE ? OR name LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }
    if (filters?.is_superuser !== undefined) {
      conditions.push('is_superuser = ?');
      params.push(filters.is_superuser ? 1 : 0);
    }
    if (filters?.is_orphaned !== undefined) {
      conditions.push('is_orphaned = ?');
      params.push(filters.is_orphaned ? 1 : 0);
    }
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
    const sortCol = USER_SORT_COLS[filters?.sort_by ?? 'created_at'] ?? 'created_at';
    const sortDir = filters?.sort_dir === 'asc' ? 'ASC' : 'DESC';
    const items = (await this.all<any>(`SELECT * FROM users${where} ORDER BY ${sortCol} ${sortDir} LIMIT ? OFFSET ?`, ...params, limit, offset)).map((u) => ({
      ...u,
      avatar: { color: u.avatar_color || '#666', content: u.avatar_content || 'U' },
      is_superuser: u.is_superuser === 1,
      is_orphaned: u.is_orphaned === 1,
      signup_ip: u.signup_ip ?? null,
    }));
    const total = toNumber((await first<{ count: number }>(this.db.prepare(`SELECT COUNT(*) AS count FROM users${where}`).bind(...params)))?.count);
    return { items, total, offset, limit, hasMore: offset + items.length < total };
  }

  async getThreadsPaginated(offset: number, limit: number, search?: string, filters?: ThreadFilters) {
    const base = 'SELECT t.*, o.name as org_name, w.name as workspace_name FROM threads t LEFT JOIN orgs o ON t.org_id = o.id LEFT JOIN workspaces w ON t.workspace_id = w.id';
    const countBase = 'SELECT COUNT(*) as count FROM threads t LEFT JOIN orgs o ON t.org_id = o.id LEFT JOIN workspaces w ON t.workspace_id = w.id';
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (search) {
      conditions.push('(t.title LIKE ? OR t.model LIKE ? OR o.name LIKE ? OR w.name LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (filters?.org_id) { conditions.push('t.org_id = ?'); params.push(filters.org_id); }
    if (filters?.workspace_id) { conditions.push('t.workspace_id = ?'); params.push(filters.workspace_id); }
    if (filters?.created_by) { conditions.push('t.created_by = ?'); params.push(filters.created_by); }
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
    const sortCol = THREAD_SORT_COLS[filters?.sort_by ?? 'updated_at'] ?? 't.updated_at';
    const sortDir = filters?.sort_dir === 'asc' ? 'ASC' : 'DESC';
    const items = await this.all<AdminThreadListRow>(`${base}${where} ORDER BY ${sortCol} ${sortDir} LIMIT ? OFFSET ?`, ...params, limit, offset);
    const total = toNumber((await first<{ count: number }>(this.db.prepare(`${countBase}${where}`).bind(...params)))?.count);
    return { items, total, offset, limit, hasMore: offset + items.length < total };
  }

  async getOrgsPaginated(offset: number, limit: number, search?: string, filters?: OrgFilters) {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (search) { conditions.push('name LIKE ?'); params.push(`%${search}%`); }
    if (filters?.archived !== undefined) { conditions.push('archived = ?'); params.push(filters.archived ? 1 : 0); }
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
    const sortCol = ORG_SORT_COLS[filters?.sort_by ?? 'created_at'] ?? 'created_at';
    const sortDir = filters?.sort_dir === 'asc' ? 'ASC' : 'DESC';
    const rows = await this.all<any>(`SELECT * FROM orgs${where} ORDER BY ${sortCol} ${sortDir} LIMIT ? OFFSET ?`, ...params, limit, offset);
    const total = toNumber((await first<{ count: number }>(this.db.prepare(`SELECT COUNT(*) AS count FROM orgs${where}`).bind(...params)))?.count);
    return { items: rows.map((o) => ({ ...o, archived: o.archived === 1 })), total, offset, limit, hasMore: offset + rows.length < total };
  }

  async getOrgDirectoryRows(): Promise<any[]> {
    return this.getOrgDirectoryRowsInternal();
  }

  private async getOrgDirectoryRowsInternal(filters: OrgDirectoryFilters = {}): Promise<any[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    applyOrgDirectoryFilters(conditions, params, filters);
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
    const rows = await this.all<any>(`
      SELECT o.id, o.name, o.slug, o.created_at, o.archived, o.billing_status, o.created_by,
             CASE
               WHEN COALESCE(m.indexed_member_count, 0) > COALESCE(o.member_count, 0)
                 THEN m.indexed_member_count
               ELSE COALESCE(o.member_count, 0)
             END AS member_count,
             o.workspace_count, u.email as creator_email, u.name as creator_name
      FROM orgs o
      LEFT JOIN users u ON o.created_by = u.id
      LEFT JOIN (
        SELECT org_id, COUNT(*) AS indexed_member_count
        FROM org_memberships
        GROUP BY org_id
      ) m ON m.org_id = o.id
      ${where}
    `, ...params);
    return rows.map(normalizeOrgDirectoryRow);
  }

  async getOrgDirectoryPaginated(offset: number, limit: number, search?: string, filters: OrgDirectoryFilters = {}) {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (search) { conditions.push('(o.name LIKE ? OR o.slug LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
    applyOrgDirectoryFilters(conditions, params, filters);
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
    const sortCol = ORG_DIRECTORY_SORT_COLS[filters.sort_by ?? 'created_at'] ?? 'o.created_at';
    const sortDir = filters.sort_dir === 'asc' ? 'ASC' : 'DESC';
    const rows = await this.all<any>(`
      SELECT o.id, o.name, o.slug, o.created_at, o.archived, o.billing_status, o.created_by,
             CASE
               WHEN COALESCE(m.indexed_member_count, 0) > COALESCE(o.member_count, 0)
                 THEN m.indexed_member_count
               ELSE COALESCE(o.member_count, 0)
             END AS member_count,
             o.workspace_count, u.email as creator_email, u.name as creator_name
      FROM orgs o
      LEFT JOIN users u ON o.created_by = u.id
      LEFT JOIN (
        SELECT org_id, COUNT(*) AS indexed_member_count
        FROM org_memberships
        GROUP BY org_id
      ) m ON m.org_id = o.id
      ${where}
      ORDER BY ${sortCol} ${sortDir}
      LIMIT ? OFFSET ?
    `, ...params, limit, offset);
    const total = toNumber((await first<{ count: number }>(this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM orgs o
      LEFT JOIN users u ON o.created_by = u.id
      LEFT JOIN (
        SELECT org_id, COUNT(*) AS indexed_member_count
        FROM org_memberships
        GROUP BY org_id
      ) m ON m.org_id = o.id
      ${where}
    `).bind(...params)))?.count);
    return { items: rows.map(normalizeOrgDirectoryRow), total, offset, limit, hasMore: offset + rows.length < total };
  }

  async getOrgLlmProviderDirectoryPaginated(offset: number, limit: number, search?: string, provider?: string) {
    return this.getOrgDirectoryPaginated(offset, limit, search, {
      has_llm_provider: true,
      llm_provider: provider?.trim() || undefined,
    });
  }

  async getWorkspacesPaginated(offset: number, limit: number, search?: string, filters?: WorkspaceFilters) {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (search) { conditions.push('(w.name LIKE ? OR o.name LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
    if (filters?.org_id) { conditions.push('w.org_id = ?'); params.push(filters.org_id); }
    if (filters?.archived !== undefined) { conditions.push('w.archived = ?'); params.push(filters.archived ? 1 : 0); }
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
    const sortCol = WORKSPACE_SORT_COLS[filters?.sort_by ?? 'created_at'] ?? 'w.created_at';
    const sortDir = filters?.sort_dir === 'asc' ? 'ASC' : 'DESC';
    const rows = await this.all<any>(`SELECT w.*, o.name as org_name FROM workspaces w LEFT JOIN orgs o ON w.org_id = o.id${where} ORDER BY ${sortCol} ${sortDir} LIMIT ? OFFSET ?`, ...params, limit, offset);
    const total = toNumber((await first<{ count: number }>(this.db.prepare(`SELECT COUNT(*) AS count FROM workspaces w LEFT JOIN orgs o ON w.org_id = o.id${where}`).bind(...params)))?.count);
    return { items: rows.map(normalizeWorkspaceRow), total, offset, limit, hasMore: offset + rows.length < total };
  }

  async getAppsPaginated(offset: number, limit: number, search?: string, filters?: AppFilters) {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (search) {
      conditions.push('(a.script_name LIKE ? OR o.name LIKE ? OR w.name LIKE ? OR u.name LIKE ? OR u.email LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (filters?.org_id) { conditions.push('a.org_id = ?'); params.push(filters.org_id); }
    if (filters?.workspace_id) { conditions.push('a.workspace_id = ?'); params.push(filters.workspace_id); }
    if (filters?.is_public !== undefined) { conditions.push('a.is_public = ?'); params.push(filters.is_public ? 1 : 0); }
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
    const sortCol = APP_SORT_COLS[filters?.sort_by ?? 'updated_at'] ?? 'a.updated_at';
    const sortDir = filters?.sort_dir === 'asc' ? 'ASC' : 'DESC';
    const rows = await this.all<any>(`
      SELECT a.*, o.name as org_name, o.slug as org_slug, w.name as workspace_name, u.name as created_by_name, u.email as created_by_email
      FROM apps a
      LEFT JOIN orgs o ON a.org_id = o.id
      LEFT JOIN workspaces w ON a.workspace_id = w.id
      LEFT JOIN users u ON a.created_by = u.id
      ${where}
      ORDER BY ${sortCol} ${sortDir}
      LIMIT ? OFFSET ?
    `, ...params, limit, offset);
    const total = toNumber((await first<{ count: number }>(this.db.prepare(`SELECT COUNT(*) AS count FROM apps a LEFT JOIN orgs o ON a.org_id = o.id LEFT JOIN workspaces w ON a.workspace_id = w.id LEFT JOIN users u ON a.created_by = u.id${where}`).bind(...params)))?.count);
    return { items: rows.map((row) => ({ ...row, is_public: row.is_public === 1 })), total, offset, limit, hasMore: offset + rows.length < total };
  }

  async getOrgById(orgId: string) {
    const row = await first<any>(this.db.prepare('SELECT * FROM orgs WHERE id = ? LIMIT 1').bind(orgId));
    return row ? { ...row, archived: row.archived === 1 } : null;
  }

  async getThreadContextById(threadId: string) {
    return first<{ org_id: string; workspace_id: string }>(
      this.db.prepare('SELECT org_id, workspace_id FROM threads WHERE id = ? LIMIT 1').bind(threadId),
    );
  }

  async getUsersByOrgIds(orgIds: string[]): Promise<AdminUserSummaryRow[]> {
    const normalizedOrgIds = Array.from(
      new Set(orgIds.map((orgId) => orgId.trim()).filter((orgId) => orgId.length > 0)),
    );
    if (normalizedOrgIds.length === 0) return [];
    const rows = await this.all<any>(`
      SELECT DISTINCT u.*
      FROM users u
      INNER JOIN org_memberships m ON m.user_id = u.id
      WHERE m.org_id IN (SELECT value FROM json_each(?))
    `, JSON.stringify(normalizedOrgIds));
    return rows.map((u) => ({ ...u, avatar: { color: u.avatar_color || '#666', content: u.avatar_content || 'U' }, is_superuser: u.is_superuser === 1, is_orphaned: u.is_orphaned === 1, signup_ip: u.signup_ip ?? null }));
  }

  async getThreadsByOrgIds(orgIds: string[]): Promise<AdminThreadListRow[]> {
    const normalizedOrgIds = Array.from(
      new Set(orgIds.map((orgId) => orgId.trim()).filter((orgId) => orgId.length > 0)),
    );
    if (normalizedOrgIds.length === 0) return [];
    return this.all<AdminThreadListRow>(`
      SELECT t.*, o.name as org_name, w.name as workspace_name
      FROM threads t
      LEFT JOIN orgs o ON t.org_id = o.id
      LEFT JOIN workspaces w ON t.workspace_id = w.id
      WHERE t.org_id IN (SELECT value FROM json_each(?))
    `, JSON.stringify(normalizedOrgIds));
  }

  async getAppsByOrgIds(orgIds: string[]): Promise<AdminAppListRow[]> {
    const normalizedOrgIds = Array.from(
      new Set(orgIds.map((orgId) => orgId.trim()).filter((orgId) => orgId.length > 0)),
    );
    if (normalizedOrgIds.length === 0) return [];
    return this.all<any>(`
      SELECT a.*, o.name as org_name, o.slug as org_slug, w.name as workspace_name, u.name as created_by_name, u.email as created_by_email
      FROM apps a
      LEFT JOIN orgs o ON a.org_id = o.id
      LEFT JOIN workspaces w ON a.workspace_id = w.id
      LEFT JOIN users u ON a.created_by = u.id
      WHERE a.org_id IN (SELECT value FROM json_each(?))
    `, JSON.stringify(normalizedOrgIds)).then((rows) => rows.map((row) => ({ ...row, is_public: row.is_public === 1 })));
  }

  async getOrgDirectoryByIds(orgIds: string[]) {
    const normalizedOrgIds = Array.from(
      new Set(orgIds.map((orgId) => orgId.trim()).filter((orgId) => orgId.length > 0)),
    );
    if (normalizedOrgIds.length === 0) return [];
    const rows = await this.all<any>(`
      SELECT o.id, o.name, o.slug, o.created_at, o.archived, o.billing_status, o.created_by,
             CASE
               WHEN COALESCE(m.indexed_member_count, 0) > COALESCE(o.member_count, 0)
                 THEN m.indexed_member_count
               ELSE COALESCE(o.member_count, 0)
             END AS member_count,
             o.workspace_count, u.email as creator_email, u.name as creator_name
      FROM orgs o
      LEFT JOIN users u ON o.created_by = u.id
      LEFT JOIN (
        SELECT org_id, COUNT(*) AS indexed_member_count
        FROM org_memberships
        GROUP BY org_id
      ) m ON m.org_id = o.id
      WHERE o.id IN (SELECT value FROM json_each(?))
      ORDER BY o.created_at DESC, o.id ASC
    `, JSON.stringify(normalizedOrgIds));
    return rows.map(normalizeOrgDirectoryRow);
  }
}

export function getAppIndexDatabase(env: AppIndexEnv): AppIndexDatabase | null {
  return env.APP_DB ? new AppIndexDatabase(env.APP_DB) : null;
}

export function getAppIndexReadDatabase(env: AppIndexEnv): AppIndexDatabase | null {
  return env.APP_DB ? new AppIndexDatabase(env.APP_DB.withSession('first-primary')) : null;
}
