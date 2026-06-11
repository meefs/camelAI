import { describe, expect, it, vi } from 'vitest';
import { R2VirtualBucket } from '../src/r2-virtual-bucket.js';

function checksumStub(): R2Checksums {
  return {
    toJSON: () => ({}),
  } as R2Checksums;
}

function makeR2Object(key: string, value: string): R2ObjectBody {
  const response = new Response(value, {
    headers: { 'content-type': 'application/json' },
  });
  return {
    key,
    version: 'version-1',
    size: value.length,
    etag: 'etag-1',
    httpEtag: '"etag-1"',
    checksums: checksumStub(),
    uploaded: new Date('2026-05-08T12:00:00.000Z'),
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { owner: 'test' },
    storageClass: 'Standard',
    get body() {
      return response.body as ReadableStream;
    },
    get bodyUsed() {
      return response.bodyUsed;
    },
    writeHttpMetadata(headers: Headers) {
      headers.set('content-type', 'application/json');
    },
    arrayBuffer: () => response.arrayBuffer(),
    bytes: async () => new Uint8Array(await response.arrayBuffer()),
    text: () => response.text(),
    json: <T>() => response.json() as Promise<T>,
    blob: () => response.blob(),
  } as R2ObjectBody;
}

function makeService(bucket: Partial<R2Bucket>): R2VirtualBucket {
  return new R2VirtualBucket(
    {
      props: { workspaceId: 'ws_123', bucketName: 'uploads' },
    } as unknown as ExecutionContext,
    { R2_BUCKET: bucket as R2Bucket },
  );
}

describe('R2VirtualBucket', () => {
  it('returns an R2ObjectBody-like object from get instead of a Response', async () => {
    const get = vi
      .fn()
      .mockResolvedValue(
        makeR2Object('user-data/ws_123/uploads/profile.json', '{"ok":true}'),
      );
    const service = makeService({ get });

    const result = await service.get('profile.json');

    expect(get).toHaveBeenCalledWith(
      'user-data/ws_123/uploads/profile.json',
      undefined,
    );
    expect(result).not.toBeInstanceOf(Response);
    expect(result?.key).toBe('profile.json');
    expect(result?.uploaded).toEqual(new Date('2026-05-08T12:00:00.000Z'));
    expect('text' in result!).toBe(true);
    expect(await result!.text()).toBe('{"ok":true}');
    expect(result!.bodyUsed).toBe(true);
  });

  it('supports native R2ObjectBody json and bytes readers', async () => {
    const service = makeService({
      get: vi
        .fn()
        .mockResolvedValue(
          makeR2Object('user-data/ws_123/uploads/data.json', '{"count":2}'),
        ),
    });

    const jsonResult = await service.get('data.json');
    expect(await jsonResult!.json<{ count: number }>()).toEqual({ count: 2 });

    const byteService = makeService({
      get: vi
        .fn()
        .mockResolvedValue(makeR2Object('user-data/ws_123/uploads/raw.txt', 'abc')),
    });
    const byteResult = await byteService.get('raw.txt');
    expect(Array.from(await byteResult!.bytes())).toEqual([97, 98, 99]);
  });

  it('keeps reader methods usable when the body stream is serialized separately', async () => {
    const service = makeService({
      get: vi
        .fn()
        .mockResolvedValue(makeR2Object('user-data/ws_123/uploads/raw.txt', 'abc')),
    });

    const result = await service.get('raw.txt');
    expect(await new Response(result!.body).text()).toBe('abc');
    expect(await result!.text()).toBe('abc');
  });

  it('passes get options through to the backing R2 bucket', async () => {
    const get = vi.fn().mockResolvedValue(null);
    const service = makeService({ get });
    const options: R2GetOptions = {
      onlyIf: { etagMatches: 'etag-1' },
      range: { offset: 1, length: 3 },
    };

    await service.get('profile.json', options);

    expect(get).toHaveBeenCalledWith(
      'user-data/ws_123/uploads/profile.json',
      options,
    );
  });

  it('unscopes metadata returned by list', async () => {
    const service = makeService({
      list: vi.fn().mockResolvedValue({
        objects: [makeR2Object('user-data/ws_123/uploads/nested/file.txt', 'x')],
        truncated: false,
        cursor: undefined,
        delimitedPrefixes: ['user-data/ws_123/uploads/nested/'],
      }),
    });

    const result = await service.list({ prefix: 'nested/' });

    expect(result.objects[0]?.key).toBe('nested/file.txt');
    expect(result.delimitedPrefixes).toEqual(['nested/']);
  });

  it('rejects traversal keys before reaching the backing bucket', async () => {
    const get = vi.fn();
    const service = makeService({ get });

    await expect(service.get('../secret')).rejects.toThrow('path traversal');
    expect(get).not.toHaveBeenCalled();
  });
});
