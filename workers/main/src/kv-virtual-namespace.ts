import { WorkerEntrypoint } from "cloudflare:workers";

interface KVVirtualNamespaceEnv {
  APP_KV: KVNamespace;
}

interface KVVirtualNamespaceProps {
  workspaceId: string;
  appId: string;
  namespaceId: string;
}

type KVGetType = "text" | "json" | "arrayBuffer" | "stream";
type KVGetOptions = KVNamespaceGetOptions<KVGetType> | KVGetType;

const USER_KV_PREFIX = "selfhost:user-kv";

function getType(options?: KVGetOptions): KVGetType {
  if (typeof options === "string") return options;
  return options?.type ?? "text";
}

async function normalizePutValue(
  value: string | ArrayBuffer | ArrayBufferView | ReadableStream | null | Blob,
): Promise<string | ArrayBuffer | ArrayBufferView> {
  if (value === null) return "";
  if (typeof value === "string") return value;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value;
  if (value instanceof Blob) return value.arrayBuffer();
  return new Response(value).arrayBuffer();
}

export class KVVirtualNamespace extends WorkerEntrypoint<KVVirtualNamespaceEnv, KVVirtualNamespaceProps> {
  private get namespaceId(): string {
    return this.ctx.props.namespaceId;
  }

  private scopedKey(key: string): string {
    if (!key) throw new Error("KV key must not be empty");
    return `${USER_KV_PREFIX}/${this.ctx.props.workspaceId}/${this.ctx.props.appId}/${this.namespaceId}/${key}`;
  }

  private scopedPrefix(prefix = ""): string {
    return `${USER_KV_PREFIX}/${this.ctx.props.workspaceId}/${this.ctx.props.appId}/${this.namespaceId}/${prefix}`;
  }

  private unscopedKey(key: string): string {
    const prefix = `${USER_KV_PREFIX}/${this.ctx.props.workspaceId}/${this.ctx.props.appId}/${this.namespaceId}/`;
    return key.startsWith(prefix) ? key.slice(prefix.length) : key;
  }

  async get(key: string, options?: KVGetOptions): Promise<unknown> {
    const type = getType(options);
    return (this.env.APP_KV as any).get(this.scopedKey(key), type);
  }

  async getWithMetadata<Metadata = unknown>(
    key: string,
    options?: KVGetOptions,
  ): Promise<KVNamespaceGetWithMetadataResult<unknown, Metadata>> {
    const type = getType(options);
    return (this.env.APP_KV as any).getWithMetadata(this.scopedKey(key), type);
  }

  async put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView | ReadableStream | null | Blob,
    options?: KVNamespacePutOptions,
  ): Promise<void> {
    await this.env.APP_KV.put(
      this.scopedKey(key),
      await normalizePutValue(value),
      options,
    );
  }

  async delete(keys: string | string[]): Promise<void> {
    if (Array.isArray(keys)) {
      await Promise.all(keys.map((key) => this.env.APP_KV.delete(this.scopedKey(key))));
      return;
    }
    await this.env.APP_KV.delete(this.scopedKey(keys));
  }

  async list<Metadata = unknown>(
    options?: KVNamespaceListOptions,
  ): Promise<KVNamespaceListResult<Metadata>> {
    const prefix = this.scopedPrefix(options?.prefix);
    const result = await this.env.APP_KV.list<Metadata>({
      ...options,
      prefix,
    });
    return {
      ...result,
      keys: result.keys.map((key) => ({
        ...key,
        name: this.unscopedKey(key.name),
      })),
    };
  }
}
