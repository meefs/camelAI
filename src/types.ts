export interface Thread {
  id: string;
  title: string;
  project_id: string;
  created_by: string;
  created_at: number;
  updated_at: number;
  creator?: User;
}

export interface Project {
  id: string;
  name: string;
  created_by: string;
  created_at: number;
  updated_at: number;
}

export interface Message {
  id: string;
  thread_id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: number;
}

// Auth types
export interface User {
  id: string;
  email: string;
  name: string | null;
  created_at: number;
}

export interface Session {
  id: string;
  user_id: string;
  org_id: string;
  created_at: number;
  expires_at: number;
}

export interface Organization {
  id: string;
  name: string;
  created_at: number;
  created_by: string;
}

export interface OrgMembership {
  org_id: string;
  org_name: string;
  role: 'admin' | 'member';
  joined_at: number;
}

export interface UserProject {
  org_id: string;
  project_id: string;
  created_at: number;
}

export interface Invitation {
  id: string;
  org_id: string;
  org_name: string;
  email: string;
  role: 'admin' | 'member';
  invited_by: string;
  created_at: number;
  expires_at: number;
}

// Auth context types for frontend
export interface AuthState {
  user: User | null;
  currentOrg: Organization | null;
  orgs: OrgMembership[];
  loading: boolean;
  error: string | null;
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
