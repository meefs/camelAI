import { Type } from "typebox";
import type { WorkspaceContainer } from "./workspace-container";

const CONTAINER_CWD = "/home/claude";
const USER_UPLOADS_ROOT = "/mnt/user-uploads";
const USER_OUTPUTS_ROOT = "/mnt/user-outputs";
const DEFAULT_MAX_LINES = 2000;
const DEFAULT_MAX_BYTES = 50 * 1024;
const GREP_MAX_LINE_LENGTH = 500;

type ExecResponse = {
  success?: boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  error?: string;
};

type FileReadResponse = {
  success: boolean;
  content?: string;
  size?: number;
  isBinary?: boolean;
  mimeType?: string;
  error?: string;
};

type FileWriteResponse = {
  success: boolean;
  error?: string;
};

type ListFilesResponse = {
  success?: boolean;
  files?: Array<{ name: string; type: "file" | "directory" }>;
  error?: string;
};

type CommandEnvProvider = Record<string, string> | (() => Promise<Record<string, string>> | Record<string, string>);

export interface PiContainerToolsOptions {
  commandEnv?: CommandEnvProvider;
}

type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export type PiContainerToolResult = {
  text: string;
  content: ToolContent[];
  details?: Record<string, unknown>;
};

export const PI_READ_PARAMETERS = Type.Object({
  path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
  offset: Type.Optional(Type.Number({ description: "1-indexed line offset for large files" })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of lines to return" })),
}, { additionalProperties: false });

export const PI_WRITE_PARAMETERS = Type.Object({
  path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
  content: Type.String({ description: "Content to write" }),
}, { additionalProperties: false });

export const PI_EDIT_PARAMETERS = Type.Object({
  path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
  edits: Type.Array(Type.Object({
    oldText: Type.String({
      description:
        "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
    }),
    newText: Type.String({ description: "Replacement text for this targeted edit." }),
  }, { additionalProperties: false }), {
    description:
      "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits.",
  }),
}, { additionalProperties: false });

export const PI_BASH_PARAMETERS = Type.Object({
  command: Type.String({ description: "Bash command to execute" }),
  timeout: Type.Optional(Type.Number({ description: "Optional timeout in seconds" })),
}, { additionalProperties: false });

export const PI_LS_PARAMETERS = Type.Object({
  path: Type.Optional(Type.String({ description: "Directory to list (default: current directory)" })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of entries to return (default: 500)" })),
}, { additionalProperties: false });

export const PI_GREP_PARAMETERS = Type.Object({
  pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
  path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
  glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" })),
  ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
  literal: Type.Optional(Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" })),
  context: Type.Optional(Type.Number({ description: "Number of lines to show before and after each match (default: 0)" })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 100)" })),
}, { additionalProperties: false });

export const PI_FIND_PARAMETERS = Type.Object({
  pattern: Type.String({
    description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
  }),
  path: Type.Optional(Type.String({ description: "Directory to search in (default: current directory)" })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of results (default: 1000)" })),
}, { additionalProperties: false });

export const PI_CONTAINER_TOOL_DEFINITIONS = {
  read: {
    name: "read",
    label: "read",
    description:
      `Read the contents of a file. Text output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB. Images are returned as image content when the sandbox file API can read them.`,
    parameters: PI_READ_PARAMETERS,
  },
  write: {
    name: "write",
    label: "write",
    description:
      "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
    parameters: PI_WRITE_PARAMETERS,
  },
  edit: {
    name: "edit",
    label: "edit",
    description:
      "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file.",
    parameters: PI_EDIT_PARAMETERS,
  },
  ls: {
    name: "ls",
    label: "ls",
    description:
      "List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles.",
    parameters: PI_LS_PARAMETERS,
  },
  grep: {
    name: "grep",
    label: "grep",
    description:
      "Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore.",
    parameters: PI_GREP_PARAMETERS,
  },
  find: {
    name: "find",
    label: "find",
    description:
      "Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore.",
    parameters: PI_FIND_PARAMETERS,
  },
  bash: {
    name: "bash",
    label: "bash",
    description:
      `Execute a bash command in the current working directory. Output is truncated to the last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB.`,
    parameters: PI_BASH_PARAMETERS,
  },
} as const;

function bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function formatSize(value: number): string {
  if (value < 1024) return `${value}B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)}KB`;
  return `${(value / (1024 * 1024)).toFixed(1)}MB`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function result(text: string, details?: Record<string, unknown>): PiContainerToolResult {
  return {
    text,
    content: [{ type: "text", text }],
    ...(details && Object.keys(details).length > 0 ? { details } : {}),
  };
}

function truncateHead(text: string, maxLines = DEFAULT_MAX_LINES, maxBytes = DEFAULT_MAX_BYTES) {
  const lines = text.split("\n");
  const selected: string[] = [];
  let usedBytes = 0;
  let truncatedBy: "lines" | "bytes" | null = null;
  for (const line of lines) {
    if (selected.length >= maxLines) {
      truncatedBy = "lines";
      break;
    }
    const lineBytes = bytes(line) + (selected.length > 0 ? 1 : 0);
    if (usedBytes + lineBytes > maxBytes) {
      truncatedBy = "bytes";
      break;
    }
    selected.push(line);
    usedBytes += lineBytes;
  }
  return {
    content: selected.join("\n"),
    truncation: truncatedBy
      ? {
          truncated: true,
          truncatedBy,
          totalLines: lines.length,
          outputLines: selected.length,
          outputBytes: usedBytes,
          totalBytes: bytes(text),
          maxLines,
          maxBytes,
        }
      : undefined,
  };
}

function truncateTail(text: string, maxLines = DEFAULT_MAX_LINES, maxBytes = DEFAULT_MAX_BYTES) {
  const lines = text.split("\n");
  const selected: string[] = [];
  let usedBytes = 0;
  let truncatedBy: "lines" | "bytes" | null = null;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (selected.length >= maxLines) {
      truncatedBy = "lines";
      break;
    }
    const line = lines[i];
    const lineBytes = bytes(line) + (selected.length > 0 ? 1 : 0);
    if (usedBytes + lineBytes > maxBytes) {
      truncatedBy = "bytes";
      break;
    }
    selected.unshift(line);
    usedBytes += lineBytes;
  }
  return {
    content: selected.join("\n"),
    truncation: truncatedBy
      ? {
          truncated: true,
          truncatedBy,
          totalLines: lines.length,
          outputLines: selected.length,
          outputBytes: usedBytes,
          totalBytes: bytes(text),
          maxLines,
          maxBytes,
        }
      : undefined,
  };
}

function normalizePath(value: unknown, fallback = CONTAINER_CWD): string {
  if (typeof value !== "string" || !value.trim()) return fallback;
  const raw = value.trim();
  if (
    raw === CONTAINER_CWD ||
    raw.startsWith(`${CONTAINER_CWD}/`) ||
    raw === USER_UPLOADS_ROOT ||
    raw.startsWith(`${USER_UPLOADS_ROOT}/`) ||
    raw === USER_OUTPUTS_ROOT ||
    raw.startsWith(`${USER_OUTPUTS_ROOT}/`)
  ) {
    return raw;
  }
  if (raw === "/") return CONTAINER_CWD;
  if (raw.startsWith("/")) return `${CONTAINER_CWD}${raw}`;
  return `${CONTAINER_CWD}/${raw}`;
}

function relativeTo(base: string, target: string): string {
  const root = base.replace(/\/+$/, "");
  if (target.startsWith(`${root}/`)) return target.slice(root.length + 1);
  if (target.startsWith(`${CONTAINER_CWD}/`)) return target.slice(CONTAINER_CWD.length + 1);
  return target.replace(/^.*\//, "");
}

function imageMime(path: string): string | null {
  const lower = path.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  return null;
}

function normalizeEdits(args: Record<string, unknown>): Array<{ oldText: string; newText: string }> {
  if (Array.isArray(args.edits)) {
    return args.edits.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const raw = entry as Record<string, unknown>;
      return [{
        oldText: String(raw.oldText ?? raw.old_string ?? ""),
        newText: String(raw.newText ?? raw.new_string ?? ""),
      }];
    });
  }
  const oldText = typeof args.oldText === "string"
    ? args.oldText
    : typeof args.old_string === "string"
      ? args.old_string
      : "";
  const newText = typeof args.newText === "string"
    ? args.newText
    : typeof args.new_string === "string"
      ? args.new_string
      : "";
  return oldText || newText ? [{ oldText, newText }] : [];
}

function applyExactEdits(content: string, edits: Array<{ oldText: string; newText: string }>, path: string) {
  const matches = edits.map((edit, index) => {
    if (!edit.oldText) throw new Error(`edits[${index}].oldText must not be empty in ${path}`);
    const first = content.indexOf(edit.oldText);
    if (first === -1) throw new Error(`Could not find edits[${index}] in ${path}`);
    if (content.indexOf(edit.oldText, first + edit.oldText.length) !== -1) {
      throw new Error(`Found multiple occurrences of edits[${index}] in ${path}. Add more context.`);
    }
    return { index, start: first, end: first + edit.oldText.length, newText: edit.newText };
  }).sort((a, b) => a.start - b.start);

  for (let i = 1; i < matches.length; i += 1) {
    if (matches[i - 1].end > matches[i].start) {
      throw new Error(`edits[${matches[i - 1].index}] and edits[${matches[i].index}] overlap in ${path}`);
    }
  }

  let next = content;
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const match = matches[i];
    next = `${next.slice(0, match.start)}${match.newText}${next.slice(match.end)}`;
  }
  if (next === content) throw new Error(`No changes made to ${path}`);
  return next;
}

function simpleDiff(before: string, after: string) {
  const oldLines = before.split("\n");
  const newLines = after.split("\n");
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start += 1;
  let oldEnd = oldLines.length - 1;
  let newEnd = newLines.length - 1;
  while (oldEnd >= start && newEnd >= start && oldLines[oldEnd] === newLines[newEnd]) {
    oldEnd -= 1;
    newEnd -= 1;
  }
  const from = Math.max(0, start - 4);
  const toOld = Math.min(oldLines.length - 1, oldEnd + 4);
  const toNew = Math.min(newLines.length - 1, newEnd + 4);
  const width = String(Math.max(oldLines.length, newLines.length)).length;
  const lines: string[] = [];
  if (from > 0) lines.push(` ${" ".repeat(width)} ...`);
  for (let i = from; i < start; i += 1) lines.push(` ${String(i + 1).padStart(width, " ")} ${oldLines[i]}`);
  for (let i = start; i <= oldEnd; i += 1) lines.push(`-${String(i + 1).padStart(width, " ")} ${oldLines[i]}`);
  for (let i = start; i <= newEnd; i += 1) lines.push(`+${String(i + 1).padStart(width, " ")} ${newLines[i]}`);
  for (let i = Math.max(start, newEnd + 1); i <= toNew; i += 1) lines.push(` ${String(i + 1).padStart(width, " ")} ${newLines[i]}`);
  if (toOld < oldLines.length - 1 || toNew < newLines.length - 1) lines.push(` ${" ".repeat(width)} ...`);
  return { diff: lines.join("\n"), firstChangedLine: start + 1 };
}

function assertRead(read: FileReadResponse, path: string): FileReadResponse {
  if (!read.success) throw new Error(read.error || `Failed to read ${path}`);
  return read;
}

function assertWrite(write: FileWriteResponse, path: string) {
  if (!write.success) throw new Error(write.error || `Failed to write ${path}`);
}

function assertExec(exec: ExecResponse, fallback = "Sandbox command failed") {
  if (exec.success === false || (typeof exec.exitCode === "number" && exec.exitCode !== 0)) {
    const message = [exec.stderr, exec.stdout, exec.error].filter(Boolean).join("\n") || fallback;
    throw new Error(message.length > 100_000 ? `${message.slice(0, 100_000)}\n\n[Truncated]` : message);
  }
}

export class PiContainerTools {
  constructor(
    private readonly workspace: WorkspaceContainer,
    private readonly options: PiContainerToolsOptions = {},
  ) {}

  private async commandEnv(): Promise<Record<string, string> | undefined> {
    const provider = this.options.commandEnv;
    if (!provider) return undefined;
    const env = typeof provider === "function" ? await provider() : provider;
    const clean: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      if (typeof value === "string" && value.length > 0) {
        clean[key] = value;
      }
    }
    return Object.keys(clean).length > 0 ? clean : undefined;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<PiContainerToolResult> {
    switch (name) {
      case "read":
        return this.read(args);
      case "write":
        return this.write(args);
      case "edit":
        return this.edit(args);
      case "ls":
        return this.ls(args);
      case "grep":
        return this.grep(args);
      case "find":
        return this.find(args);
      case "bash":
        return this.bash(args);
      default:
        throw new Error(`Unknown Pi container tool: ${name}`);
    }
  }

  private async read(args: Record<string, unknown>): Promise<PiContainerToolResult> {
    const path = normalizePath(args.path);
    const file = assertRead(await this.workspace.readFile(path) as FileReadResponse, path);
    if (file.isBinary) {
      const mimeType = file.mimeType || imageMime(path);
      if (mimeType?.startsWith("image/") && typeof file.content === "string") {
        const text = `[Image: ${path} (${mimeType}, ${formatSize(file.size ?? 0)})]`;
        return { text, content: [{ type: "image", data: file.content, mimeType }], details: { mimeType, size: file.size ?? 0 } };
      }
      return result("[Binary file omitted. Use bash for binary inspection.]", { isBinary: true, size: file.size ?? 0 });
    }

    const lines = String(file.content ?? "").split("\n");
    const start = typeof args.offset === "number" ? Math.max(0, args.offset - 1) : 0;
    if (start >= lines.length) throw new Error(`Offset ${args.offset} is beyond end of file (${lines.length} lines total)`);
    const end = typeof args.limit === "number" ? Math.min(start + args.limit, lines.length) : lines.length;
    const selected = lines.slice(start, end).join("\n");
    const { content, truncation } = truncateHead(selected);
    const notices: string[] = [];
    if (truncation) {
      const nextOffset = start + truncation.outputLines + 1;
      notices.push(`Showing lines ${start + 1}-${start + truncation.outputLines} of ${lines.length}. Use offset=${nextOffset} to continue.`);
    } else if (end < lines.length) {
      notices.push(`${lines.length - end} more lines in file. Use offset=${end + 1} to continue.`);
    }
    return result(`${content}${notices.length ? `\n\n[${notices.join(" ")}]` : ""}`, truncation ? { truncation } : undefined);
  }

  private async write(args: Record<string, unknown>): Promise<PiContainerToolResult> {
    if (typeof args.content !== "string") throw new Error("content must be a string");
    const path = normalizePath(args.path);
    assertWrite(await this.workspace.writeFile(path, args.content) as FileWriteResponse, path);
    return result(`Successfully wrote ${args.content.length} bytes to ${path}`);
  }

  private async edit(args: Record<string, unknown>): Promise<PiContainerToolResult> {
    const path = normalizePath(args.path);
    const edits = normalizeEdits(args);
    if (edits.length === 0) throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
    const file = assertRead(await this.workspace.readFile(path) as FileReadResponse, path);
    if (file.isBinary) throw new Error(`Cannot edit binary file: ${path}`);
    const before = String(file.content ?? "");
    const after = applyExactEdits(before, edits, path);
    assertWrite(await this.workspace.writeFile(path, after) as FileWriteResponse, path);
    return result(`Successfully replaced ${edits.length} block(s) in ${path}.`, simpleDiff(before, after));
  }

  private async ls(args: Record<string, unknown>): Promise<PiContainerToolResult> {
    const path = normalizePath(args.path);
    const limit = Math.max(1, typeof args.limit === "number" ? args.limit : 500);
    const listing = await this.workspace.listFiles(path, { recursive: false, includeHidden: true }) as ListFilesResponse;
    if (listing.success === false) throw new Error(listing.error || `Failed to list ${path}`);
    const entries = [...(listing.files || [])].sort((a, b) => a.name.localeCompare(b.name));
    const output = entries.slice(0, limit).map((entry) => `${entry.name}${entry.type === "directory" ? "/" : ""}`).join("\n");
    if (!output) return result("(empty directory)");
    const { content, truncation } = truncateHead(output, Number.MAX_SAFE_INTEGER);
    const suffix = entries.length > limit ? `\n\n[${limit} entries limit reached. Use limit=${limit * 2} for more.]` : "";
    return result(`${content}${suffix}`, truncation ? { truncation } : entries.length > limit ? { entryLimitReached: limit } : undefined);
  }

  private async grep(args: Record<string, unknown>): Promise<PiContainerToolResult> {
    if (typeof args.pattern !== "string" || !args.pattern.trim()) throw new Error("pattern is required");
    const path = normalizePath(args.path);
    const limit = Math.max(1, typeof args.limit === "number" ? args.limit : 100);
    const rgArgs = ["rg", "--line-number", "--color=never", "--hidden"];
    if (typeof args.context === "number" && args.context > 0) rgArgs.push("--context", String(Math.floor(args.context)));
    if (args.ignoreCase) rgArgs.push("--ignore-case");
    if (args.literal) rgArgs.push("--fixed-strings");
    if (typeof args.glob === "string" && args.glob.trim()) rgArgs.push("--glob", args.glob);
    rgArgs.push("--", args.pattern, path);

    const exec = await this.workspace.execOnSandbox(rgArgs, { cwd: CONTAINER_CWD }) as ExecResponse;
    if (exec.exitCode === 1) return result("No matches found");
    assertExec(exec, "ripgrep failed");

    let lineTruncated = false;
    const rawLines = String(exec.stdout || "").split("\n").filter(Boolean);
    const selected = rawLines.slice(0, limit).map((line) => {
      const normalized = line.startsWith(`${path}/`)
        ? line.slice(path.length + 1)
        : line.startsWith(`${CONTAINER_CWD}/`)
          ? line.slice(CONTAINER_CWD.length + 1)
          : line;
      const match = normalized.match(/^(.+?)([:-])(\d+)([:-])(.*)$/);
      if (!match) return normalized;
      const text = match[5].length > GREP_MAX_LINE_LENGTH
        ? `${match[5].slice(0, GREP_MAX_LINE_LENGTH)}... [truncated]`
        : match[5];
      lineTruncated ||= text !== match[5];
      return `${match[1]}${match[2]}${match[3]}${match[4]} ${text.trimStart()}`;
    });
    if (selected.length === 0) return result("No matches found");
    const { content, truncation } = truncateHead(selected.join("\n"), Number.MAX_SAFE_INTEGER);
    const notices: string[] = [];
    if (rawLines.length > limit) notices.push(`${limit} matches limit reached. Use limit=${limit * 2} for more, or refine pattern`);
    if (lineTruncated) notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
    return result(
      `${content}${notices.length ? `\n\n[${notices.join(". ")}]` : ""}`,
      {
        ...(truncation ? { truncation } : {}),
        ...(rawLines.length > limit ? { matchLimitReached: limit } : {}),
        ...(lineTruncated ? { linesTruncated: true } : {}),
      },
    );
  }

  private async find(args: Record<string, unknown>): Promise<PiContainerToolResult> {
    const path = normalizePath(args.path);
    const limit = Math.max(1, typeof args.limit === "number" ? args.limit : 1000);
    let pattern = typeof args.pattern === "string" && args.pattern.trim()
      ? args.pattern.trim()
      : typeof args.name === "string" && args.name.trim()
        ? args.name.trim()
        : "*";
    const fdArgs = (binary: string) => {
      const out = [binary, "--glob", "--color=never", "--hidden", "--no-require-git", "--max-results", String(limit)];
      if (pattern.includes("/")) {
        out.push("--full-path");
        if (!pattern.startsWith("/") && !pattern.startsWith("**/") && pattern !== "**") pattern = `**/${pattern}`;
      }
      return [...out, "--", pattern, path];
    };

    let exec = await this.workspace.execOnSandbox(fdArgs("fd"), { cwd: CONTAINER_CWD }) as ExecResponse;
    if (exec.exitCode === 127) exec = await this.workspace.execOnSandbox(fdArgs("fdfind"), { cwd: CONTAINER_CWD }) as ExecResponse;
    assertExec(exec, "fd failed");

    const lines = String(exec.stdout || "").split("\n").map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0) return result("No files found matching pattern");
    const output = lines.map((line) => relativeTo(path, line).replace(/\\/g, "/")).join("\n");
    const { content, truncation } = truncateHead(output, Number.MAX_SAFE_INTEGER);
    const limitReached = lines.length >= limit;
    return result(
      `${content}${limitReached ? `\n\n[${limit} results limit reached. Use limit=${limit * 2} for more, or refine pattern.]` : ""}`,
      { ...(truncation ? { truncation } : {}), ...(limitReached ? { resultLimitReached: limit } : {}) },
    );
  }

  private async bash(args: Record<string, unknown>): Promise<PiContainerToolResult> {
    const command = typeof args.command === "string" ? args.command : "";
    if (!command.trim()) throw new Error("command is required");
    const timeout = typeof args.timeout === "number" ? args.timeout : undefined;
    const execArgs = timeout ? ["timeout", `${Math.ceil(timeout)}s`, "bash", "-lc", command] : ["bash", "-lc", command];
    const exec = await this.workspace.execOnSandbox(execArgs, {
      cwd: normalizePath(args.cwd),
      env: await this.commandEnv(),
    }) as ExecResponse;
    const output = [exec.stdout || "", exec.stderr || ""].filter(Boolean).join("\n") || "(no output)";
    const { content, truncation } = truncateTail(output);
    if (exec.success === false || (typeof exec.exitCode === "number" && exec.exitCode !== 0)) {
      if (timeout && exec.exitCode === 124) throw new Error(`${content}\n\nCommand timed out after ${timeout} seconds`);
      throw new Error(`${content}\n\nCommand exited with code ${exec.exitCode ?? 1}`);
    }
    return result(content, { ...(truncation ? { truncation } : {}), ...(timeout ? { timeout } : {}) });
  }
}
