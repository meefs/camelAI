import { WorkerEntrypoint } from 'cloudflare:workers';
import type { CodeModeToolsProps } from './chat-thread-do.js';
import {
  buildWorkspaceAppHostIndex,
  performSecureFetch,
  type SecureFetchEnv,
  type WorkspaceAppHostIndex,
} from './secure-fetch.js';

export type SecureFetchBindingProps = Pick<CodeModeToolsProps, 'orgId' | 'workspaceId'>;

/**
 * Virtual binding used by js_exec and deterministic automations to fetch
 * workspace deployed apps via the WfP dispatch namespace.
 */
export class SecureFetchBinding extends WorkerEntrypoint<
  SecureFetchEnv,
  SecureFetchBindingProps
> {
  private hostIndexPromise?: Promise<WorkspaceAppHostIndex>;

  private get context(): SecureFetchBindingProps {
    return this.ctx.props;
  }

  private getHostIndex(): Promise<WorkspaceAppHostIndex> {
    if (!this.hostIndexPromise) {
      this.hostIndexPromise = buildWorkspaceAppHostIndex(this.env, this.context);
    }
    return this.hostIndexPromise;
  }

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    return performSecureFetch(this.env, this.context, input, init, {
      getHostIndex: () => this.getHostIndex(),
    });
  }
}
