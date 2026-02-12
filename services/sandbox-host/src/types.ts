export interface ContainerRecord {
  name: string;
  containerId: string;
  hostPort: number;
  status: 'running' | 'stopped' | 'unknown';
  createdAt: number;
  lastAccessedAt: number;
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
