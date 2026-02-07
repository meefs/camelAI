/**
 * R2VirtualBucket - WorkerEntrypoint that provides workspace-scoped R2 storage.
 *
 * During deploy, any `r2_bucket` bindings declared by the user are transparently
 * replaced with service bindings pointing to this entrypoint. Each binding
 * carries `props: { workspaceId, bucketName }` and all R2 keys are prefixed
 * with `user-data/{workspaceId}/{bucketName}/` for tenant isolation.
 *
 * User workers declare R2 buckets normally and use them like:
 *   const obj = await env.MY_BUCKET.get('myfile.json');
 *   await env.MY_BUCKET.put('data.json', JSON.stringify(data));
 */

import { WorkerEntrypoint } from 'cloudflare:workers';

interface R2VirtualBucketEnv {
  R2_BUCKET: R2Bucket;
}

interface R2VirtualBucketProps {
  workspaceId: string;
  bucketName: string;
}

/** Metadata returned for stored objects (plain serializable, not R2Object). */
export interface StorageObjectMetadata {
  key: string;
  version: string;
  size: number;
  etag: string;
  httpEtag: string;
  uploaded: string; // ISO date
  httpMetadata?: R2HTTPMetadata;
  customMetadata?: Record<string, string>;
}

/** Result from list operations. */
export interface StorageListResult {
  objects: StorageObjectMetadata[];
  truncated: boolean;
  cursor?: string;
  delimitedPrefixes: string[];
}

/** Options for put operations. */
export interface StoragePutOptions {
  httpMetadata?: R2HTTPMetadata;
  customMetadata?: Record<string, string>;
}

/** Options for list operations. */
export interface StorageListOptions {
  prefix?: string;
  limit?: number;
  cursor?: string;
  delimiter?: string;
  include?: ('httpMetadata' | 'customMetadata')[];
}

/** Result from creating a multipart upload. */
export interface StorageMultipartUpload {
  key: string;
  uploadId: string;
}

/** An uploaded part reference. */
export interface StorageUploadedPart {
  partNumber: number;
  etag: string;
}

const KEY_PREFIX = 'user-data';

export class R2VirtualBucket extends WorkerEntrypoint<R2VirtualBucketEnv, R2VirtualBucketProps> {
  private get workspaceId(): string {
    return this.ctx.props.workspaceId;
  }

  private get bucketName(): string {
    return this.ctx.props.bucketName;
  }

  private get bucket(): R2Bucket {
    return this.env.R2_BUCKET;
  }

  /** Full prefix for this workspace + bucket. */
  private get scopePrefix(): string {
    return `${KEY_PREFIX}/${this.workspaceId}/${this.bucketName}/`;
  }

  /** Prefix a user-provided key with the workspace + bucket scope. */
  private scopedKey(key: string): string {
    this.validateKey(key);
    return `${this.scopePrefix}${key}`;
  }

  /** Strip the workspace + bucket prefix from an R2 key to return the user-facing key. */
  private unscopedKey(fullKey: string): string {
    if (fullKey.startsWith(this.scopePrefix)) {
      return fullKey.slice(this.scopePrefix.length);
    }
    return fullKey;
  }

  /** Validate a key to prevent path traversal and other abuse. */
  private validateKey(key: string): void {
    if (key.includes('..')) {
      throw new Error('Invalid key: path traversal ("..") is not allowed');
    }
    if (key.startsWith('/')) {
      throw new Error('Invalid key: must not start with "/"');
    }
    if (key.length === 0) {
      throw new Error('Invalid key: must not be empty');
    }
    if (key.length > 1024) {
      throw new Error('Invalid key: exceeds maximum length of 1024 characters');
    }
  }

  /** Convert an R2Object to a plain serializable metadata object. */
  private toMetadata(obj: R2Object): StorageObjectMetadata {
    return {
      key: this.unscopedKey(obj.key),
      version: obj.version,
      size: obj.size,
      etag: obj.etag,
      httpEtag: obj.httpEtag,
      uploaded: obj.uploaded.toISOString(),
      httpMetadata: obj.httpMetadata,
      customMetadata: obj.customMetadata,
    };
  }

  // =========================================================================
  // Public API
  // =========================================================================

  /** Get object metadata without the body. */
  async head(key: string): Promise<StorageObjectMetadata | null> {
    const obj = await this.bucket.head(this.scopedKey(key));
    return obj ? this.toMetadata(obj) : null;
  }

  /**
   * Get an object. Returns a Response with the body stream and metadata in
   * headers — Response is an Rpc.BaseType so it crosses the RPC boundary.
   */
  async get(key: string): Promise<Response | null> {
    const obj = await this.bucket.get(this.scopedKey(key));
    if (!obj) return null;

    const headers = new Headers();
    headers.set('x-r2-key', this.unscopedKey(obj.key));
    headers.set('x-r2-version', obj.version);
    headers.set('x-r2-size', String(obj.size));
    headers.set('x-r2-etag', obj.etag);
    headers.set('x-r2-http-etag', obj.httpEtag);
    headers.set('x-r2-uploaded', obj.uploaded.toISOString());
    if (obj.httpMetadata?.contentType) {
      headers.set('content-type', obj.httpMetadata.contentType);
    }
    if (obj.customMetadata) {
      headers.set('x-r2-custom-metadata', JSON.stringify(obj.customMetadata));
    }

    return new Response(obj.body, { headers });
  }

  /** Store an object. Accepts ReadableStream, ArrayBuffer, string, or null. */
  async put(
    key: string,
    value: ReadableStream | ArrayBuffer | string | null,
    options?: StoragePutOptions
  ): Promise<StorageObjectMetadata> {
    const obj = await this.bucket.put(this.scopedKey(key), value, {
      httpMetadata: options?.httpMetadata,
      customMetadata: options?.customMetadata,
    });
    return this.toMetadata(obj);
  }

  /** Delete one or more objects. */
  async delete(keys: string | string[]): Promise<void> {
    const keyArray = Array.isArray(keys) ? keys : [keys];
    const scopedKeys = keyArray.map(k => this.scopedKey(k));
    await this.bucket.delete(scopedKeys);
  }

  /** List objects with workspace+bucket-scoped prefix. User prefixes are relative. */
  async list(options?: StorageListOptions): Promise<StorageListResult> {
    const sp = this.scopePrefix;
    const fullPrefix = options?.prefix ? `${sp}${options.prefix}` : sp;

    const result = await this.bucket.list({
      prefix: fullPrefix,
      limit: options?.limit,
      cursor: options?.cursor,
      delimiter: options?.delimiter,
      include: options?.include,
    });

    return {
      objects: result.objects.map(obj => this.toMetadata(obj)),
      truncated: result.truncated,
      cursor: result.truncated ? result.cursor : undefined,
      delimitedPrefixes: result.delimitedPrefixes.map(p =>
        p.startsWith(sp) ? p.slice(sp.length) : p
      ),
    };
  }

  // =========================================================================
  // Multipart Upload
  // =========================================================================

  /** Create a new multipart upload. */
  async createMultipartUpload(
    key: string,
    options?: StoragePutOptions
  ): Promise<StorageMultipartUpload> {
    const upload = await this.bucket.createMultipartUpload(this.scopedKey(key), {
      httpMetadata: options?.httpMetadata,
      customMetadata: options?.customMetadata,
    });
    return { key, uploadId: upload.uploadId };
  }

  /** Upload a part of a multipart upload. */
  async uploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    value: ReadableStream | ArrayBuffer | string
  ): Promise<StorageUploadedPart> {
    const upload = this.bucket.resumeMultipartUpload(this.scopedKey(key), uploadId);
    const part = await upload.uploadPart(partNumber, value);
    return { partNumber: part.partNumber, etag: part.etag };
  }

  /** Complete a multipart upload. */
  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: StorageUploadedPart[]
  ): Promise<StorageObjectMetadata> {
    const upload = this.bucket.resumeMultipartUpload(this.scopedKey(key), uploadId);
    const obj = await upload.complete(parts);
    return this.toMetadata(obj);
  }

  /** Abort a multipart upload. */
  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    const upload = this.bucket.resumeMultipartUpload(this.scopedKey(key), uploadId);
    await upload.abort();
  }
}
