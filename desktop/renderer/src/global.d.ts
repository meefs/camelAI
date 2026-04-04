import type { DesktopClientEvent, DesktopServerEvent, DesktopSnapshot } from '../../shared/protocol';

interface DesktopShellApi {
  platform: string;
  versions: {
    chrome: string;
    electron: string;
    node: string;
  };
  getSnapshot: () => Promise<DesktopSnapshot | null>;
  sendEvent: (event: DesktopClientEvent) => void;
  reportReady: (payload: {
    activeThreadId: string | null;
    provider: DesktopSnapshot['provider'];
    authSource: DesktopSnapshot['auth']['source'];
    hasAuth: boolean;
    runtimeState: DesktopSnapshot['runtimeStatus']['state'];
  }) => void;
  onEvent: (listener: (event: DesktopServerEvent) => void) => () => void;
}

declare global {
  interface Window {
    desktopShell?: DesktopShellApi;
  }
}

export {};
