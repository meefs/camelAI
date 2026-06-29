import {
  mapVirtualizedBindings,
  validateBindings,
  type DeploySideEffectsInfo,
  type WorkerBinding,
} from "./cf-api-proxy.js";
import {
  normalizeSelfhostAssetPath,
  selfhostAssetObjectKey,
  selfhostAssetsKey,
  type SelfhostAssetsRecord,
} from "./selfhost-assets-registry.js";

export interface DirectDispatchDeployEnv {
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  CF_DISPATCH_NAMESPACE?: string;
  CF_WORKER_NAME?: string;
  APP_KV?: KVNamespace;
  R2_BUCKET?: R2Bucket;
}

export interface DirectDispatchDeployIdentity {
  orgId: string;
  orgSlug: string;
  workspaceId: string;
  userId?: string;
  threadId?: string;
  projectId?: string;
}

export interface DirectWorkerMetadata {
  main_module: string;
  bindings?: WorkerBinding[];
  compatibility_date?: string;
  compatibility_flags?: string[];
  config_path?: string;
  [key: string]: unknown;
}

export interface DirectWorkerModule {
  name: string;
  contentType: string;
  content: string | Uint8Array | ArrayBuffer;
}

export interface DirectDispatchDeployRequest {
  scriptName: string;
  hostname: string;
  identity: DirectDispatchDeployIdentity;
  metadata: DirectWorkerMetadata;
  modules: DirectWorkerModule[];
  assets?: Array<{ path: string; content: Uint8Array; contentType?: string }>;
  commitSha?: string;
}

export interface DirectDispatchDeployResult {
  success: boolean;
  scriptName: string;
  dispatchScriptName: string;
  status: number;
  result?: unknown;
  error?: string;
  sideEffects: DeploySideEffectsInfo;
}

export interface DirectDeployRollbackRequest {
  artifactCacheKey: string;
  hostname: string;
  expected?: {
    orgId?: string;
    workspaceId?: string;
    scriptName?: string;
  };
  threadId?: string;
}

export interface DirectDeployArtifactCacheRecord {
  schemaVersion: 1;
  createdAt: string;
  scriptName: string;
  dispatchScriptName: string;
  identity: DirectDispatchDeployIdentity;
  metadata: DirectWorkerMetadata;
  modules: Array<{ name: string; contentType: string; contentBase64: string }>;
  assetsRecord: SelfhostAssetsRecord | null;
}

export async function deployWorkerModulesDirect(
  env: DirectDispatchDeployEnv,
  request: DirectDispatchDeployRequest,
  options: { fetcher?: typeof fetch } = {},
): Promise<DirectDispatchDeployResult> {
  const cfApiToken = env.CF_API_TOKEN?.trim();
  const accountId = env.CF_ACCOUNT_ID?.trim();
  const dispatchNamespace = env.CF_DISPATCH_NAMESPACE?.trim();
  const workerServiceName = env.CF_WORKER_NAME?.trim();
  if (!cfApiToken) throw new Error("CF_API_TOKEN is required for direct deploy");
  if (!accountId) throw new Error("CF_ACCOUNT_ID is required for direct deploy");
  if (!dispatchNamespace) throw new Error("CF_DISPATCH_NAMESPACE is required for direct deploy");
  if (!workerServiceName) throw new Error("CF_WORKER_NAME is required for direct deploy");
  if (!request.modules.some((module) => module.name === request.metadata.main_module)) {
    throw new Error(`Direct deploy bundle is missing main module: ${request.metadata.main_module}`);
  }

  const validation = validateBindings(request.metadata.bindings ?? []);
  if (!validation.valid) {
    const forbiddenList = validation.forbiddenBindings.map((binding) => `${binding.name} (${binding.type})`).join(", ");
    throw new Error(`Deploy blocked: forbidden bindings: ${forbiddenList}`);
  }

  const dispatchScriptName = `${request.scriptName}--${request.identity.orgSlug}`;
  const assetsRecord = await storeDirectAssets(env, dispatchScriptName, request);
  const bindings = normalizedDirectBindings(request.metadata);
  const metadata: DirectWorkerMetadata = {
    ...request.metadata,
    assets: undefined,
    bindings: mapVirtualizedBindings(
      bindings,
      request.identity.workspaceId,
      request.identity.orgId,
      request.identity.userId,
      workerServiceName,
      dispatchScriptName,
    ),
  };
  const artifactCacheKey = await storeDeployArtifactCache(env, {
    scriptName: request.scriptName,
    dispatchScriptName,
    identity: request.identity,
    metadata,
    modules: request.modules,
    assetsRecord,
  });
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  for (const module of request.modules) {
    form.append(module.name, new Blob([blobPart(module.content)], { type: module.contentType }), module.name);
  }

  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}` +
    `/workers/dispatch/namespaces/${encodeURIComponent(dispatchNamespace)}` +
    `/scripts/${encodeURIComponent(dispatchScriptName)}`;
  const fetcher = options.fetcher ?? fetch;
  const response = await fetcher(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${cfApiToken}` },
    body: form,
  });
  const body = await readJsonOrText(response);
  const sideEffects: DeploySideEffectsInfo = {
    scriptName: request.scriptName,
    dispatchScriptName,
    orgId: request.identity.orgId,
    orgSlug: request.identity.orgSlug,
    workspaceId: request.identity.workspaceId,
    hostname: request.hostname,
    threadId: request.identity.threadId,
    projectId: request.identity.projectId,
    configPath: typeof request.metadata.config_path === "string" ? request.metadata.config_path : undefined,
    commitSha: request.commitSha,
    artifactCacheKey,
  };
  return {
    success: response.ok,
    scriptName: request.scriptName,
    dispatchScriptName,
    status: response.status,
    sideEffects,
    ...(response.ok ? { result: body } : { error: typeof body === "string" ? body : JSON.stringify(body) }),
  };
}

export async function rollbackWorkerDeployFromArtifactCache(
  env: DirectDispatchDeployEnv,
  request: DirectDeployRollbackRequest,
  options: { fetcher?: typeof fetch } = {},
): Promise<DirectDispatchDeployResult> {
  const cfApiToken = env.CF_API_TOKEN?.trim();
  const accountId = env.CF_ACCOUNT_ID?.trim();
  const dispatchNamespace = env.CF_DISPATCH_NAMESPACE?.trim();
  if (!cfApiToken) throw new Error("CF_API_TOKEN is required for direct rollback");
  if (!accountId) throw new Error("CF_ACCOUNT_ID is required for direct rollback");
  if (!dispatchNamespace) throw new Error("CF_DISPATCH_NAMESPACE is required for direct rollback");
  if (!env.R2_BUCKET) throw new Error("R2_BUCKET is required for direct rollback");

  const artifactCacheKey = request.artifactCacheKey.trim();
  if (!artifactCacheKey) throw new Error("artifactCacheKey is required for direct rollback");
  const object = await env.R2_BUCKET.get(artifactCacheKey);
  if (!object) throw new Error(`Deploy artifact cache not found: ${artifactCacheKey}`);
  const record = validateArtifactCacheRecord(JSON.parse(await object.text()), artifactCacheKey);
  if (request.expected?.orgId && record.identity.orgId !== request.expected.orgId) {
    throw new Error("Deploy artifact cache belongs to a different org");
  }
  if (request.expected?.workspaceId && record.identity.workspaceId !== request.expected.workspaceId) {
    throw new Error("Deploy artifact cache belongs to a different workspace");
  }
  if (request.expected?.scriptName && record.scriptName !== request.expected.scriptName) {
    throw new Error("Deploy artifact cache belongs to a different app");
  }

  if (record.assetsRecord) {
    if (!env.APP_KV) throw new Error("APP_KV is required for direct rollback assets");
    await env.APP_KV.put(selfhostAssetsKey(record.dispatchScriptName), JSON.stringify(record.assetsRecord));
  }

  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(record.metadata)], { type: "application/json" }));
  for (const module of record.modules) {
    form.append(
      module.name,
      new Blob([base64ToBytes(module.contentBase64) as BlobPart], { type: module.contentType }),
      module.name,
    );
  }

  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}` +
    `/workers/dispatch/namespaces/${encodeURIComponent(dispatchNamespace)}` +
    `/scripts/${encodeURIComponent(record.dispatchScriptName)}`;
  const fetcher = options.fetcher ?? fetch;
  const response = await fetcher(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${cfApiToken}` },
    body: form,
  });
  const body = await readJsonOrText(response);
  const sideEffects: DeploySideEffectsInfo = {
    scriptName: record.scriptName,
    dispatchScriptName: record.dispatchScriptName,
    orgId: record.identity.orgId,
    orgSlug: record.identity.orgSlug,
    workspaceId: record.identity.workspaceId,
    hostname: request.hostname,
    threadId: request.threadId ?? record.identity.threadId,
    projectId: record.identity.projectId,
    configPath: typeof record.metadata.config_path === "string" ? record.metadata.config_path : undefined,
    artifactCacheKey,
  };
  return {
    success: response.ok,
    scriptName: record.scriptName,
    dispatchScriptName: record.dispatchScriptName,
    status: response.status,
    sideEffects,
    ...(response.ok ? { result: body } : { error: typeof body === "string" ? body : JSON.stringify(body) }),
  };
}

function validateArtifactCacheRecord(value: unknown, key: string): DirectDeployArtifactCacheRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Deploy artifact cache is invalid: ${key}`);
  }
  const record = value as DirectDeployArtifactCacheRecord;
  if (
    record.schemaVersion !== 1 ||
    typeof record.scriptName !== "string" ||
    typeof record.dispatchScriptName !== "string" ||
    !record.identity ||
    typeof record.identity.orgId !== "string" ||
    typeof record.identity.orgSlug !== "string" ||
    typeof record.identity.workspaceId !== "string" ||
    !record.metadata ||
    typeof record.metadata.main_module !== "string" ||
    !Array.isArray(record.modules)
  ) {
    throw new Error(`Deploy artifact cache is invalid: ${key}`);
  }
  for (const module of record.modules) {
    if (!module || typeof module.name !== "string" || typeof module.contentType !== "string" || typeof module.contentBase64 !== "string") {
      throw new Error(`Deploy artifact cache is invalid: ${key}`);
    }
  }
  return record;
}

function normalizedDirectBindings(metadata: DirectWorkerMetadata): WorkerBinding[] {
  const bindings = metadata.bindings ?? [];
  if (!metadata.assets || bindings.some((binding) => binding.type === "assets")) return bindings;
  return [...bindings, { type: "assets", name: assetsBindingName(metadata.assets) }];
}

function assetsBindingName(assets: unknown): string {
  if (assets && typeof assets === "object" && !Array.isArray(assets)) {
    const record = assets as Record<string, unknown>;
    const configured = record.binding ?? record.binding_name ?? record.name;
    if (typeof configured === "string" && configured.trim()) return configured.trim();
  }
  return "ASSETS";
}

async function storeDirectAssets(
  env: DirectDispatchDeployEnv,
  appId: string,
  request: DirectDispatchDeployRequest,
): Promise<SelfhostAssetsRecord | null> {
  const assets = request.assets ?? [];
  const hasAssetsBinding = request.metadata.bindings?.some((binding) => binding.type === "assets") || Boolean(request.metadata.assets);
  if (!hasAssetsBinding && assets.length === 0) return null;
  if (!env.APP_KV) throw new Error("APP_KV is required for direct deploy assets");
  if (assets.length > 0 && !env.R2_BUCKET) throw new Error("R2_BUCKET is required for direct deploy assets");

  const manifest: SelfhostAssetsRecord["manifest"] = {};
  for (const asset of assets) {
    const path = normalizeSelfhostAssetPath(asset.path);
    const hash = await sha256Hex(asset.content);
    if (!env.R2_BUCKET) throw new Error("R2_BUCKET is required for direct deploy assets");
    await env.R2_BUCKET.put(
      selfhostAssetObjectKey(appId, hash),
      asset.content,
      asset.contentType ? { httpMetadata: { contentType: asset.contentType } } : undefined,
    );
    manifest[path] = {
      hash,
      size: asset.content.byteLength,
      ...(asset.contentType ? { contentType: asset.contentType } : {}),
    };
  }

  const record: SelfhostAssetsRecord = {
    schemaVersion: 1 as const,
    appId,
    createdAt: new Date().toISOString(),
    manifest,
  };
  await env.APP_KV.put(selfhostAssetsKey(appId), JSON.stringify(record));
  return record;
}

async function storeDeployArtifactCache(
  env: DirectDispatchDeployEnv,
  input: {
    scriptName: string;
    dispatchScriptName: string;
    identity: DirectDispatchDeployIdentity;
    metadata: DirectWorkerMetadata;
    modules: DirectWorkerModule[];
    assetsRecord: SelfhostAssetsRecord | null;
  },
): Promise<string | undefined> {
  if (!env.R2_BUCKET) return undefined;
  const deterministic = {
    schemaVersion: 1 as const,
    scriptName: input.scriptName,
    dispatchScriptName: input.dispatchScriptName,
    identity: input.identity,
    metadata: input.metadata,
    modules: await Promise.all(input.modules.map(async (module) => ({
      name: module.name,
      contentType: module.contentType,
      contentBase64: bytesToBase64(contentBytes(module.content)),
    }))),
    assetsRecord: input.assetsRecord,
  };
  const encoded = new TextEncoder().encode(JSON.stringify(deterministic));
  const digest = await sha256Hex(encoded);
  const projectSegment = input.identity.projectId ? encodeURIComponent(input.identity.projectId) : "workspace";
  const key = `deploy-artifacts/${encodeURIComponent(input.identity.orgId)}/${encodeURIComponent(input.identity.workspaceId)}/${projectSegment}/${encodeURIComponent(input.dispatchScriptName)}/${digest}.json`;
  const record: DirectDeployArtifactCacheRecord = {
    ...deterministic,
    createdAt: new Date().toISOString(),
  };
  await env.R2_BUCKET.put(key, JSON.stringify(record), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: {
      type: "direct-deploy-artifact-cache",
      orgId: input.identity.orgId,
      workspaceId: input.identity.workspaceId,
      scriptName: input.scriptName,
      dispatchScriptName: input.dispatchScriptName,
      ...(input.identity.projectId ? { projectId: input.identity.projectId } : {}),
    },
  });
  return key;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const content = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", content);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function contentBytes(content: string | Uint8Array | ArrayBuffer): Uint8Array {
  if (typeof content === "string") return new TextEncoder().encode(content);
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  return content;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value.replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function blobPart(content: string | Uint8Array | ArrayBuffer): BlobPart {
  if (typeof content === "string" || content instanceof ArrayBuffer) return content;
  return content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer;
}

async function readJsonOrText(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json().catch(() => null);
  }
  return response.text().catch(() => "");
}
