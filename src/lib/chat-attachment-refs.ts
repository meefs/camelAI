export const USER_UPLOAD_MOUNT_PREFIX = "uploads/";

export type UploadReferenceKind = "user_upload" | "generated_transcript";

export interface UploadReferenceInput {
  path: string;
  kind?: UploadReferenceKind;
  sourceThreadId?: string;
  sourceTitle?: string;
}

export interface ParsedUploadRef {
  originalText: string;
  mountPath: string;
  filename: string;
  originalName: string;
  kind: UploadReferenceKind;
  sourceThreadId?: string;
}

const UPLOAD_REF_REGEX =
  /\(user uploaded file to ((?:uploads\/|\/mnt\/user-uploads\/)([^\s)]+))\)(?:\s*⟦upload:\s*([a-z_]+)([^⟧]*)⟧)?/g;
const UPLOAD_ANNOTATION_REGEX = /\s*⟦upload:\s*[a-z_]+[^⟧]*⟧/g;

export function isUserUploadMountPath(path: string): boolean {
  return (
    path.startsWith(USER_UPLOAD_MOUNT_PREFIX) &&
    !path.includes("..") &&
    !/[\r\n]/.test(path)
  );
}

function deriveOriginalName(filename: string): string {
  const lastDot = filename.lastIndexOf(".");
  const ext = lastDot !== -1 ? filename.slice(lastDot) : "";
  const base = lastDot !== -1 ? filename.slice(0, lastDot) : filename;
  const parts = base.split("-");

  if (parts.length >= 3) {
    const maybeTimestamp = parts[parts.length - 2];
    const maybeRandom = parts[parts.length - 1];
    const hasTimestamp = /^\d{10,}$/.test(maybeTimestamp);
    const hasRandom = /^[a-z0-9]{4,}$/.test(maybeRandom);
    if (hasTimestamp && hasRandom) {
      const originalBase = parts.slice(0, -2).join("-");
      if (originalBase) {
        return `${originalBase}${ext}`;
      }
    }
  }

  return filename;
}

function parseUploadAnnotationField(
  metadata: string | undefined,
  field: string,
): string | undefined {
  const match = metadata?.match(new RegExp(`(?:^|\\s)${field}=([^\\s⟧]+)`));
  return match?.[1];
}

export function buildUserUploadReference(path: string): string {
  if (!isUserUploadMountPath(path)) {
    throw new Error(
      `Upload completed without a readable ${USER_UPLOAD_MOUNT_PREFIX} path`,
    );
  }
  return `(user uploaded file to ${path})`;
}

export function buildAttachmentReference(ref: UploadReferenceInput): string {
  const marker = buildUserUploadReference(ref.path);
  if (ref.kind !== "generated_transcript") {
    return marker;
  }
  const sourceThread = ref.sourceThreadId
    ? ` source_thread_id=${ref.sourceThreadId}`
    : "";
  return `${marker} ⟦upload: generated_transcript${sourceThread}⟧`;
}

export function stripUploadAnnotations(content: string): string {
  return content.replace(UPLOAD_ANNOTATION_REGEX, "");
}

export function parseUploadRefs(content: string): {
  refs: ParsedUploadRef[];
  cleanContent: string;
} {
  const refs: ParsedUploadRef[] = [];
  const cleaned = content.replace(
    UPLOAD_REF_REGEX,
    (match, mountPath, filename, annotationKind, metadata) => {
      const kind: UploadReferenceKind =
        annotationKind === "generated_transcript"
          ? "generated_transcript"
          : "user_upload";
      const sourceThreadId = parseUploadAnnotationField(
        metadata,
        "source_thread_id",
      );
      const ref: ParsedUploadRef = {
        originalText: match,
        mountPath,
        filename,
        originalName: deriveOriginalName(filename),
        kind,
      };
      if (sourceThreadId) {
        ref.sourceThreadId = sourceThreadId;
      }
      refs.push(ref);
      return "";
    },
  );

  if (refs.length === 0) {
    return { refs, cleanContent: content };
  }

  const normalized = cleaned
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();

  return { refs, cleanContent: normalized };
}

export function appendAttachmentReferences(
  text: string,
  refs: UploadReferenceInput[],
): string {
  const rawContent = text.trim();
  if (refs.length === 0) {
    return rawContent;
  }

  const fileRefs = refs.map(buildAttachmentReference).join("\n");
  return rawContent ? `${rawContent}\n\n${fileRefs}` : fileRefs;
}

export function appendUserUploadReferences(
  text: string,
  uploadPaths: string[],
): string {
  return appendAttachmentReferences(
    text,
    uploadPaths.map((path) => ({ path })),
  );
}
