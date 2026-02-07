const DEFAULT_CONTENT_TYPE = 'application/octet-stream';
const DEFAULT_PART_SIZE_BYTES = 10 * 1024 * 1024;
const MIN_PART_SIZE_BYTES = 5 * 1024 * 1024;
const MAX_PARTS = 10_000;
const DEFAULT_MAX_CONCURRENCY = 6;

interface MultipartCreateResponse {
  uploadId: string;
  filename: string;
  path: string;
}

interface MultipartPartResponse {
  partNumber: number;
  etag: string;
}

interface MultipartCompleteResponse {
  path?: string;
  filename?: string;
  size?: number;
}

interface UploadErrorPayload {
  error?: string;
}

interface MultipartUploadOptions {
  partSizeBytes?: number;
  maxConcurrency?: number;
  onProgress?: (progressPercent: number, uploadedBytes: number, totalBytes: number) => void;
}

export interface WorkspaceUploadResult {
  path: string;
  filename: string;
  originalName: string;
  size: number;
  contentType: string;
}

function getUploadUrl(workspaceId: string): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/upload`;
}

function getActionUrl(
  workspaceId: string,
  action: string,
  params: Record<string, string | number>
): string {
  const search = new URLSearchParams({ action });
  for (const [key, value] of Object.entries(params)) {
    search.set(key, String(value));
  }
  return `${getUploadUrl(workspaceId)}?${search.toString()}`;
}

async function readUploadError(response: Response): Promise<string> {
  let text: string | null = null;
  try {
    text = await response.text();
  } catch {
    return `Upload failed with status ${response.status}`;
  }

  if (!text) {
    return `Upload failed with status ${response.status}`;
  }

  try {
    const parsed = JSON.parse(text) as UploadErrorPayload;
    if (typeof parsed.error === 'string' && parsed.error.length > 0) {
      return parsed.error;
    }
  } catch {
    // Ignore JSON parse failure, keep text as-is.
  }

  return text;
}

function getContentType(file: File): string {
  return file.type && file.type.length > 0 ? file.type : DEFAULT_CONTENT_TYPE;
}

function clampConcurrency(value: number | undefined, partCount: number): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    return Math.min(DEFAULT_MAX_CONCURRENCY, partCount);
  }
  return Math.min(value as number, partCount);
}

function resolvePartSize(fileSize: number, configuredPartSize?: number): number {
  const requested = Number.isInteger(configuredPartSize) && (configuredPartSize as number) > 0
    ? configuredPartSize as number
    : DEFAULT_PART_SIZE_BYTES;

  const minimumToFitPartLimit = Math.ceil(fileSize / MAX_PARTS);
  return Math.max(requested, MIN_PART_SIZE_BYTES, minimumToFitPartLimit);
}

async function abortMultipartUpload(
  workspaceId: string,
  uploadId: string,
  filename: string
): Promise<void> {
  try {
    await fetch(
      getActionUrl(workspaceId, 'mpu-abort', { uploadId, filename }),
      { method: 'DELETE' }
    );
  } catch {
    // Best-effort cleanup only.
  }
}

export async function uploadWorkspaceFile(
  workspaceId: string,
  file: File,
  options: MultipartUploadOptions = {}
): Promise<WorkspaceUploadResult> {
  if (file.size === 0) {
    throw new Error('Empty files are not supported');
  }

  const contentType = getContentType(file);
  const partSize = resolvePartSize(file.size, options.partSizeBytes);
  const partCount = Math.ceil(file.size / partSize);
  const maxConcurrency = clampConcurrency(options.maxConcurrency, partCount);
  let uploadedBytes = 0;
  let lastProgressPercent = -1;

  const emitProgress = (bytes: number) => {
    if (!options.onProgress) return;
    const progressPercent = Math.min(100, Math.round((bytes / file.size) * 100));
    if (progressPercent === lastProgressPercent) return;
    lastProgressPercent = progressPercent;
    options.onProgress(progressPercent, bytes, file.size);
  };

  emitProgress(0);

  let uploadId: string | null = null;
  let filename: string | null = null;
  let uploadedPath: string | null = null;

  try {
    const createResponse = await fetch(
      getActionUrl(workspaceId, 'mpu-create', {}),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          originalName: file.name,
          contentType,
        }),
      }
    );
    if (!createResponse.ok) {
      throw new Error(await readUploadError(createResponse));
    }

    const createPayload = await createResponse.json() as Partial<MultipartCreateResponse>;
    if (
      typeof createPayload.uploadId !== 'string'
      || typeof createPayload.filename !== 'string'
      || typeof createPayload.path !== 'string'
    ) {
      throw new Error('Upload API returned an invalid multipart create response');
    }

    uploadId = createPayload.uploadId;
    filename = createPayload.filename;
    uploadedPath = createPayload.path;
    const activeUploadId = uploadId;
    const activeFilename = filename;

    const uploadedParts: MultipartPartResponse[] = new Array(partCount);
    let nextPartNumber = 1;

    const uploadWorker = async () => {
      for (;;) {
        const partNumber = nextPartNumber;
        nextPartNumber += 1;
        if (partNumber > partCount) return;

        const start = (partNumber - 1) * partSize;
        const end = Math.min(start + partSize, file.size);
        const chunk = file.slice(start, end);
        const partByteLength = end - start;

        const response = await fetch(
          getActionUrl(workspaceId, 'mpu-uploadpart', {
            uploadId: activeUploadId,
            filename: activeFilename,
            partNumber,
          }),
          {
            method: 'PUT',
            body: chunk,
          }
        );
        if (!response.ok) {
          throw new Error(await readUploadError(response));
        }

        const payload = await response.json() as Partial<MultipartPartResponse>;
        if (
          typeof payload.partNumber !== 'number'
          || typeof payload.etag !== 'string'
          || payload.etag.length === 0
        ) {
          throw new Error(`Upload API returned an invalid part response for part ${partNumber}`);
        }

        uploadedParts[partNumber - 1] = {
          partNumber: payload.partNumber,
          etag: payload.etag,
        };
        uploadedBytes += partByteLength;
        emitProgress(uploadedBytes);
      }
    };

    await Promise.all(
      Array.from({ length: maxConcurrency }, () => uploadWorker())
    );

    const completeResponse = await fetch(
      getActionUrl(workspaceId, 'mpu-complete', {
        uploadId: activeUploadId,
        filename: activeFilename,
      }),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parts: uploadedParts }),
      }
    );
    if (!completeResponse.ok) {
      throw new Error(await readUploadError(completeResponse));
    }

    const completePayload = await completeResponse.json() as MultipartCompleteResponse;
    const finalPath = typeof completePayload.path === 'string' ? completePayload.path : uploadedPath;
    if (!finalPath) {
      throw new Error('Upload API returned an invalid multipart complete response');
    }

    const finalFilename = typeof completePayload.filename === 'string'
      ? completePayload.filename
      : activeFilename;
    if (!finalFilename) {
      throw new Error('Upload API returned an invalid multipart complete response');
    }

    emitProgress(file.size);

    return {
      path: finalPath,
      filename: finalFilename,
      originalName: file.name,
      size: typeof completePayload.size === 'number' ? completePayload.size : file.size,
      contentType,
    };
  } catch (error) {
    if (uploadId && filename) {
      await abortMultipartUpload(workspaceId, uploadId, filename);
    }
    if (error instanceof Error) {
      throw error;
    }
    throw new Error('Upload failed');
  }
}
