import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BinaryTextPreviewError,
  FullTextPreviewTooLargeError,
  readTextPreviewFromStream,
} from '@/routes/api/text-preview-stream';
import {
  FULL_TEXT_PREVIEW_BYTE_LIMIT,
  INITIAL_TEXT_PREVIEW_BYTE_LIMIT,
} from '@/lib/file-preview-limits';

const {
  getEnvMock,
  requireWorkspaceAccessMock,
  r2GetMock,
  workspaceReadFileStreamMock,
  workspaceListFilesMock,
  vmReadFileStreamMock,
} = vi.hoisted(() => ({
  getEnvMock: vi.fn(),
  requireWorkspaceAccessMock: vi.fn(),
  r2GetMock: vi.fn(),
  workspaceReadFileStreamMock: vi.fn(),
  workspaceListFilesMock: vi.fn(),
  vmReadFileStreamMock: vi.fn(),
}));

vi.mock('@/lib/cloudflare.server', () => ({
  getEnv: getEnvMock,
}));

vi.mock('@/routes/api/workspaces.utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/routes/api/workspaces.utils')>();
  return {
    ...actual,
    requireWorkspaceAccess: requireWorkspaceAccessMock,
  };
});

vi.mock('../workers/main/src/workspace-filesystem-do', () => ({
  WorkspaceFilesystemClient: class WorkspaceFilesystemClient {
    readFileStream = workspaceReadFileStreamMock;
    listFiles = workspaceListFilesMock;
  },
}));

vi.mock('../workers/main/src/project-runtime-service-vm', () => ({
  ProjectRuntimeServiceVmBridge: class ProjectRuntimeServiceVmBridge {
    readFileStream = vmReadFileStreamMock;
  },
}));

const { loadTextPreviewResponse } = await import(
  '@/routes/api/workspace-file-preview-text.server'
);
const { loader } = await import('@/routes/api/workspaces.$id.file-preview.text');

const encoder = new TextEncoder();

function makeLines(count: number): string {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}`).join('\n');
}

function streamFromChunks(
  chunks: Uint8Array[],
  onCancel?: () => void
): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[index]);
      index += 1;
    },
    cancel() {
      onCancel?.();
    },
  });
}

function streamFromText(text: string, onCancel?: () => void): ReadableStream<Uint8Array> {
  return streamFromChunks([encoder.encode(text)], onCancel);
}

function textPreviewRequest(query: string): Request {
  return new Request(`https://camelai.com/api/workspaces/ws_123/file-preview/text?${query}`);
}

async function expectJsonError(
  promise: Promise<unknown>,
  status: number
): Promise<Response> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(Response);
    expect((error as Response).status).toBe(status);
    return error as Response;
  }
  throw new Error(`Expected Response error with status ${status}`);
}

describe('readTextPreviewFromStream', () => {
  it('does not truncate files under or at the line cap', async () => {
    await expect(
      readTextPreviewFromStream(streamFromText(makeLines(999)), {
        mode: 'initial',
        maxLines: 1000,
      })
    ).resolves.toMatchObject({
      truncated: false,
      totalLines: 999,
    });

    await expect(
      readTextPreviewFromStream(streamFromText(makeLines(1000)), {
        mode: 'initial',
        maxLines: 1000,
      })
    ).resolves.toMatchObject({
      truncated: false,
      totalLines: 1000,
    });
  });

  it('truncates after the configured number of lines and cancels the stream', async () => {
    const onCancel = vi.fn();
    const result = await readTextPreviewFromStream(streamFromText(makeLines(1001), onCancel), {
      mode: 'initial',
      maxLines: 1000,
    });

    expect(result.truncated).toBe(true);
    expect(result.truncatedBy).toBe('lines');
    expect(result.totalLines).toBeNull();
    expect(result.text.split('\n')).toHaveLength(1000);
    expect(result.text).not.toContain('line 1001');
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('does not truncate an initial preview that exactly fills the byte budget at EOF', async () => {
    const onCancel = vi.fn();
    const result = await readTextPreviewFromStream(
      streamFromChunks([new Uint8Array(INITIAL_TEXT_PREVIEW_BYTE_LIMIT).fill(97)], onCancel),
      {
        mode: 'initial',
        maxLines: 1000,
      }
    );

    expect(result.truncated).toBe(false);
    expect(result.truncatedBy).toBeUndefined();
    expect(result.totalLines).toBe(1);
    expect(result.text).toHaveLength(INITIAL_TEXT_PREVIEW_BYTE_LIMIT);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('does not truncate multi-chunk initial previews that exactly fill the byte budget at EOF', async () => {
    const onCancel = vi.fn();
    const result = await readTextPreviewFromStream(
      streamFromChunks([
        new Uint8Array(400_000).fill(97),
        new Uint8Array(INITIAL_TEXT_PREVIEW_BYTE_LIMIT - 400_000).fill(98),
      ], onCancel),
      {
        mode: 'initial',
        maxLines: 1000,
      }
    );

    expect(result.truncated).toBe(false);
    expect(result.truncatedBy).toBeUndefined();
    expect(result.totalLines).toBe(1);
    expect(result.text).toHaveLength(INITIAL_TEXT_PREVIEW_BYTE_LIMIT);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('byte-truncates when more data exists after exactly filling the initial byte budget', async () => {
    const onCancel = vi.fn();
    const result = await readTextPreviewFromStream(
      streamFromChunks([
        new Uint8Array(INITIAL_TEXT_PREVIEW_BYTE_LIMIT).fill(97),
        new Uint8Array([0]),
      ], onCancel),
      {
        mode: 'initial',
        maxLines: 1000,
      }
    );

    expect(result.truncated).toBe(true);
    expect(result.truncatedBy).toBe('bytes');
    expect(result.totalLines).toBeNull();
    expect(result.text).toHaveLength(INITIAL_TEXT_PREVIEW_BYTE_LIMIT);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('truncates oversized initial chunks before decoding past the byte cap', async () => {
    const onCancel = vi.fn();
    const result = await readTextPreviewFromStream(
      streamFromChunks([
        new Uint8Array(INITIAL_TEXT_PREVIEW_BYTE_LIMIT + 100_000).fill(97),
      ], onCancel),
      {
        mode: 'initial',
        maxLines: 1000,
      }
    );

    expect(result.truncated).toBe(true);
    expect(result.truncatedBy).toBe('bytes');
    expect(result.totalLines).toBeNull();
    expect(result.text).toHaveLength(INITIAL_TEXT_PREVIEW_BYTE_LIMIT);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('uses the line cap when it is hit before the initial byte cap', async () => {
    const onCancel = vi.fn();
    const result = await readTextPreviewFromStream(
      streamFromText(`first\n${'a'.repeat(INITIAL_TEXT_PREVIEW_BYTE_LIMIT + 100)}`, onCancel),
      {
        mode: 'initial',
        maxLines: 1,
      }
    );

    expect(result).toMatchObject({
      text: 'first',
      truncated: true,
      truncatedBy: 'lines',
      totalLines: null,
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('counts CRLF input and files without trailing newlines correctly', async () => {
    await expect(
      readTextPreviewFromStream(streamFromText('a\r\nb\r\nc'), {
        mode: 'full',
        maxLines: 1000,
      })
    ).resolves.toMatchObject({
      text: 'a\r\nb\r\nc',
      truncated: false,
      totalLines: 3,
    });

    await expect(
      readTextPreviewFromStream(streamFromText('a\nb'), {
        mode: 'full',
        maxLines: 1000,
      })
    ).resolves.toMatchObject({
      text: 'a\nb',
      truncated: false,
      totalLines: 2,
    });
  });

  it('preserves multibyte characters split across chunks', async () => {
    const bytes = encoder.encode('alpha 😀\nbeta');
    const split = bytes.indexOf(0xf0) + 2;
    const result = await readTextPreviewFromStream(
      streamFromChunks([bytes.slice(0, split), bytes.slice(split)]),
      {
        mode: 'full',
        maxLines: 1000,
      }
    );

    expect(result.text).toBe('alpha 😀\nbeta');
    expect(result.totalLines).toBe(2);
  });

  it('rejects binary-looking content', async () => {
    await expect(
      readTextPreviewFromStream(streamFromChunks([new Uint8Array([0, 1, 2, 3])]), {
        mode: 'initial',
        maxLines: 1000,
      })
    ).rejects.toBeInstanceOf(BinaryTextPreviewError);
  });

  it('allows delimited text extensions with Excel MIME metadata', async () => {
    await expect(
      readTextPreviewFromStream(streamFromText('a,b\n1,2'), {
        mode: 'initial',
        maxLines: 1000,
        contentType: 'application/vnd.ms-excel',
        path: '/exports/data.csv',
      })
    ).resolves.toMatchObject({
      text: 'a,b\n1,2',
      truncated: false,
      totalLines: 2,
      contentType: 'application/vnd.ms-excel',
    });

    await expect(
      readTextPreviewFromStream(streamFromText('a\tb\n1\t2'), {
        mode: 'initial',
        maxLines: 1000,
        contentType: 'application/vnd.ms-excel',
        path: '/exports/data.tsv',
      })
    ).resolves.toMatchObject({
      text: 'a\tb\n1\t2',
      truncated: false,
      totalLines: 2,
      contentType: 'application/vnd.ms-excel',
    });
  });

  it('keeps rejecting Excel MIME metadata without a text extension', async () => {
    const onCancel = vi.fn();

    await expect(
      readTextPreviewFromStream(streamFromText('not read', onCancel), {
        mode: 'initial',
        maxLines: 1000,
        contentType: 'application/vnd.ms-excel',
        path: '/exports/report.xls',
      })
    ).rejects.toBeInstanceOf(BinaryTextPreviewError);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('allows full previews at the configured byte limit', async () => {
    await expect(
      readTextPreviewFromStream(streamFromText('abcd'), {
        mode: 'full',
        maxLines: 1000,
        fullByteLimit: 4,
      })
    ).resolves.toMatchObject({
      text: 'abcd',
      truncated: false,
      totalLines: 1,
    });
  });

  it('rejects and cancels full previews above the configured byte limit', async () => {
    const onCancel = vi.fn();

    await expect(
      readTextPreviewFromStream(
        streamFromChunks([encoder.encode('abc'), encoder.encode('de')], onCancel),
        {
          mode: 'full',
          maxLines: 1000,
          fullByteLimit: 4,
        }
      )
    ).rejects.toBeInstanceOf(FullTextPreviewTooLargeError);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('text preview route integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getEnvMock.mockReturnValue({
      R2_BUCKET: {
        get: r2GetMock,
      },
    });
    requireWorkspaceAccessMock.mockResolvedValue({
      userId: 'user_123',
      orgId: 'org_123',
      workspaceId: 'ws_123',
      access: 'full',
    });
    workspaceReadFileStreamMock.mockResolvedValue({
      success: true,
      stream: streamFromText('workspace text'),
      size: 14,
      mimeType: 'text/plain; charset=utf-8',
    });
    workspaceListFilesMock.mockResolvedValue({ success: true, files: [] });
    vmReadFileStreamMock.mockResolvedValue({
      response: new Response('vm text', {
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'content-length': '7',
        },
      }),
      path: '/workspace/app/main.ts',
    });
    r2GetMock.mockResolvedValue({
      body: streamFromText('r2 text'),
      size: 7,
      httpMetadata: { contentType: 'text/plain; charset=utf-8' },
    });
  });

  it('rejects invalid source, missing path, and invalid mode', async () => {
    await expectJsonError(
      loadTextPreviewResponse({
        request: textPreviewRequest('source=bogus&path=file.txt'),
        context: {},
        workspaceId: 'ws_123',
      }),
      400
    );
    await expectJsonError(
      loadTextPreviewResponse({
        request: textPreviewRequest('source=workspace'),
        context: {},
        workspaceId: 'ws_123',
      }),
      400
    );
    await expectJsonError(
      loadTextPreviewResponse({
        request: textPreviewRequest('source=workspace&path=file.txt&mode=bogus'),
        context: {},
        workspaceId: 'ws_123',
      }),
      400
    );
  });

  it('requires a project for VM previews', async () => {
    await expectJsonError(
      loadTextPreviewResponse({
        request: textPreviewRequest('source=vm&path=/workspace/app/main.ts'),
        context: {},
        workspaceId: 'ws_123',
      }),
      400
    );
    expect(vmReadFileStreamMock).not.toHaveBeenCalled();
  });

  it('loads workspace streams through WorkspaceFilesystemClient', async () => {
    const data = await loadTextPreviewResponse({
      request: textPreviewRequest('source=workspace&path=/notes.txt&mode=initial&maxLines=1000'),
      context: {},
      workspaceId: 'ws_123',
    });

    expect(workspaceReadFileStreamMock).toHaveBeenCalledWith('/notes.txt');
    expect(data).toMatchObject({
      text: 'workspace text',
      truncated: false,
      totalLines: 1,
      maxLines: 1000,
      size: 14,
      contentType: 'text/plain; charset=utf-8',
    });
  });

  it('normalizes internal workspace path segments before reading', async () => {
    await loadTextPreviewResponse({
      request: textPreviewRequest(
        `source=workspace&path=${encodeURIComponent('/app/../notes.txt')}`
      ),
      context: {},
      workspaceId: 'ws_123',
    });

    expect(workspaceReadFileStreamMock).toHaveBeenCalledWith('/notes.txt');
  });

  it('rejects escaping workspace paths as invalid input', async () => {
    const response = await expectJsonError(
      loadTextPreviewResponse({
        request: textPreviewRequest(
          `source=workspace&path=${encodeURIComponent('/../etc/passwd')}`
        ),
        context: {},
        workspaceId: 'ws_123',
      }),
      400
    );

    await expect(response.json()).resolves.toEqual({ error: 'Invalid file path' });
    expect(workspaceReadFileStreamMock).not.toHaveBeenCalled();
  });

  it('loads VM streams when project is provided', async () => {
    const data = await loadTextPreviewResponse({
      request: textPreviewRequest(
        'source=vm&project=app&path=/workspace/app/main.ts&mode=full'
      ),
      context: {},
      workspaceId: 'ws_123',
    });

    expect(vmReadFileStreamMock).toHaveBeenCalledWith({
      location: 'vm',
      project: 'app',
      path: '/workspace/app/main.ts',
    });
    expect(data).toMatchObject({
      text: 'vm text',
      totalLines: 1,
      size: 7,
    });
  });

  it('rejects escaping VM paths as invalid input', async () => {
    const response = await expectJsonError(
      loadTextPreviewResponse({
        request: textPreviewRequest(
          `source=vm&project=app&path=${encodeURIComponent('/../etc/passwd')}`
        ),
        context: {},
        workspaceId: 'ws_123',
      }),
      400
    );

    await expect(response.json()).resolves.toEqual({ error: 'Invalid file path' });
    expect(vmReadFileStreamMock).not.toHaveBeenCalled();
  });

  it('constructs workspace-scoped R2 keys for upload and output previews', async () => {
    await loadTextPreviewResponse({
      request: textPreviewRequest('source=upload&path=reports/in.csv&mode=full'),
      context: {},
      workspaceId: 'ws_123',
    });
    await loadTextPreviewResponse({
      request: textPreviewRequest('source=output&path=reports/out.csv&mode=full'),
      context: {},
      workspaceId: 'ws_123',
    });

    expect(r2GetMock).toHaveBeenNthCalledWith(
      1,
      'org_123/ws_123/user-uploads/reports/in.csv'
    );
    expect(r2GetMock).toHaveBeenNthCalledWith(
      2,
      'org_123/ws_123/user-outputs/reports/out.csv'
    );
  });

  it('allows R2 CSV and TSV previews with Excel MIME metadata', async () => {
    r2GetMock
      .mockResolvedValueOnce({
        body: streamFromText('a,b\n1,2'),
        size: 7,
        httpMetadata: { contentType: 'application/vnd.ms-excel' },
      })
      .mockResolvedValueOnce({
        body: streamFromText('a\tb\n1\t2'),
        size: 7,
        httpMetadata: { contentType: 'application/vnd.ms-excel' },
      });

    const csv = await loadTextPreviewResponse({
      request: textPreviewRequest('source=upload&path=reports/in.csv&mode=full'),
      context: {},
      workspaceId: 'ws_123',
    });
    const tsv = await loadTextPreviewResponse({
      request: textPreviewRequest('source=output&path=reports/out.tsv&mode=full'),
      context: {},
      workspaceId: 'ws_123',
    });

    expect(csv).toMatchObject({
      text: 'a,b\n1,2',
      truncated: false,
      totalLines: 2,
      contentType: 'application/vnd.ms-excel',
    });
    expect(tsv).toMatchObject({
      text: 'a\tb\n1\t2',
      truncated: false,
      totalLines: 2,
      contentType: 'application/vnd.ms-excel',
    });
  });

  it('surfaces missing files as 404', async () => {
    workspaceReadFileStreamMock.mockResolvedValueOnce({
      success: false,
      error: 'File not found',
      code: 'ENOENT',
    });

    await expectJsonError(
      loadTextPreviewResponse({
        request: textPreviewRequest('source=workspace&path=/missing.txt'),
        context: {},
        workspaceId: 'ws_123',
      }),
      404
    );
  });

  it('preserves workspace access failures at the loader boundary', async () => {
    requireWorkspaceAccessMock.mockRejectedValueOnce(
      Response.json({ error: 'Unauthorized' }, { status: 401 })
    );

    const response = await loader({
      request: textPreviewRequest('source=workspace&path=/notes.txt'),
      context: {},
      params: { id: 'ws_123' },
    } as never);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
  });

  it('rejects known oversized full previews before reading', async () => {
    const onCancel = vi.fn();
    workspaceReadFileStreamMock.mockResolvedValueOnce({
      success: true,
      stream: streamFromText('not read', onCancel),
      size: FULL_TEXT_PREVIEW_BYTE_LIMIT + 1,
      mimeType: 'text/plain; charset=utf-8',
    });

    await expect(
      loadTextPreviewResponse({
        request: textPreviewRequest('source=workspace&path=/large.txt&mode=full'),
        context: {},
        workspaceId: 'ws_123',
      })
    ).rejects.toBeInstanceOf(FullTextPreviewTooLargeError);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('maps binary-looking files to 415 at the loader boundary', async () => {
    workspaceReadFileStreamMock.mockResolvedValueOnce({
      success: true,
      stream: streamFromChunks([new Uint8Array([0, 1, 2, 3])]),
      size: 4,
      mimeType: 'application/octet-stream',
    });

    const response = await loader({
      request: textPreviewRequest('source=workspace&path=/binary.bin'),
      context: {},
      params: { id: 'ws_123' },
    } as never);

    expect(response.status).toBe(415);
    await expect(response.json()).resolves.toEqual({
      error: 'File is not text-previewable',
    });
  });

  it('maps oversized full previews to 413 at the loader boundary', async () => {
    workspaceReadFileStreamMock.mockResolvedValueOnce({
      success: true,
      stream: streamFromChunks([
        new Uint8Array(FULL_TEXT_PREVIEW_BYTE_LIMIT + 1).fill(97),
      ]),
      size: FULL_TEXT_PREVIEW_BYTE_LIMIT + 1,
      mimeType: 'text/plain; charset=utf-8',
    });

    const response = await loader({
      request: textPreviewRequest('source=workspace&path=/large.txt&mode=full'),
      context: {},
      params: { id: 'ws_123' },
    } as never);

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: 'File is too large to preview in full',
      code: 'FULL_PREVIEW_TOO_LARGE',
    });
  });
});
