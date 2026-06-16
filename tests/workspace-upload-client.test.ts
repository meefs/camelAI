import { afterEach, describe, expect, it, vi } from 'vitest';
import { uploadWorkspaceFile } from '@/lib/workspace-upload.client';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function parseAction(input: RequestInfo | URL): { action: string | null; url: URL } {
  const rawUrl = typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;
  const url = new URL(rawUrl, 'https://example.test');
  return { action: url.searchParams.get('action'), url };
}

describe('uploadWorkspaceFile', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('uploads a file through multipart create/uploadpart/complete', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const { action } = parseAction(input);
      if (action === 'mpu-create') {
        return jsonResponse({
          uploadId: 'upload-1',
          filename: 'file-1.txt',
          path: 'uploads/file-1.txt',
        });
      }
      if (action === 'mpu-uploadpart') {
        return jsonResponse({ partNumber: 1, etag: 'etag-1' });
      }
      if (action === 'mpu-complete') {
        return jsonResponse({
          path: 'uploads/file-1.txt',
          filename: 'file-1.txt',
          size: 3,
        });
      }
      throw new Error(`Unexpected action ${action}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const file = new File(['abc'], 'demo.txt', { type: 'text/plain' });
    const result = await uploadWorkspaceFile('ws-1', file);

    expect(result).toMatchObject({
      path: 'uploads/file-1.txt',
      filename: 'file-1.txt',
      originalName: 'demo.txt',
      size: 3,
      contentType: 'text/plain',
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('uploads multiple parts and sends all part descriptors on complete', async () => {
    const seenPartNumbers: number[] = [];

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const { action, url } = parseAction(input);
      if (action === 'mpu-create') {
        return jsonResponse({
          uploadId: 'upload-2',
          filename: 'file-2.bin',
          path: 'uploads/file-2.bin',
        });
      }
      if (action === 'mpu-uploadpart') {
        const partNumber = Number(url.searchParams.get('partNumber'));
        seenPartNumbers.push(partNumber);
        return jsonResponse({ partNumber, etag: `etag-${partNumber}` });
      }
      if (action === 'mpu-complete') {
        return jsonResponse({
          path: 'uploads/file-2.bin',
          filename: 'file-2.bin',
          size: 12 * 1024 * 1024,
        });
      }
      throw new Error(`Unexpected action ${action}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const file = new File([new Uint8Array(12 * 1024 * 1024)], 'big.bin', {
      type: 'application/octet-stream',
    });

    await uploadWorkspaceFile('ws-1', file, {
      partSizeBytes: 5 * 1024 * 1024,
      maxConcurrency: 1,
    });

    expect(seenPartNumbers).toEqual([1, 2, 3]);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('reports progress as parts complete', async () => {
    const progressValues: number[] = [];

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const { action, url } = parseAction(input);
      if (action === 'mpu-create') {
        return jsonResponse({
          uploadId: 'upload-4',
          filename: 'file-4.bin',
          path: 'uploads/file-4.bin',
        });
      }
      if (action === 'mpu-uploadpart') {
        const partNumber = Number(url.searchParams.get('partNumber'));
        return jsonResponse({ partNumber, etag: `etag-${partNumber}` });
      }
      if (action === 'mpu-complete') {
        return jsonResponse({
          path: 'uploads/file-4.bin',
          filename: 'file-4.bin',
          size: 12 * 1024 * 1024,
        });
      }
      throw new Error(`Unexpected action ${action}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const file = new File([new Uint8Array(12 * 1024 * 1024)], 'progress.bin', {
      type: 'application/octet-stream',
    });

    await uploadWorkspaceFile('ws-1', file, {
      partSizeBytes: 5 * 1024 * 1024,
      maxConcurrency: 1,
      onProgress: (progress) => {
        progressValues.push(progress);
      },
    });

    expect(progressValues[0]).toBe(0);
    expect(progressValues.at(-1)).toBe(100);
    expect(progressValues).toEqual([0, 42, 83, 100]);
  });

  it('aborts multipart upload when a part upload fails', async () => {
    const calls: string[] = [];

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const { action } = parseAction(input);
      calls.push(action ?? 'unknown-action');

      if (action === 'mpu-create') {
        return jsonResponse({
          uploadId: 'upload-3',
          filename: 'file-3.bin',
          path: 'uploads/file-3.bin',
        });
      }
      if (action === 'mpu-uploadpart') {
        return jsonResponse({ error: 'part failed' }, 500);
      }
      if (action === 'mpu-abort') {
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected action ${action}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const file = new File([new Uint8Array(6 * 1024 * 1024)], 'fails.bin', {
      type: 'application/octet-stream',
    });

    await expect(
      uploadWorkspaceFile('ws-1', file, {
        partSizeBytes: 5 * 1024 * 1024,
        maxConcurrency: 1,
      })
    ).rejects.toThrow('part failed');

    expect(calls).toContain('mpu-abort');
  });

  it('rejects zero-byte files', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const file = new File([new Uint8Array(0)], 'empty.txt', { type: 'text/plain' });
    await expect(uploadWorkspaceFile('ws-1', file)).rejects.toThrow(
      'Empty files are not supported'
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects uploads that complete without a mounted upload path', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const { action } = parseAction(input);
      if (action === 'mpu-create') {
        return jsonResponse({
          uploadId: 'upload-bad-path',
          filename: 'file.txt',
          path: 'uploads/file.txt',
        });
      }
      if (action === 'mpu-uploadpart') {
        return jsonResponse({ partNumber: 1, etag: 'etag-1' });
      }
      if (action === 'mpu-complete') {
        return jsonResponse({
          path: '/tmp/file.txt',
          filename: 'file.txt',
          size: 3,
        });
      }
      throw new Error(`Unexpected action ${action}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const file = new File(['abc'], 'demo.txt', { type: 'text/plain' });
    await expect(uploadWorkspaceFile('ws-1', file)).rejects.toThrow(
      'invalid multipart complete response',
    );
  });
});
