export type FilePreviewSource = "workspace" | "upload" | "output" | "vm";

export interface FilePreviewLinkTarget {
  source: FilePreviewSource;
  path: string;
  filename: string;
  project?: string;
  contentType?: string;
}

export interface BuildFilePreviewTargetInput {
  path?: unknown;
  location?: unknown;
  project?: unknown;
  contentType?: unknown;
  content_type?: unknown;
}

const WORKSPACE_ROOT_PREFIXES = ["/home/claude", "/workspace", "/root"];

type NormalizedPath = {
  absolutePath: string;
  segments: string[];
};

function getString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function getContentType(input: BuildFilePreviewTargetInput): string | undefined {
  const contentType = getString(input.contentType) || getString(input.content_type);
  return contentType || undefined;
}

function normalizeLocation(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function normalizePathValue(value: unknown): NormalizedPath | null {
  const rawPath = getString(value);
  if (!rawPath) return null;

  let normalized = rawPath.replace(/\\/g, "/").replace(/\/+/g, "/");
  const withLeadingSlash = normalized.startsWith("/") ? normalized : `/${normalized}`;

  normalized = withLeadingSlash;
  for (const prefix of WORKSPACE_ROOT_PREFIXES) {
    if (normalized === prefix) {
      normalized = "/";
      break;
    }
    if (normalized.startsWith(`${prefix}/`)) {
      normalized = normalized.slice(prefix.length) || "/";
      break;
    }
  }

  const segments = normalized.split("/").filter((segment) => segment && segment !== ".");
  if (segments.some((segment) => segment === "..")) return null;

  return {
    absolutePath: `/${segments.join("/")}`,
    segments,
  };
}

function basename(path: string): string {
  return path.split("/").filter(Boolean).pop() || "";
}

function withMetadata(
  target: Omit<FilePreviewLinkTarget, "filename" | "contentType"> & {
    filename?: string;
    contentType?: string;
  },
  contentType?: string,
): FilePreviewLinkTarget | null {
  const filename = getString(target.filename) || basename(target.path);
  if (!filename) return null;
  return {
    source: target.source,
    path: target.path,
    filename,
    ...(target.project ? { project: target.project } : {}),
    ...(target.contentType || contentType
      ? { contentType: target.contentType || contentType }
      : {}),
  };
}

function buildR2Target(
  normalizedPath: NormalizedPath,
  contentType?: string,
): FilePreviewLinkTarget | null {
  const { segments } = normalizedPath;
  if (segments.length < 2) return null;

  if (segments[0] === "uploads" || segments[0] === "outputs") {
    const relativePath = segments.slice(1).join("/");
    if (!relativePath) return null;
    return withMetadata(
      {
        source: segments[0] === "uploads" ? "upload" : "output",
        path: relativePath,
      },
      contentType,
    );
  }

  if (
    segments.length >= 3 &&
    segments[0] === "mnt" &&
    (segments[1] === "user-uploads" || segments[1] === "user-outputs")
  ) {
    const relativePath = segments.slice(2).join("/");
    if (!relativePath) return null;
    return withMetadata(
      {
        source: segments[1] === "user-uploads" ? "upload" : "output",
        path: relativePath,
      },
      contentType,
    );
  }

  return null;
}

export function buildFilePreviewLinkTarget(
  input: BuildFilePreviewTargetInput,
): FilePreviewLinkTarget | null {
  const normalizedPath = normalizePathValue(input.path);
  if (!normalizedPath) return null;

  const contentType = getContentType(input);
  const location = normalizeLocation(input.location);

  if (location === "workspace") {
    return withMetadata(
      {
        source: "workspace",
        path: normalizedPath.absolutePath,
      },
      contentType,
    );
  }

  if (location === "vm") {
    const project = getString(input.project);
    if (!project) return null;
    return withMetadata(
      {
        source: "vm",
        path: normalizedPath.absolutePath,
        project,
      },
      contentType,
    );
  }

  if (location === "r2") {
    return buildR2Target(normalizedPath, contentType);
  }

  if (location) return null;

  return (
    buildR2Target(normalizedPath, contentType) ??
    withMetadata(
      {
        source: "workspace",
        path: normalizedPath.absolutePath,
      },
      contentType,
    )
  );
}

function isFilePreviewSource(value: unknown): value is FilePreviewSource {
  return (
    value === "workspace" ||
    value === "upload" ||
    value === "output" ||
    value === "vm"
  );
}

function normalizeCanonicalTargetPath(
  source: FilePreviewSource,
  path: unknown,
): Pick<FilePreviewLinkTarget, "path" | "filename"> | null {
  const normalizedPath = normalizePathValue(path);
  if (!normalizedPath) return null;

  if (source === "workspace" || source === "vm") {
    const filename = basename(normalizedPath.absolutePath);
    if (!filename) return null;
    return { path: normalizedPath.absolutePath, filename };
  }

  let segments = normalizedPath.segments;
  if (segments[0] === (source === "upload" ? "uploads" : "outputs")) {
    segments = segments.slice(1);
  }
  if (
    segments[0] === "mnt" &&
    segments[1] === (source === "upload" ? "user-uploads" : "user-outputs")
  ) {
    segments = segments.slice(2);
  }
  if (segments.length === 0) return null;

  const relativePath = segments.join("/");
  const filename = basename(relativePath);
  if (!filename) return null;
  return { path: relativePath, filename };
}

export function parseFilePreviewTargetFromToolResultText(
  resultText: string,
): FilePreviewLinkTarget | null {
  if (!resultText.trim()) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(resultText);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") return null;
  const target = (parsed as { target?: unknown }).target;
  if (!target || typeof target !== "object") return null;

  const targetRecord = target as Record<string, unknown>;
  if (targetRecord.kind !== "file" || !isFilePreviewSource(targetRecord.source)) {
    return null;
  }

  const source = targetRecord.source;
  const pathInfo = normalizeCanonicalTargetPath(source, targetRecord.path);
  if (!pathInfo) return null;

  const project = getString(targetRecord.project);
  if (source === "vm" && !project) return null;

  const filename = getString(targetRecord.filename) || pathInfo.filename;
  if (!filename) return null;

  const contentType =
    getString(targetRecord.contentType) || getString(targetRecord.content_type);

  return {
    source,
    path: pathInfo.path,
    filename,
    ...(project ? { project } : {}),
    ...(contentType ? { contentType } : {}),
  };
}
