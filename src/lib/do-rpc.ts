import type { DoRpcService } from '../../workers/main/src/rpc-service';

type RpcDisposable = DoRpcService & { [Symbol.dispose]?: () => void };

export async function withDoRpc<T>(
  rpc: DoRpcService,
  fn: (rpc: DoRpcService) => Promise<T>
): Promise<T> {
  const disposable = rpc as RpcDisposable;
  try {
    return await fn(rpc);
  } finally {
    disposable[Symbol.dispose]?.();
  }
}
