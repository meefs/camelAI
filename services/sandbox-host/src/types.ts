export interface ContainerRecord {
  name: string;
  containerId: string;
  hostPort: number;
  containerIp?: string;
  status: 'running' | 'stopped' | 'unknown';
  createdAt: number;
  lastAccessedAt: number;
  activeWebSockets: number;
  inFlightProxyRequests?: number;
  orgId?: string;
  workspaceId?: string;
}

export interface ExecResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface FsEntry {
  name: string;
  type: 'file' | 'directory';
  size: number;
  modifiedAt: string;
}

export interface FsExistsResult {
  exists: boolean;
  isFile?: boolean;
  isDirectory?: boolean;
  size?: number;
  modifiedAt?: string;
}
