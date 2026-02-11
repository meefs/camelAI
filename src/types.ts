export interface Thread {
  id: string;
  workspace_id: string;
  title: string;
  created_by: string;
  created_at: number;
  updated_at: number;
  user_message_count: number;
  first_user_message?: string | null;
  creator?: User;
}

export type PreviewTarget =
  | {
      kind: 'app';
      scriptName: string;
      isPublic: boolean;
    }
  | {
      kind: 'file';
      source: 'workspace' | 'upload' | 'output';
      workspaceId: string;
      path: string;
      filename?: string;
      contentType?: string;
    };

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
  /** Marks a Task progress update (not the final Task result). */
  isTaskUpdate?: boolean;
}

export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
}

export interface TeammateMessageBlock {
  type: 'teammate_message';
  teammateId: string;
  content: string;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | ThinkingBlock | TeammateMessageBlock;

export interface Message {
  id: string;
  thread_id: string;
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
  created_at: number;
  isStreaming?: boolean;
  /** True if this user message was sent while assistant was streaming */
  sentDuringStreaming?: boolean;
  /** @internal Block offset for streaming, cleared when done */
  _blockOffset?: number;
  /** Indicates this is a meta message (e.g., skill sheet), not a real user message */
  isMeta?: boolean;
  /** Links meta message to the originating tool_use block */
  sourceToolUseID?: string;
  /** True when this message is a compaction summary (system-generated context recap) */
  isCompactSummary?: boolean;
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
// TODO: Viewer role (deferred): Members with viewer access can view any apps that are
// private to the workspace, including apps that are not published publicly. This is
// designed for enterprise use cases where a company wants to share internal apps within
// the org without making them public. Viewers can view apps but cannot: create apps,
// use chat, access the computer tab, manage team settings, or perform any write
// operations. They are read-only consumers of workspace output.
export type OrgRole = 'owner' | 'admin' | 'member' | 'viewer';
export type WorkspaceAccessLevel = 'full' | 'none';
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
  orphaned_at: number | null;
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
  slug: string;
  created_at: number;
  created_by: string;
  billing_status: BillingStatus;
  archived: boolean;
  archived_at: number | null;
  archived_by: string | null;
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
  archived_at: number | null;
  archived_by: string | null;
  compute_tier: 'standard';
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

export type OnboardingAiFamiliarity =
  | 'extensive'
  | 'occasional'
  | 'a_little'
  | 'new';
export type OnboardingIterationStyle = 'show_quick' | 'ask_first' | 'depends';
export type OnboardingStakes =
  | 'trying_out'
  | 'for_myself'
  | 'for_team'
  | 'for_public'
  | 'for_money';
export type OnboardingDesignStyle =
  | 'colorful'
  | 'sleek'
  | 'minimal'
  | 'warm'
  | 'bold'
  | 'per_project';
export type OnboardingStarterProject =
  | 'data_analytics'
  | 'personal_site'
  | 'business_tool'
  | 'team_productivity'
  | 'something_fun';
export type OnboardingFileType = 'csv' | 'excel' | 'sqlite' | 'json';

export interface OnboardingPreferences {
  ai_familiarity: OnboardingAiFamiliarity | null;
  iteration_style: OnboardingIterationStyle | null;
  stakes: OnboardingStakes | null;
  design_style: OnboardingDesignStyle | null;
  starter_project: OnboardingStarterProject | null;
  data_interests: {
    files: OnboardingFileType[];
    integrations: string[];
  };
  completed_at: number | null;
}

// Auth context types for frontend
export interface AuthState {
  user: User | null;
  currentOrg: Organization | null;
  currentWorkspace?: WorkspaceWithAccess | null;
  orgs: OrgMembership[];
  onboarding?: OnboardingPreferences | null;
  /** Workspaces in the current org only (for settings/management) */
  workspaces?: WorkspaceWithAccess[];
  /** All workspaces across all orgs (for workspace switcher) */
  allWorkspaces?: WorkspaceWithAccess[];
  /** Total workspaces in org (includes ones user may not have access to) */
  orgWorkspaceCount?: number;
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
  avatar: Avatar;
  is_orphaned: boolean;
}

export interface AdminOverview {
  users: AdminUserSummary[];
  total_users: number;
  total_orgs: number;
  total_memberships: number;
  total_workspaces: number;
  total_integrations: number;
  orphaned_users: number;
}

export interface AdminWorkspaceSummary extends Workspace {
  org_id: string;
  org_name: string;
  thread_count: number;
  integration_count: number;
}

export interface AdminWorkspaceDetail {
  workspace: Workspace;
  org: Organization;
  threads: Thread[];
  integrations: Integration[];
  members: WorkspaceMember[];
}

export interface AdminThreadWithContext extends Thread {
  org_id: string;
  org_name: string;
  workspace_id: string;
  workspace_name: string;
}

export interface AdminAppSummary {
  script_name: string;
  workspace_id: string;
  workspace_name: string;
  org_id: string;
  org_name: string;
  created_by: string;
  created_by_name: string | null;
  created_by_email: string | null;
  created_at: number;
  updated_at: number;
  is_public: boolean;
  preview_status: AppPreviewStatus | null;
  preview_error: string | null;
}

export type AdminAppDetail = AdminAppSummary;

export interface AdminInvitation {
  id: string;
  email: string;
  role: OrgRole;
  org_id: string;
  org_name: string;
  invited_by: string;
  inviter_email: string;
  inviter_name: string | null;
  created_at: number;
  expires_at: number;
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
  search?: string;
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
}

// API Token types
export interface CreateApiTokenInput {
  name: string;
  integration_id?: string; // scope to specific integration
  scopes?: string[]; // defaults to ['proxy']
  expires_in_days?: number; // null = never expires
}

// Worker/App types
export type AppPreviewStatus = 'pending' | 'ready' | 'failed';

export interface WorkerScript {
  script_name: string;
  workspace_id: string;
  created_by: string;
  created_at: number;
  updated_at: number;
  is_public: boolean;
  preview_key: string | null;
  preview_updated_at: number | null;
  preview_status: AppPreviewStatus | null;
  preview_error: string | null;
  config_path: string | null;
}

export interface AppCreator {
  id: string;
  name: string | null;
  email: string | null;
  avatar: Avatar | null;
}

export interface WorkerScriptWithCreator extends WorkerScript {
  creator?: AppCreator;
}
