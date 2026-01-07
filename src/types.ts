export interface Thread {
  id: string;
  title: string;
  created_by: string;
  created_at: number;
  updated_at: number;
  creator?: User;
}

// Content block types for structured message content
export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | ContentBlock[];
}

export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | ThinkingBlock;

export interface Message {
  id: string;
  thread_id: string;
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
  created_at: number;
  isStreaming?: boolean;
  /** @internal Block offset for streaming, cleared when done */
  _blockOffset?: number;
}

export interface SandboxFileInfo {
  name: string;
  absolutePath: string;
  relativePath: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  size: number;
  modifiedAt: string;
}

export interface SandboxFileListing {
  path: string;
  files: SandboxFileInfo[];
  count: number;
  timestamp: string;
}

export interface WorkspaceFileEntry {
  path: string;
  name: string;
  type: SandboxFileInfo['type'];
  size: number;
  modifiedAt: string;
}

export interface WorkspaceListResponse {
  path: string;
  entries: WorkspaceFileEntry[];
  count: number;
  timestamp: string;
  recursive: boolean;
}

export interface WorkspaceFileRead {
  path: string;
  content: string;
  version: string;
  size: number | null;
  mtime: string | null;
  isBinary: boolean;
  encoding: 'utf-8' | 'base64';
  mimeType?: string | null;
}

export interface WorkspaceFileWrite {
  path: string;
  newVersion: string;
  size: number | null;
  mtime: string | null;
}

export interface WorkspaceOperationResult {
  path: string;
  timestamp: string;
}

// Auth types
export type OrgRole = 'owner' | 'admin' | 'member' | 'viewer';
export type WorkspaceAccessLevel = 'full' | 'read_only' | 'none';
export type BillingStatus = 'free' | 'paying';

export interface Avatar {
  color: string;
  content: string;
}

export interface User {
  id: string;
  email: string;
  name: string | null;
  created_at: number;
  is_superuser: boolean;
  avatar: Avatar;
  is_orphaned: boolean;
}

export interface Session {
  id: string;
  user_id: string;
  org_id: string;
  workspace_id: string | null;
  created_at: number;
  expires_at: number;
}

export interface Organization {
  id: string;
  name: string;
  created_at: number;
  created_by: string;
  billing_status: BillingStatus;
  archived: boolean;
  archived_at?: number | null;
}

export interface OrgMembership {
  org_id: string;
  org_name: string;
  role: OrgRole;
  joined_at: number;
  last_workspace_id?: string | null;
}

export interface Invitation {
  id: string;
  org_id: string;
  org_name: string;
  email: string;
  role: OrgRole;
  invited_by: string;
  created_at: number;
  expires_at: number;
}

export interface Workspace {
  id: string;
  org_id: string;
  name: string;
  description: string | null;
  created_by: string;
  created_at: number;
  avatar: Avatar;
  archived: boolean;
  archived_at?: number | null;
}

export interface WorkspaceWithAccess extends Workspace {
  access_level: WorkspaceAccessLevel;
}

export interface WorkspaceMember {
  user_id: string;
  access_level: WorkspaceAccessLevel;
  granted_by: string;
  granted_at: number;
}

export interface AuditLogEntry {
  id: string;
  action: string;
  actor_id: string;
  target_id: string | null;
  details: Record<string, unknown> | null;
  created_at: number;
}

// Auth context types for frontend
export interface AuthState {
  user: User | null;
  currentOrg: Organization | null;
  currentWorkspace?: WorkspaceWithAccess | null;
  orgs: OrgMembership[];
  workspaces?: WorkspaceWithAccess[];
  loading: boolean;
  error: string | null;
}

export interface AdminUserSummary {
  id: string;
  email: string;
  name: string | null;
  created_at: number;
  is_superuser: boolean;
  org_count: number;
}

export interface AdminOverview {
  users: AdminUserSummary[];
  total_users: number;
  total_orgs: number;
  total_memberships: number;
}

// Paginated result types for admin lists
export interface PaginatedResult<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}

export interface PaginationParams {
  offset?: number;
  limit?: number;
}

// Integration types
export type IntegrationCategory =
  | 'databases'
  | 'saas'
  | 'ai_services'
  | 'cloud_providers'
  | 'communication';

export type IntegrationAuthMethod = 'oauth2' | 'api_key';

export interface Integration {
  id: string;
  integration_type: string;
  name: string;
  category: IntegrationCategory;
  auth_method: IntegrationAuthMethod;
  config: Record<string, unknown>;
  enabled: boolean;
  created_by: string;
  created_at: number;
  updated_at: number;
  has_credentials: boolean;
}

export interface CreateIntegrationInput {
  integration_type: string;
  name: string;
  config: Record<string, unknown>;
  credentials: Record<string, unknown>;
}

export interface UpdateIntegrationInput {
  name?: string;
  config?: Record<string, unknown>;
  credentials?: Record<string, unknown>;
  enabled?: boolean;
}

// API Token types
export interface CreateApiTokenInput {
  name: string;
  integration_id?: string; // scope to specific integration
  scopes?: string[]; // defaults to ['proxy']
  expires_in_days?: number; // null = never expires
}
