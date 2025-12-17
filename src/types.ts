export interface Thread {
  id: string;
  title: string;
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
