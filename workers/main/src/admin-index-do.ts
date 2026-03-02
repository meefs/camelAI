import { DurableObject } from 'cloudflare:workers';
import type { DOEnv } from './auth';

// ---------------------------------------------------------------------------
// Filter types for paginated queries
// ---------------------------------------------------------------------------

export interface UserFilters {
  is_superuser?: boolean;
  is_orphaned?: boolean;
  sort_by?: 'created_at' | 'email' | 'name';
  sort_dir?: 'asc' | 'desc';
}

export interface ThreadFilters {
  org_id?: string;
  workspace_id?: string;
  created_by?: string;
  sort_by?: 'created_at' | 'updated_at';
  sort_dir?: 'asc' | 'desc';
}

export interface OrgFilters {
  archived?: boolean;
  sort_by?: 'created_at' | 'name';
  sort_dir?: 'asc' | 'desc';
}

export interface WorkspaceFilters {
  org_id?: string;
  archived?: boolean;
  sort_by?: 'created_at' | 'name';
  sort_dir?: 'asc' | 'desc';
}

export interface AppFilters {
  org_id?: string;
  workspace_id?: string;
  is_public?: boolean;
  sort_by?: 'created_at' | 'updated_at';
  sort_dir?: 'asc' | 'desc';
}

// Sort column allowlists (prevents SQL injection via validated keys)
const USER_SORT_COLS: Record<string, string> = { created_at: 'created_at', email: 'email', name: 'name' };
const THREAD_SORT_COLS: Record<string, string> = { created_at: 't.created_at', updated_at: 't.updated_at' };
const ORG_SORT_COLS: Record<string, string> = { created_at: 'created_at', name: 'name' };
const WORKSPACE_SORT_COLS: Record<string, string> = { created_at: 'w.created_at', name: 'w.name' };
const APP_SORT_COLS: Record<string, string> = { created_at: 'a.created_at', updated_at: 'a.updated_at' };

export type AdminEventType =
  | { type: 'user_upsert'; payload: any }
  | { type: 'user_delete'; payload: { id: string } }
  | { type: 'org_upsert'; payload: any }
  | { type: 'workspace_upsert'; payload: any }
  | { type: 'thread_upsert'; payload: any }
  | { type: 'app_upsert'; payload: any }
  | { type: 'invitation_upsert'; payload: any }
  | { type: 'thread_delete'; payload: { id: string; workspace_id?: string | null } }
  | { type: 'app_delete'; payload: { script_name: string; org_id?: string | null } }
  | { type: 'invitation_delete'; payload: { id: string } }
  | { type: 'workspace_delete'; payload: { id: string } }
  | { type: 'org_member_delta'; payload: { org_id: string; delta: number } }
  | { type: 'user_org_delta'; payload: { user_id: string; delta: number } };

export class AdminIndexDO extends DurableObject<DOEnv> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: DOEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    
    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
    });
  }

  private getAppId(orgId: string | null | undefined, scriptName: string): string {
    if (!orgId) {
      return scriptName;
    }
    return `${orgId}:${scriptName}`;
  }

  private getOrgSlugSelectExpression(): string {
    const orgColumns = this.sql
      .exec<{ name: string }>('PRAGMA table_info(orgs)')
      .toArray();
    return orgColumns.some((column) => column.name === 'slug') ? 'o.slug' : 'NULL';
  }

  private isUserHardDeleted(userId: string): boolean {
    const rows = this.sql
      .exec('SELECT 1 FROM deleted_users WHERE id = ? LIMIT 1', userId)
      .toArray();
    return rows.length > 0;
  }

  private migrate() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT,
        name TEXT,
        avatar_color TEXT,
        avatar_content TEXT,
        created_at INTEGER,
        is_superuser INTEGER,
        is_orphaned INTEGER,
        org_count INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS orgs (
        id TEXT PRIMARY KEY,
        name TEXT,
        slug TEXT,
        created_at INTEGER,
        archived INTEGER,
        billing_status TEXT,
        created_by TEXT,
        member_count INTEGER DEFAULT 0,
        workspace_count INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        name TEXT,
        org_id TEXT,
        description TEXT,
        avatar_color TEXT,
        avatar_content TEXT,
        created_at INTEGER,
        created_by TEXT,
        archived INTEGER,
        archived_at INTEGER,
        archived_by TEXT,
        compute_tier TEXT,
        thread_count INTEGER DEFAULT 0,
        integration_count INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        title TEXT,
        org_id TEXT,
        workspace_id TEXT,
        created_at INTEGER,
        updated_at INTEGER,
        created_by TEXT
      );
      CREATE TABLE IF NOT EXISTS apps (
        app_id TEXT PRIMARY KEY,
        script_name TEXT,
        org_id TEXT,
        workspace_id TEXT,
        created_by TEXT,
        created_at INTEGER,
        updated_at INTEGER,
        is_public INTEGER,
        preview_status TEXT,
        preview_error TEXT
      );
      CREATE TABLE IF NOT EXISTS invitations (
        id TEXT PRIMARY KEY,
        org_id TEXT,
        email TEXT,
        role TEXT,
        invited_by TEXT,
        status TEXT,
        created_at INTEGER,
        expires_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS deleted_users (
        id TEXT PRIMARY KEY,
        deleted_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_threads_org_updated_at ON threads(org_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_apps_org_updated_at ON apps(org_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_workspaces_org_created_at ON workspaces(org_id, created_at DESC);
    `);

    const appColumns = this.sql.exec<{ name: string }>('PRAGMA table_info(apps)').toArray();
    const hasAppId = appColumns.some((col) => col.name === 'app_id');
    if (!hasAppId) {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS apps_v2 (
          app_id TEXT PRIMARY KEY,
          script_name TEXT,
          org_id TEXT,
          workspace_id TEXT,
          created_by TEXT,
          created_at INTEGER,
          updated_at INTEGER,
          is_public INTEGER,
          preview_status TEXT,
          preview_error TEXT
        );
        INSERT INTO apps_v2 (app_id, script_name, org_id, workspace_id, created_by, created_at, updated_at, is_public, preview_status, preview_error)
        SELECT
          CASE
            WHEN org_id IS NULL OR org_id = '' THEN script_name
            ELSE org_id || ':' || script_name
          END,
          script_name, org_id, workspace_id, created_by, created_at, updated_at, is_public, preview_status, preview_error
        FROM apps;
        DROP TABLE apps;
        ALTER TABLE apps_v2 RENAME TO apps;
      `);
    }

    const workspaceColumns = new Set(
      this.sql.exec<{ name: string }>('PRAGMA table_info(workspaces)').toArray().map((col) => col.name)
    );
    const orgColumns = new Set(
      this.sql.exec<{ name: string }>('PRAGMA table_info(orgs)').toArray().map((col) => col.name)
    );
    if (!orgColumns.has('slug')) {
      this.sql.exec('ALTER TABLE orgs ADD COLUMN slug TEXT');
    }

    if (!workspaceColumns.has('description')) {
      this.sql.exec('ALTER TABLE workspaces ADD COLUMN description TEXT');
    }
    if (!workspaceColumns.has('avatar_color')) {
      this.sql.exec('ALTER TABLE workspaces ADD COLUMN avatar_color TEXT');
    }
    if (!workspaceColumns.has('avatar_content')) {
      this.sql.exec('ALTER TABLE workspaces ADD COLUMN avatar_content TEXT');
    }
    if (!workspaceColumns.has('archived')) {
      this.sql.exec('ALTER TABLE workspaces ADD COLUMN archived INTEGER');
    }
    if (!workspaceColumns.has('archived_at')) {
      this.sql.exec('ALTER TABLE workspaces ADD COLUMN archived_at INTEGER');
    }
    if (!workspaceColumns.has('archived_by')) {
      this.sql.exec('ALTER TABLE workspaces ADD COLUMN archived_by TEXT');
    }
    if (!workspaceColumns.has('compute_tier')) {
      this.sql.exec("ALTER TABLE workspaces ADD COLUMN compute_tier TEXT DEFAULT 'standard'");
    }
  }

  async handleEvent(event: AdminEventType) {
    try {
      switch (event.type) {
        case 'user_upsert': {
          const u = event.payload;
          if (this.isUserHardDeleted(u.id)) {
            break;
          }
          const orgCount =
            typeof u.org_count === 'number' && Number.isFinite(u.org_count)
              ? u.org_count
              : null;
          this.sql.exec(`
            INSERT INTO users (id, email, name, avatar_color, avatar_content, created_at, is_superuser, is_orphaned, org_count)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, COALESCE((SELECT org_count FROM users WHERE id = ?), 0)))
            ON CONFLICT(id) DO UPDATE SET
              email=excluded.email, name=excluded.name, avatar_color=excluded.avatar_color, avatar_content=excluded.avatar_content,
              is_superuser=excluded.is_superuser, is_orphaned=excluded.is_orphaned,
              org_count=COALESCE(excluded.org_count, users.org_count)
          `, u.id, u.email, u.name, u.avatar?.color || '', u.avatar?.content || '', u.created_at, u.is_superuser ? 1 : 0, u.is_orphaned ? 1 : 0, orgCount, u.id);
          break;
        }
        case 'user_delete':
          this.sql.exec(
            'INSERT OR REPLACE INTO deleted_users (id, deleted_at) VALUES (?, ?)',
            event.payload.id,
            Date.now()
          );
          this.sql.exec('DELETE FROM users WHERE id = ?', event.payload.id);
          break;
        case 'org_upsert': {
          const o = event.payload;
          const slug = typeof o.slug === 'string' && o.slug.trim().length > 0 ? o.slug : null;
          const memberCount =
            typeof o.member_count === 'number' && Number.isFinite(o.member_count)
              ? o.member_count
              : null;
          const workspaceCount =
            typeof o.workspace_count === 'number' && Number.isFinite(o.workspace_count)
              ? o.workspace_count
              : null;
          this.sql.exec(`
            INSERT INTO orgs (id, name, slug, created_at, archived, billing_status, created_by, member_count, workspace_count)
            VALUES (?, ?, COALESCE(?, (SELECT slug FROM orgs WHERE id = ?)), ?, ?, ?, ?, COALESCE(?, COALESCE((SELECT member_count FROM orgs WHERE id = ?), 0)), COALESCE(?, COALESCE((SELECT workspace_count FROM orgs WHERE id = ?), 0)))
            ON CONFLICT(id) DO UPDATE SET
              name=excluded.name, slug=COALESCE(excluded.slug, orgs.slug), archived=excluded.archived, billing_status=excluded.billing_status,
              member_count=COALESCE(excluded.member_count, orgs.member_count),
              workspace_count=COALESCE(excluded.workspace_count, orgs.workspace_count)
          `, o.id, o.name, slug, o.id, o.created_at, o.archived ? 1 : 0, o.billing_status, o.created_by, memberCount, o.id, workspaceCount, o.id);
          break;
        }
        case 'workspace_upsert': {
          const w = event.payload;
          const integrationCount =
            typeof w.integration_count === 'number' && Number.isFinite(w.integration_count)
              ? w.integration_count
              : null;
          const archived =
            typeof w.archived === 'boolean' ? (w.archived ? 1 : 0) : 0;
          this.sql.exec(`
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
          `,
            w.id,
            w.name,
            w.org_id,
            w.description ?? null,
            w.avatar?.color ?? null,
            w.avatar?.content ?? null,
            w.created_at,
            w.created_by,
            archived,
            w.archived_at ?? null,
            w.archived_by ?? null,
            w.compute_tier ?? 'standard',
            w.id,
            integrationCount,
            w.id
          );
          this.sql.exec('UPDATE orgs SET workspace_count = (SELECT COUNT(*) FROM workspaces WHERE org_id = ?) WHERE id = ?', w.org_id, w.org_id);
          break;
        }
        case 'thread_upsert': {
          const t = event.payload;
          this.sql.exec(`
            INSERT INTO threads (id, title, org_id, workspace_id, created_at, updated_at, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET title=excluded.title, updated_at=excluded.updated_at
          `, t.id, t.title || null, t.org_id, t.workspace_id, t.created_at, t.updated_at, t.created_by);
          this.sql.exec('UPDATE workspaces SET thread_count = (SELECT COUNT(*) FROM threads WHERE workspace_id = ?) WHERE id = ?', t.workspace_id, t.workspace_id);
          break;
        }
        case 'app_upsert': {
          const a = event.payload;
          const appId = this.getAppId(a.org_id, a.script_name);
          this.sql.exec(`
            INSERT INTO apps (app_id, script_name, org_id, workspace_id, created_by, created_at, updated_at, is_public, preview_status, preview_error)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(app_id) DO UPDATE SET
              script_name=excluded.script_name,
              org_id=excluded.org_id,
              workspace_id=excluded.workspace_id,
              created_by=excluded.created_by,
              created_at=excluded.created_at,
              updated_at=excluded.updated_at, is_public=excluded.is_public, preview_status=excluded.preview_status, preview_error=excluded.preview_error
          `, appId, a.script_name, a.org_id, a.workspace_id, a.created_by, a.created_at, a.updated_at, a.is_public ? 1 : 0, a.preview_status || null, a.preview_error || null);
          break;
        }
        case 'invitation_upsert': {
          const i = event.payload;
          this.sql.exec(`
            INSERT INTO invitations (id, org_id, email, role, invited_by, status, created_at, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET status=excluded.status, role=excluded.role
          `, i.id, i.org_id, i.email, i.role, i.invited_by, i.status, i.created_at, i.expires_at);
          break;
        }
        case 'thread_delete':
          let deletedThreadWorkspaceId = event.payload.workspace_id ?? null;
          if (!deletedThreadWorkspaceId) {
            const rows = this.sql.exec<{ workspace_id: string }>(
              'SELECT workspace_id FROM threads WHERE id = ?',
              event.payload.id
            ).toArray();
            deletedThreadWorkspaceId = rows[0]?.workspace_id ?? null;
          }
          this.sql.exec('DELETE FROM threads WHERE id = ?', event.payload.id);
          if (deletedThreadWorkspaceId) {
            this.sql.exec(
              'UPDATE workspaces SET thread_count = (SELECT COUNT(*) FROM threads WHERE workspace_id = ?) WHERE id = ?',
              deletedThreadWorkspaceId,
              deletedThreadWorkspaceId
            );
          }
          break;
        case 'app_delete':
          if (event.payload.org_id) {
            this.sql.exec('DELETE FROM apps WHERE app_id = ?', this.getAppId(event.payload.org_id, event.payload.script_name));
          } else {
            this.sql.exec('DELETE FROM apps WHERE script_name = ?', event.payload.script_name);
          }
          break;
        case 'invitation_delete':
          this.sql.exec('DELETE FROM invitations WHERE id = ?', event.payload.id);
          break;
        case 'workspace_delete':
          this.sql.exec('DELETE FROM workspaces WHERE id = ?', event.payload.id);
          break;
        case 'org_member_delta':
          this.sql.exec('UPDATE orgs SET member_count = MAX(0, member_count + ?) WHERE id = ?', event.payload.delta, event.payload.org_id);
          break;
        case 'user_org_delta':
          this.sql.exec('UPDATE users SET org_count = MAX(0, org_count + ?) WHERE id = ?', event.payload.delta, event.payload.user_id);
          break;
      }
    } catch (err) {
      console.error('AdminIndexDO event error:', err);
    }
  }

  async getOverview() {
    const total_users = this.sql.exec('SELECT COUNT(*) as count FROM users').next().value?.count || 0;
    const total_orgs = this.sql.exec('SELECT COUNT(*) as count FROM orgs').next().value?.count || 0;
    const total_memberships = this.sql.exec('SELECT SUM(member_count) as count FROM orgs').next().value?.count || 0;
    const total_workspaces = this.sql.exec('SELECT COUNT(*) as count FROM workspaces').next().value?.count || 0;
    const total_integrations = this.sql.exec('SELECT SUM(integration_count) as count FROM workspaces').next().value?.count || 0;
    const orphaned_users = this.sql.exec('SELECT COUNT(*) as count FROM users WHERE is_orphaned = 1').next().value?.count || 0;
    
    const users = Array.from(this.sql.exec('SELECT * FROM users')).map((u: any) => ({
      ...u,
      avatar: { color: u.avatar_color, content: u.avatar_content },
      is_superuser: u.is_superuser === 1,
      is_orphaned: u.is_orphaned === 1
    }));

    return {
      users,
      total_users,
      total_orgs,
      total_memberships,
      total_workspaces,
      total_integrations,
      orphaned_users
    };
  }

  async getUsersPaginated(offset: number, limit: number, search?: string, filters?: UserFilters) {
    const conditions: string[] = [];
    const params: any[] = [];

    if (search) {
      conditions.push('(email LIKE ? OR name LIKE ?)');
      const like = `%${search}%`;
      params.push(like, like);
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

    const items = Array.from(
      this.sql.exec(`SELECT * FROM users${where} ORDER BY ${sortCol} ${sortDir} LIMIT ? OFFSET ?`, ...params, limit, offset)
    ).map((u: any) => ({
      ...u,
      avatar: { color: u.avatar_color || '#666', content: u.avatar_content || 'U' },
      is_superuser: u.is_superuser === 1,
      is_orphaned: u.is_orphaned === 1,
    }));

    const total = this.sql.exec(`SELECT COUNT(*) as count FROM users${where}`, ...params).next().value?.count || 0;

    return { items, total, offset, limit };
  }

  async getThreadsPaginated(offset: number, limit: number, search?: string, filters?: ThreadFilters) {
    const base = 'SELECT t.*, o.name as org_name, w.name as workspace_name FROM threads t LEFT JOIN orgs o ON t.org_id = o.id LEFT JOIN workspaces w ON t.workspace_id = w.id';
    const countBase = 'SELECT COUNT(*) as count FROM threads t LEFT JOIN orgs o ON t.org_id = o.id LEFT JOIN workspaces w ON t.workspace_id = w.id';
    const conditions: string[] = [];
    const params: any[] = [];

    if (search) {
      conditions.push('(t.title LIKE ? OR o.name LIKE ? OR w.name LIKE ?)');
      const like = `%${search}%`;
      params.push(like, like, like);
    }
    if (filters?.org_id) {
      conditions.push('t.org_id = ?');
      params.push(filters.org_id);
    }
    if (filters?.workspace_id) {
      conditions.push('t.workspace_id = ?');
      params.push(filters.workspace_id);
    }
    if (filters?.created_by) {
      conditions.push('t.created_by = ?');
      params.push(filters.created_by);
    }

    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
    const sortCol = THREAD_SORT_COLS[filters?.sort_by ?? 'updated_at'] ?? 't.updated_at';
    const sortDir = filters?.sort_dir === 'asc' ? 'ASC' : 'DESC';

    const items = Array.from(this.sql.exec(`${base}${where} ORDER BY ${sortCol} ${sortDir} LIMIT ? OFFSET ?`, ...params, limit, offset));
    const total = this.sql.exec(`${countBase}${where}`, ...params).next().value?.count || 0;

    return { items, total, offset, limit };
  }

  async getAllThreads() {
    return Array.from(this.sql.exec('SELECT t.*, o.name as org_name, w.name as workspace_name FROM threads t LEFT JOIN orgs o ON t.org_id = o.id LEFT JOIN workspaces w ON t.workspace_id = w.id ORDER BY t.updated_at DESC'));
  }

  async getAppCount() {
    return this.sql.exec('SELECT COUNT(*) as count FROM apps').next().value?.count || 0;
  }

  async getOrgsPaginated(offset: number, limit: number, search?: string, filters?: OrgFilters) {
    const conditions: string[] = [];
    const params: any[] = [];

    if (search) {
      conditions.push('name LIKE ?');
      params.push(`%${search}%`);
    }
    if (filters?.archived !== undefined) {
      conditions.push('archived = ?');
      params.push(filters.archived ? 1 : 0);
    }

    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
    const sortCol = ORG_SORT_COLS[filters?.sort_by ?? 'created_at'] ?? 'created_at';
    const sortDir = filters?.sort_dir === 'asc' ? 'ASC' : 'DESC';

    const items = Array.from(
      this.sql.exec(`SELECT * FROM orgs${where} ORDER BY ${sortCol} ${sortDir} LIMIT ? OFFSET ?`, ...params, limit, offset)
    ).map((o: any) => ({
      ...o,
      archived: o.archived === 1,
    }));

    const total = this.sql.exec(`SELECT COUNT(*) as count FROM orgs${where}`, ...params).next().value?.count || 0;

    return { items, total, offset, limit };
  }

  async getWorkspacesPaginated(offset: number, limit: number, search?: string, filters?: WorkspaceFilters) {
    const base = 'SELECT w.*, o.name as org_name FROM workspaces w LEFT JOIN orgs o ON w.org_id = o.id';
    const countBase = 'SELECT COUNT(*) as count FROM workspaces w LEFT JOIN orgs o ON w.org_id = o.id';
    const conditions: string[] = [];
    const params: any[] = [];

    if (search) {
      conditions.push('(w.name LIKE ? OR o.name LIKE ?)');
      const like = `%${search}%`;
      params.push(like, like);
    }
    if (filters?.org_id) {
      conditions.push('w.org_id = ?');
      params.push(filters.org_id);
    }
    if (filters?.archived !== undefined) {
      conditions.push('w.archived = ?');
      params.push(filters.archived ? 1 : 0);
    }

    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
    const sortCol = WORKSPACE_SORT_COLS[filters?.sort_by ?? 'created_at'] ?? 'w.created_at';
    const sortDir = filters?.sort_dir === 'asc' ? 'ASC' : 'DESC';

    const items = Array.from(
      this.sql.exec(`${base}${where} ORDER BY ${sortCol} ${sortDir} LIMIT ? OFFSET ?`, ...params, limit, offset)
    ).map((w: any) => ({
      ...w,
      description: w.description ?? null,
      avatar: {
        color: w.avatar_color || '#666',
        content: w.avatar_content || 'W',
      },
      archived: w.archived === 1,
      archived_at: w.archived_at ?? null,
      archived_by: w.archived_by ?? null,
      compute_tier: w.compute_tier ?? 'standard',
    }));

    const total = this.sql.exec(`${countBase}${where}`, ...params).next().value?.count || 0;

    return { items, total, offset, limit };
  }

  async getWorkspacesByOrg(orgId: string) {
    const items = Array.from(
      this.sql.exec(
        `SELECT w.*, o.name as org_name
         FROM workspaces w
         LEFT JOIN orgs o ON w.org_id = o.id
         WHERE w.org_id = ?
         ORDER BY w.created_at DESC`,
        orgId
      )
    ).map((w: any) => ({
      ...w,
      description: w.description ?? null,
      avatar: {
        color: w.avatar_color || '#666',
        content: w.avatar_content || 'W',
      },
      archived: w.archived === 1,
      archived_at: w.archived_at ?? null,
      archived_by: w.archived_by ?? null,
      compute_tier: w.compute_tier ?? 'standard',
    }));

    return items;
  }

  async getAppsPaginated(offset: number, limit: number, search?: string, filters?: AppFilters) {
    const orgSlugExpr = this.getOrgSlugSelectExpression();
    const base = `SELECT a.*, o.name as org_name, ${orgSlugExpr} as org_slug, w.name as workspace_name, u.name as created_by_name, u.email as created_by_email FROM apps a LEFT JOIN orgs o ON a.org_id = o.id LEFT JOIN workspaces w ON a.workspace_id = w.id LEFT JOIN users u ON a.created_by = u.id`;
    const countBase = 'SELECT COUNT(*) as count FROM apps a LEFT JOIN orgs o ON a.org_id = o.id LEFT JOIN workspaces w ON a.workspace_id = w.id LEFT JOIN users u ON a.created_by = u.id';
    const conditions: string[] = [];
    const params: any[] = [];

    if (search) {
      conditions.push('(a.script_name LIKE ? OR o.name LIKE ? OR w.name LIKE ? OR u.name LIKE ? OR u.email LIKE ?)');
      const like = `%${search}%`;
      params.push(like, like, like, like, like);
    }
    if (filters?.org_id) {
      conditions.push('a.org_id = ?');
      params.push(filters.org_id);
    }
    if (filters?.workspace_id) {
      conditions.push('a.workspace_id = ?');
      params.push(filters.workspace_id);
    }
    if (filters?.is_public !== undefined) {
      conditions.push('a.is_public = ?');
      params.push(filters.is_public ? 1 : 0);
    }

    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
    const sortCol = APP_SORT_COLS[filters?.sort_by ?? 'updated_at'] ?? 'a.updated_at';
    const sortDir = filters?.sort_dir === 'asc' ? 'ASC' : 'DESC';

    const items = Array.from(
      this.sql.exec(`${base}${where} ORDER BY ${sortCol} ${sortDir} LIMIT ? OFFSET ?`, ...params, limit, offset)
    ).map((a: any) => ({
      ...a,
      is_public: a.is_public === 1,
    }));

    const total = this.sql.exec(`${countBase}${where}`, ...params).next().value?.count || 0;

    return { items, total, offset, limit };
  }

  async getOrgById(orgId: string) {
    const row = this.sql.exec(
      'SELECT * FROM orgs WHERE id = ? LIMIT 1',
      orgId
    ).toArray()[0] as any;
    if (!row) return null;
    return {
      ...row,
      archived: row.archived === 1,
    };
  }

  async getThreadContextById(threadId: string) {
    const row = this.sql.exec(
      `SELECT t.*, o.name as org_name, w.name as workspace_name
       FROM threads t
       LEFT JOIN orgs o ON t.org_id = o.id
       LEFT JOIN workspaces w ON t.workspace_id = w.id
       WHERE t.id = ?
       LIMIT 1`,
      threadId
    ).toArray()[0] as any;

    return row || null;
  }

  async getOrgRecentThreads(orgId: string, limit = 10) {
    const resolvedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    return Array.from(
      this.sql.exec(
        `SELECT t.*, o.name as org_name, w.name as workspace_name
         FROM threads t
         LEFT JOIN orgs o ON t.org_id = o.id
         LEFT JOIN workspaces w ON t.workspace_id = w.id
         WHERE t.org_id = ?
         ORDER BY t.updated_at DESC
         LIMIT ?`,
        orgId,
        resolvedLimit
      )
    );
  }

  async getOrgRecentApps(orgId: string, limit = 10) {
    const resolvedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const orgSlugExpr = this.getOrgSlugSelectExpression();
    return Array.from(
      this.sql.exec(
        `SELECT a.*, o.name as org_name, ${orgSlugExpr} as org_slug, w.name as workspace_name, u.name as created_by_name, u.email as created_by_email
         FROM apps a
         LEFT JOIN orgs o ON a.org_id = o.id
         LEFT JOIN workspaces w ON a.workspace_id = w.id
         LEFT JOIN users u ON a.created_by = u.id
         WHERE a.org_id = ?
         ORDER BY a.updated_at DESC
         LIMIT ?`,
        orgId,
        resolvedLimit
      )
    ).map((a: any) => ({
      ...a,
      is_public: a.is_public === 1,
    }));
  }

  async getOrgThreadCount(orgId: string) {
    return this.sql.exec(
      'SELECT COUNT(*) as count FROM threads WHERE org_id = ?',
      orgId
    ).next().value?.count || 0;
  }

  async getOrgAppCount(orgId: string) {
    return this.sql.exec(
      'SELECT COUNT(*) as count FROM apps WHERE org_id = ?',
      orgId
    ).next().value?.count || 0;
  }

  async getOrgRecentActivity(
    orgId: string,
    threadLimit = 10,
    appLimit = 10,
    includeCounts = true
  ) {
    const [threads, apps, threadCount, appCount] = await Promise.all([
      this.getOrgRecentThreads(orgId, threadLimit),
      this.getOrgRecentApps(orgId, appLimit),
      includeCounts ? this.getOrgThreadCount(orgId) : Promise.resolve(null),
      includeCounts ? this.getOrgAppCount(orgId) : Promise.resolve(null),
    ]);

    return {
      threads,
      apps,
      threadCount,
      appCount,
    };
  }

  async getInvitationsPaginated(offset: number, limit: number, search?: string) {
    const now = Date.now();
    let query = 'SELECT i.*, o.name as org_name, u.name as invited_by_name, u.email as invited_by_email FROM invitations i LEFT JOIN orgs o ON i.org_id = o.id LEFT JOIN users u ON i.invited_by = u.id WHERE i.expires_at > ?';
    const params: any[] = [now];
    if (search) {
      query += ' AND (i.email LIKE ? OR o.name LIKE ? OR u.name LIKE ? OR u.email LIKE ?)';
      const like = `%${search}%`;
      params.push(like, like, like, like);
    }
    query += ' ORDER BY i.created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const items = Array.from(this.sql.exec(query, ...params));

    let countQuery = 'SELECT COUNT(*) as count FROM invitations i LEFT JOIN orgs o ON i.org_id = o.id LEFT JOIN users u ON i.invited_by = u.id WHERE i.expires_at > ?';
    const countParams: any[] = [now];
    if (search) {
      countQuery += ' AND (i.email LIKE ? OR o.name LIKE ? OR u.name LIKE ? OR u.email LIKE ?)';
      const like = `%${search}%`;
      countParams.push(like, like, like, like);
    }
    const total = this.sql.exec(countQuery, ...countParams).next().value?.count || 0;

    return { items, total, offset, limit };
  }
}
