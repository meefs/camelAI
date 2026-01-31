export interface ParsedUploadRef {
  originalText: string;
  mountPath: string;
  filename: string;
  originalName: string;
}

const UPLOAD_REF_REGEX = /\(user uploaded file to (\/mnt\/user-uploads\/([^\s)]+))\)/g;

function deriveOriginalName(filename: string): string {
  const lastDot = filename.lastIndexOf('.');
  const ext = lastDot !== -1 ? filename.slice(lastDot) : '';
  const base = lastDot !== -1 ? filename.slice(0, lastDot) : filename;
  const parts = base.split('-');

  if (parts.length >= 3) {
    const maybeTimestamp = parts[parts.length - 2];
    const maybeRandom = parts[parts.length - 1];
    const hasTimestamp = /^\d{10,}$/.test(maybeTimestamp);
    const hasRandom = /^[a-z0-9]{4,}$/.test(maybeRandom);
    if (hasTimestamp && hasRandom) {
      const originalBase = parts.slice(0, -2).join('-');
      if (originalBase) {
        return `${originalBase}${ext}`;
      }
    }
  }

  return filename;
}

export function parseUploadRefs(content: string): {
  refs: ParsedUploadRef[];
  cleanContent: string;
} {
  const refs: ParsedUploadRef[] = [];
  const cleaned = content.replace(UPLOAD_REF_REGEX, (match, mountPath, filename) => {
    refs.push({
      originalText: match,
      mountPath,
      filename,
      originalName: deriveOriginalName(filename),
    });
    return '';
  });

  if (refs.length === 0) {
    return { refs, cleanContent: content };
  }

  const normalized = cleaned
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();

  return { refs, cleanContent: normalized };
}
