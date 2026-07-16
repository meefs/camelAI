import Defuddle from "defuddle";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";

type WebProvider = "cloudflare" | "firecrawl" | "parallel" | "exa";
type SearchProvider = Exclude<WebProvider, "cloudflare">;
type WebResultProvider = WebProvider | "direct";

interface CodeModeWebSearchEnv {
  APP_KV: KVNamespace;
  BROWSER?: Fetcher;
  FIRECRAWL_API_KEY?: string;
  FIRECRAWL_BASE_URL?: string;
  PARALLEL_API_KEY?: string;
  PARALLEL_BASE_URL?: string;
  EXA_API_KEY?: string;
  EXA_BASE_URL?: string;
  WEB_PROVIDER_ORDER?: string;
  CHIRIDION_WEB_PROVIDER_ORDER?: string;
}

interface WebResult {
  title?: string;
  url?: string;
  publishedDate?: string;
  author?: string;
  snippet?: string;
  text?: string;
}

interface WebProviderResult {
  provider: WebResultProvider;
  results: WebResult[];
  costUSD: number;
  durationMs?: number;
}

const WEB_SEARCH_PROVIDER_DEFAULT_ORDER: SearchProvider[] = ["firecrawl", "parallel", "exa"];
const WEB_FETCH_PROVIDER_DEFAULT_ORDER: WebProvider[] = ["cloudflare", "exa", "firecrawl", "parallel"];
const WEB_PROVIDER_ROUND_ROBIN_KEY = "code-mode:web-provider:index";
const WEB_PROVIDER_TIMEOUT_MS = 20_000;
const CLOUDFLARE_BROWSER_GOTO_TIMEOUT_MS = 3_000;
const CLOUDFLARE_BROWSER_ACTION_TIMEOUT_MS = 5_000;
const CLOUDFLARE_BROWSER_DEADLINE_MS = 9_000;
const DIRECT_WEB_FETCH_TIMEOUT_MS = 2_500;
const DIRECT_WEB_FETCH_MAX_REDIRECTS = 5;
const DIRECT_WEB_FETCH_MAX_BYTES = 1_900_000;
const BROWSER_WEB_FETCH_MAX_BYTES = 2_500_000;
const WEB_MARKDOWN_INPUT_TEXT_LIMIT = 20_000;
const WEB_RESULT_TITLE_MAX_CHARACTERS = 500;
const WEB_RESULT_AUTHOR_MAX_CHARACTERS = 300;
const DIRECT_WEB_FETCH_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
const WEB_FETCH_REJECT_REQUEST_PATTERNS = [
  "/^https?:\\/\\/[^@\\/]+@/i",
  "/^https?:\\/\\/(?:localhost(?:\\.localdomain)?|[^\\/]+\\.(?:localhost|local|internal))(?::\\d+)?(?:[\\/?#]|$)/i",
  "/^https?:\\/\\/(?:0|10|127|169\\.254|172\\.(?:1[6-9]|2\\d|3[01])|192\\.(?:0|168)|198\\.1[89])(?:\\.\\d{1,3}){0,3}(?::\\d+)?(?:[\\/?#]|$)/i",
  "/^https?:\\/\\/100\\.(?:6[4-9]|[7-9]\\d|1[01]\\d|12[0-7])(?:\\.\\d{1,3}){2}(?::\\d+)?(?:[\\/?#]|$)/i",
  "/^https?:\\/\\/(?:22[4-9]|2[3-4]\\d|25[0-5])(?:\\.\\d{1,3}){3}(?::\\d+)?(?:[\\/?#]|$)/i",
  "/^https?:\\/\\/\\[(?:::|::1|::ffff:|fc|fd|fe[89ab])[^\\]]*\\](?::\\d+)?(?:[\\/?#]|$)/i",
];

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? Math.trunc(value) : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function truncateText(value: unknown, maxCharacters: number): string {
  const text = String(value ?? "");
  if (text.length <= maxCharacters) return text;
  return `${text.slice(0, maxCharacters)}\n\n[Truncated: ${maxCharacters} of ${text.length} characters]`;
}

function stringParam(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  return typeof value === "string" ? value.trim() : "";
}

function defaultString(value: string, fallback: string): string {
  return value.trim() ? value : fallback;
}

function contentString(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map(contentString).map((text) => text.trim()).filter(Boolean).join("\n\n");
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function firstString(values: Record<string, unknown> | undefined, ...keys: string[]): string {
  if (!values) return "";
  for (const key of keys) {
    const text = contentString(values[key]).trim();
    if (text) return text;
  }
  return "";
}

function firstContent(values: Record<string, unknown>, ...keys: string[]): string {
  return firstString(values, ...keys);
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function payloadMessage(payload: Record<string, unknown>): string {
  const error = payload.error;
  if (typeof error === "string" && error.trim()) return error.trim();
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  const message = payload.message;
  if (typeof message === "string" && message.trim()) return message.trim();
  if (Array.isArray(payload.errors)) {
    const messages = payload.errors.flatMap((entry) => {
      if (typeof entry === "string" && entry.trim()) return [entry.trim()];
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const errorRecord = entry as Record<string, unknown>;
      const errorMessage = typeof errorRecord.message === "string"
        ? errorRecord.message.trim()
        : "";
      const code = typeof errorRecord.code === "number" || typeof errorRecord.code === "string"
        ? String(errorRecord.code)
        : "";
      if (!errorMessage) return [];
      return [code ? `${errorMessage} (${code})` : errorMessage];
    });
    if (messages.length > 0) return messages.join("; ");
  }
  return "unknown error";
}

function parseIPv4(hostname: string): number[] | null {
  const parts = hostname.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => /^\d+$/.test(part) ? Number.parseInt(part, 10) : Number.NaN);
  return octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
    ? octets
    : null;
}

function isBlockedIPv4(octets: number[]): boolean {
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function assertPublicWebURL(url: URL): void {
  if (url.username || url.password) {
    throw new Error("Web fetch URL must not include embedded credentials");
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (
    hostname === "localhost" ||
    hostname === "localhost.localdomain" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    throw new Error("Web fetch URL must not point to a local hostname");
  }
  const ipv4 = parseIPv4(hostname);
  if (ipv4 && isBlockedIPv4(ipv4)) {
    throw new Error("Web fetch URL must not point to a private, loopback, or link-local IP address");
  }
  if (
    hostname.includes(":") &&
    (hostname === "::" ||
      hostname === "::1" ||
      hostname.startsWith("::ffff:") ||
      hostname.startsWith("fc") ||
      hostname.startsWith("fd") ||
      /^fe[89ab]/.test(hostname))
  ) {
    throw new Error("Web fetch URL must not point to a private, loopback, or link-local IP address");
  }
}

async function readResponseTextLimited(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: "", truncated: false };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let bytesRead = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - bytesRead;
      if (remaining <= 0) {
        truncated = true;
        await reader.cancel();
        break;
      }
      const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      bytesRead += chunk.byteLength;
      parts.push(decoder.decode(chunk, { stream: true }));
      if (chunk.byteLength < value.byteLength) {
        truncated = true;
        await reader.cancel();
        break;
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The stream may already be closed after a complete read.
    }
  }
  parts.push(decoder.decode());
  return { text: parts.join(""), truncated };
}

function isLikelyHTML(contentType: string, text: string): boolean {
  return /(?:text\/html|application\/xhtml\+xml)/i.test(contentType) ||
    /^\s*(?:<!doctype\s+html|<html\b)/i.test(text);
}

function isLikelyBlockPage(text: string): boolean {
  if (text.length > 50_000) return false;
  const sample = text.slice(0, 8_000).toLowerCase();
  return [
    "just a moment",
    "verify you are human",
    "enable javascript and cookies to continue",
    "checking your browser",
    "attention required! | cloudflare",
    "captcha",
    "access denied",
    "request blocked",
    "please enable javascript",
    "javascript is required",
    "you need to enable javascript",
  ].some((marker) => sample.includes(marker));
}

function isUsableDirectText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length >= 100 && trimmed.replace(/\s/g, "").length >= 80 && !isLikelyBlockPage(trimmed);
}

function isUsableConvertedMarkdown(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 100 || trimmed.replace(/\s/g, "").length < 80 || isLikelyBlockPage(trimmed)) {
    return false;
  }
  if (trimmed.length < 500) {
    const sample = trimmed.toLowerCase();
    if ([
      "loading client-side",
      "loading application",
      "application shell",
      "initializing application",
      "please wait while the application",
    ].some((marker) => sample.includes(marker))) return false;
  }
  return true;
}

function normalizeMarkdown(markdown: string): string {
  const withoutImages = markdown.replace(
    /!\[([^\]]*)\]\([^\n]*?\)(?=\s|$)/g,
    (_match, alt: string) => alt.trim(),
  );
  const withoutJavascriptLinks = withoutImages.replace(
    /\[([^\]]+)\]\(javascript:[^\n]*?\)/gi,
    "$1",
  );
  const normalized: string[] = [];
  let fence: string | null = null;
  for (const rawLine of withoutJavascriptLinks.split("\n")) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(rawLine);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1][0];
      else if (fence === fenceMatch[1][0]) fence = null;
      normalized.push(rawLine);
      continue;
    }
    if (fence) {
      normalized.push(rawLine);
      continue;
    }
    // Negotiated Markdown is often MDX. Strip only standalone presentation
    // wrappers; inline components may contain meaningful prose.
    if (/^\s*<\/?[A-Z][A-Za-z0-9_.:-]*(?:\s[^<>]*)?\/?>\s*$/.test(rawLine)) continue;
    const line = rawLine
      .replace(/^(#{1,6}\s+.*?)\s+\{\/\*.*?\*\/\}\s*$/, "$1")
      .replace(/[ \t]+$/g, "");
    if (line.trim() && normalized.at(-1)?.trim() === line.trim()) continue;
    normalized.push(line);
  }
  return normalized.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function fitMarkdown(markdown: string, maxCharacters: number): string {
  if (markdown.length <= maxCharacters) return markdown;
  const reserve = Math.min(2_000, Math.max(400, Math.floor(maxCharacters * 0.18)));
  const contentBudget = Math.max(200, maxCharacters - reserve);
  const lines = markdown.split("\n");
  const blocks: Array<{ start: number; end: number; text: string }> = [];
  let blockStart = 0;
  let inFence = false;
  for (let index = 0; index <= lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^\s*(`{3,}|~{3,})/.test(line)) inFence = !inFence;
    if (index === lines.length || (!inFence && line.trim() === "")) {
      if (index > blockStart) {
        blocks.push({
          start: blockStart,
          end: index,
          text: lines.slice(blockStart, index).join("\n"),
        });
      }
      blockStart = index + 1;
    }
  }

  const kept: string[] = [];
  let used = 0;
  let cutoffLine = lines.length;
  for (const block of blocks) {
    const addition = (kept.length ? 2 : 0) + block.text.length;
    if (used + addition > contentBudget) {
      cutoffLine = block.start;
      break;
    }
    kept.push(block.text);
    used += addition;
  }
  if (kept.length === 0) {
    const firstBlock = blocks[0];
    const fenceMatch = firstBlock && /^\s*(`{3,}|~{3,})[^\n]*\n/.exec(firstBlock.text);
    if (firstBlock && fenceMatch) {
      const closingFence = fenceMatch[1];
      const available = Math.max(100, contentBudget - closingFence.length - 2);
      let excerpt = firstBlock.text.slice(0, available).trimEnd();
      const lastNewline = excerpt.lastIndexOf("\n");
      if (lastNewline > fenceMatch[0].length) excerpt = excerpt.slice(0, lastNewline);
      kept.push(`${excerpt}\n${closingFence}`);
      cutoffLine = firstBlock.end;
    } else {
      let excerpt = markdown.slice(0, contentBudget).trimEnd();
      const lastNewline = excerpt.lastIndexOf("\n");
      if (lastNewline > contentBudget * 0.7) excerpt = excerpt.slice(0, lastNewline);
      kept.push(excerpt);
      cutoffLine = excerpt.split("\n").length;
    }
  }

  const headings: string[] = [];
  let omittedFence: string | null = null;
  for (const line of lines.slice(cutoffLine)) {
    const omittedFenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (omittedFenceMatch) {
      if (!omittedFence) omittedFence = omittedFenceMatch[1][0];
      else if (omittedFence === omittedFenceMatch[1][0]) omittedFence = null;
      continue;
    }
    if (omittedFence) continue;
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const title = match[2].replace(/\s+\{\/\*.*?\*\/\}\s*$/, "").trim();
    if (title) headings.push(`${"  ".repeat(Math.max(0, match[1].length - 2))}- ${title}`);
  }
  const suffixParts = [
    `[Content shortened: showing structured excerpt from ${markdown.length.toLocaleString()} characters.]`,
  ];
  if (headings.length) suffixParts.push(`Omitted sections:\n${headings.join("\n")}`);
  const prefix = kept.join("\n\n");
  const suffix = suffixParts.join("\n\n");
  const availableSuffix = Math.max(0, maxCharacters - prefix.length - 2);
  return `${prefix}\n\n${suffix.slice(0, availableSuffix)}`.trimEnd();
}

function removeSequentialNumberGutters(html: string): {
  html: string;
  sequentialRunsRemoved: number;
} {
  const { document } = parseHTML("<html><body></body></html>");
  const body = document.body;
  body.innerHTML = html;
  let sequentialRunsRemoved = 0;
  const codeLeadingPattern = /^\s*(?:import|export|const|let|var|function|class|def|from|package|#include|select|create)\b/i;
  const hasExplicitSourceHint = (element: Element): boolean =>
    ["class", "id", "aria-label", "data-testid", "title"]
      .some((attribute) => /(?:source|code|blob|diff|gutter|line[-_ ]?(?:number|num))/i.test(
        element.getAttribute(attribute) ?? "",
      ));
  const sourceLineNumber = (cell: Element | null): number => {
    if (!cell) return Number.NaN;
    const candidates = [
      cell.textContent?.trim() ?? "",
      cell.getAttribute("data-line-number") ?? "",
      cell.getAttribute("aria-label") ?? "",
      cell.getAttribute("title") ?? "",
      cell.getAttribute("id") ?? "",
    ];
    for (const candidate of candidates) {
      const match = /^(?:line\s*|L)?(\d{1,7})$/i.exec(candidate.trim());
      if (match) return Number(match[1]);
    }
    return Number.NaN;
  };

  // Source viewers commonly render one row per line with a numeric first cell.
  for (const element of Array.from(body.querySelectorAll("*"))) {
    const rows = Array.from(element.children);
    if (rows.length < 20) continue;
    const rowNumbers = rows.map((row) => sourceLineNumber(row.firstElementChild));
    let runStart = 0;
    for (let index = 1; index <= rowNumbers.length; index += 1) {
      const continues = index < rowNumbers.length &&
        Number.isFinite(rowNumbers[index - 1]) &&
        rowNumbers[index] === rowNumbers[index - 1] + 1;
      if (continues) continue;
      const runLength = Number.isFinite(rowNumbers[index - 1]) ? index - runStart : 0;
      const run = rows.slice(runStart, index);
      const sourceHint = hasExplicitSourceHint(element) || run.some((row) =>
        hasExplicitSourceHint(row) ||
        (row.firstElementChild ? hasExplicitSourceHint(row.firstElementChild) : false) ||
        Boolean(row.querySelector("pre, code"))
      );
      const sourceLines = run.map((row) =>
        Array.from(row.children).slice(1).map((cell) => cell.textContent ?? "").join(" ").trim()
      );
      const strongCodeLines = sourceLines.filter((line) => codeLeadingPattern.test(line)).length;
      if (runLength >= 20 && sourceHint && strongCodeLines >= Math.max(5, Math.ceil(runLength * 0.05))) {
        for (const row of run) row.firstElementChild?.remove();
        element.setAttribute("data-web-source-lines", "true");
        sequentialRunsRemoved += 1;
      }
      runStart = index;
    }
  }

  for (const element of Array.from(body.querySelectorAll("*"))) {
    const children = Array.from(element.children);
    if (children.length < 20) continue;
    const numbers = children.map((child) => {
      const value = child.textContent?.trim() ?? "";
      return /^\d{1,7}$/.test(value) ? Number(value) : Number.NaN;
    });
    let runStart = 0;
    for (let index = 1; index <= numbers.length; index += 1) {
      const continues = index < numbers.length &&
        Number.isFinite(numbers[index - 1]) &&
        numbers[index] === numbers[index - 1] + 1;
      if (continues) continue;
      const runLength = Number.isFinite(numbers[index - 1]) ? index - runStart : 0;
      const remainingLines = children
        .slice(0, runStart)
        .concat(children.slice(index))
        .map((child) => child.textContent?.trim() ?? "")
        .filter(Boolean);
      const codeLikeLines = remainingLines.filter((line) =>
        /[{}();=]/.test(line) || codeLeadingPattern.test(line)
      ).length;
      const strongCodeLines = remainingLines.filter((line) => codeLeadingPattern.test(line)).length;
      const hasAdjacentSource = remainingLines.length >= 20 &&
        codeLikeLines >= Math.max(5, Math.ceil(remainingLines.length * 0.1)) &&
        (hasExplicitSourceHint(element) || strongCodeLines >= 5);
      if (runLength >= 20 && hasAdjacentSource) {
        for (const child of children.slice(runStart, index)) child.remove();
        element.setAttribute("data-web-source-lines", "true");
        sequentialRunsRemoved += 1;
      }
      runStart = index;
    }
  }
  return { html: body.innerHTML, sequentialRunsRemoved };
}

function limitHtmlText(html: string, maxTextCharacters: number): {
  html: string;
  originalTextCharacters: number;
  truncated: boolean;
} {
  const { document } = parseHTML("<html><body></body></html>");
  const body = document.body;
  body.innerHTML = html;
  const originalTextCharacters = body.textContent?.length ?? 0;
  if (originalTextCharacters <= maxTextCharacters) {
    return { html, originalTextCharacters, truncated: false };
  }
  let remaining = maxTextCharacters;
  const trim = (node: Node): void => {
    for (const child of Array.from(node.childNodes)) {
      if (remaining <= 0) {
        child.remove();
        continue;
      }
      if (child.nodeType === 3) {
        const text = child.textContent ?? "";
        if (text.length > remaining) child.textContent = text.slice(0, remaining);
        remaining -= Math.min(text.length, remaining);
      } else {
        trim(child);
      }
    }
  };
  trim(body);
  return { html: body.innerHTML, originalTextCharacters, truncated: true };
}

function convertPresentationCodeContainers(html: string): string {
  const { document } = parseHTML("<html><body></body></html>");
  document.body.innerHTML = html;
  for (const element of Array.from(document.body.querySelectorAll('[data-web-source-lines="true"]'))) {
    const children = Array.from(element.children);
    const looksLikeCode = (child: Element): boolean =>
      /[{}();=]|^\s*(?:import|export|const|let|var|function|class|def|from|package|#include|select|create)\b/i
        .test(child.textContent ?? "");
    const firstCodeIndex = children.findIndex(looksLikeCode);
    let lastCodeIndex = -1;
    for (let index = children.length - 1; index >= 0; index -= 1) {
      if (looksLikeCode(children[index])) {
        lastCodeIndex = index;
        break;
      }
    }
    if (firstCodeIndex < 0 || lastCodeIndex < firstCodeIndex) continue;
    const codeChildren = children.slice(firstCodeIndex, lastCodeIndex + 1);
    const codeText = codeChildren.map((child) => child.textContent ?? "").join("\n").trimEnd();
    if (codeChildren.length < 20 || codeText.length < 500) continue;
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.textContent = codeText;
    pre.appendChild(code);
    codeChildren[0].replaceWith(pre);
    for (const child of codeChildren.slice(1)) child.remove();
    element.removeAttribute("data-web-source-lines");
  }
  return document.body.innerHTML;
}

function serializeHtmlToMarkdown(html: string): string {
  const { document } = parseHTML("<html><body></body></html>");
  document.body.innerHTML = html;
  const turndown = new TurndownService({
    bulletListMarker: "*",
    codeBlockStyle: "fenced",
    headingStyle: "atx",
  });
  turndown.remove(["script", "style", "noscript"]);
  return turndown.turndown(document.body as unknown as HTMLElement);
}

async function extractReadableMarkdown(
  html: string,
  targetURL: URL,
  maxCharacters: number,
): Promise<{ text: string; title?: string; author?: string } | null> {
  const { document } = parseHTML(html);
  for (const key of ["URL", "documentURI", "baseURI"] as const) {
    Object.defineProperty(document, key, {
      value: targetURL.toString(),
      configurable: true,
    });
  }
  const parsed = new Defuddle(document as unknown as Document, {
    markdown: false,
    useAsync: false,
  }).parse();
  const resolvedContent = absolutizeHtmlUrls(parsed.content ?? "", targetURL);
  const gutterCleanup = removeSequentialNumberGutters(resolvedContent);
  const limited = limitHtmlText(gutterCleanup.html, WEB_MARKDOWN_INPUT_TEXT_LIMIT);
  const preparedHtml = gutterCleanup.sequentialRunsRemoved > 0
    ? convertPresentationCodeContainers(limited.html)
    : limited.html;
  let markdown = serializeHtmlToMarkdown(preparedHtml);
  markdown = normalizeMarkdown(markdown);
  if (!isUsableConvertedMarkdown(markdown)) return null;
  if (limited.truncated) {
    markdown += `\n\n[Content extraction capped from ${limited.originalTextCharacters.toLocaleString()} text characters.]`;
  }
  return {
    text: fitMarkdown(markdown, maxCharacters),
    title: truncateMetadata(parsed.title, WEB_RESULT_TITLE_MAX_CHARACTERS) || undefined,
    author: truncateMetadata(parsed.author, WEB_RESULT_AUTHOR_MAX_CHARACTERS) || undefined,
  };
}

function absolutizeHtmlUrls(html: string, baseURL: URL): string {
  const { document } = parseHTML("<html><body></body></html>");
  document.body.innerHTML = html;
  for (const [selector, attribute] of [["a[href]", "href"], ["img[src]", "src"]] as const) {
    for (const element of Array.from(document.body.querySelectorAll(selector))) {
      const value = element.getAttribute(attribute);
      if (!value) continue;
      try {
        element.setAttribute(attribute, new URL(value, baseURL).href);
      } catch {
        // Preserve malformed URLs as text rather than dropping page content.
      }
    }
  }
  return document.body.innerHTML;
}

function normalizeDomains(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    let domain = String(entry ?? "").trim();
    if (!domain) continue;
    if (!domain.includes("://")) domain = `https://${domain}`;
    try {
      const parsed = new URL(domain);
      if (parsed.hostname) domain = parsed.hostname;
    } catch {
      // Keep the caller-provided value and normalize below.
    }
    domain = domain.toLowerCase().replace(/^\.+|\.+$/g, "");
    if (domain) out.push(domain);
    if (out.length >= 20) break;
  }
  return out;
}

function anyDomainMatches(hostname: string, domains: string[]): boolean {
  return domains.some((domain) => {
    const normalized = domain.toLowerCase().replace(/^\.+|\.+$/g, "");
    return hostname === normalized || hostname.endsWith(`.${normalized}`);
  });
}

function filterDomains(results: WebResult[], includeDomains: string[], excludeDomains: string[]): WebResult[] {
  return results.filter((result) => {
    if (!result.url) return false;
    let hostname = "";
    try {
      hostname = new URL(result.url).hostname.toLowerCase();
    } catch {
      return false;
    }
    if (includeDomains.length > 0 && !anyDomainMatches(hostname, includeDomains)) return false;
    if (anyDomainMatches(hostname, excludeDomains)) return false;
    return true;
  });
}

function dateOnly(value: unknown): string {
  const match = String(value ?? "").trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? match[0] : "";
}

function firecrawlDate(date: string): string {
  const parts = date.split("-");
  return parts.length === 3 ? `${parts[1]}/${parts[2]}/${parts[0]}` : date;
}

function parallelUsageCostUSD(payload: Record<string, unknown>): number {
  if (!Array.isArray(payload.usage)) return 0;
  let total = 0;
  for (const entry of payload.usage) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const item = entry as Record<string, unknown>;
    const count = numberValue(item.count) ?? 1;
    switch (String(item.name ?? "").trim()) {
      case "sku_search":
        total += count * 0.005;
        break;
      case "sku_extract_excerpts":
      case "sku_extract_full_content":
        total += count * 0.001;
        break;
    }
  }
  return total;
}

function exaCostUSD(payload: Record<string, unknown>): number {
  const cost = payload.costDollars;
  if (!cost || typeof cost !== "object" || Array.isArray(cost)) return 0;
  return numberValue((cost as Record<string, unknown>).total) ?? 0;
}

function normalizeFirecrawlResult(entry: unknown, includeContent: boolean): WebResult | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const item = entry as Record<string, unknown>;
  const metadata = item.metadata && typeof item.metadata === "object" && !Array.isArray(item.metadata)
    ? item.metadata as Record<string, unknown>
    : undefined;
  const targetURL = firstString(item, "url", "sourceURL") || firstString(metadata, "sourceURL", "url");
  if (!targetURL) return null;
  const result: WebResult = {
    title: defaultString(firstString(item, "title"), firstString(metadata, "title", "ogTitle")),
    url: targetURL,
    publishedDate: defaultString(
      firstString(item, "publishedDate", "published_date", "date"),
      firstString(metadata, "publishedDate", "publishedTime", "date"),
    ),
    author: defaultString(firstString(item, "author"), firstString(metadata, "author")),
    snippet: firstContent(item, "description", "snippet"),
  };
  if (includeContent) {
    result.text = firstContent(item, "markdown", "text", "summary", "content") || result.snippet;
  }
  return result;
}

function firecrawlEntries(payload: Record<string, unknown>): unknown[] {
  if (Array.isArray(payload.data)) return payload.data;
  if (!payload.data || typeof payload.data !== "object" || Array.isArray(payload.data)) return [];
  const data = payload.data as Record<string, unknown>;
  return ["web", "news", "images"].flatMap((key) => Array.isArray(data[key]) ? data[key] as unknown[] : []);
}

function normalizeParallelResults(value: unknown, includeContent: boolean): WebResult[] {
  if (!Array.isArray(value)) return [];
  const results: WebResult[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const item = entry as Record<string, unknown>;
    const targetURL = firstString(item, "url");
    if (!targetURL) continue;
    results.push({
      title: firstString(item, "title"),
      url: targetURL,
      publishedDate: firstString(item, "publish_date", "publishedDate", "published_date"),
      snippet: firstContent(item, "description", "snippet", "excerpts"),
      text: includeContent ? defaultString(contentString(item.full_content), contentString(item.excerpts)) : "",
    });
  }
  return results;
}

function normalizeExaResults(value: unknown, includeContent: boolean): WebResult[] {
  if (!Array.isArray(value)) return [];
  const results: WebResult[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const item = entry as Record<string, unknown>;
    const targetURL = firstString(item, "url");
    if (!targetURL) continue;
    results.push({
      title: firstString(item, "title"),
      url: targetURL,
      publishedDate: firstString(item, "publishedDate"),
      author: firstString(item, "author"),
      snippet: firstContent(item, "snippet", "description", "highlights"),
      text: includeContent ? firstContent(item, "text", "summary", "highlights") : "",
    });
  }
  return results;
}

function truncateResultText(text: unknown, maxCharacters: number): string {
  return truncateText(String(text ?? "").trim(), maxCharacters).trim();
}

function truncateMetadata(value: unknown, maxCharacters: number): string {
  return String(value ?? "").trim().slice(0, maxCharacters);
}

function truncateResults(results: WebResult[], limit: number, maxCharacters: number): WebResult[] {
  return results.slice(0, Math.max(0, limit)).map((result) => ({
    ...result,
    title: truncateMetadata(result.title, WEB_RESULT_TITLE_MAX_CHARACTERS),
    author: truncateMetadata(result.author, WEB_RESULT_AUTHOR_MAX_CHARACTERS),
    snippet: truncateResultText(result.snippet, maxCharacters),
    text: truncateResultText(result.text, maxCharacters),
  }));
}

function formatResults(results: WebResult[], maxCharacters: number, empty: string): string {
  if (results.length === 0) return empty;
  return results.map((result, index) => {
    const title = truncateMetadata(result.title, WEB_RESULT_TITLE_MAX_CHARACTERS);
    const lines = [`${index + 1}. ${title || "Untitled"}`];
    if (result.url) lines.push(`URL: ${result.url}`);
    if (result.publishedDate) lines.push(`Published: ${result.publishedDate}`);
    const author = truncateMetadata(result.author, WEB_RESULT_AUTHOR_MAX_CHARACTERS);
    if (author) lines.push(`Author: ${author}`);
    const snippet = truncateResultText(result.snippet, maxCharacters);
    if (snippet) lines.push(`Snippet: ${snippet}`);
    const text = truncateResultText(result.text, maxCharacters);
    if (text) lines.push("", text);
    return lines.join("\n");
  }).join("\n\n");
}

export class CodeModeWebSearch {
  constructor(
    private readonly env: CodeModeWebSearchEnv,
    private readonly sessionId: string,
    private readonly options: {
      cloudflareFetch?: (targetURL: string, maxCharacters: number) => Promise<WebProviderResult>;
      onProviderFailure?: (result: unknown) => Promise<void>;
    } = {},
  ) {}

  async search(args: Record<string, unknown>): Promise<unknown> {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) throw new Error("query is required");
    const numResults = clampInteger(args.numResults, 5, 1, 10);
    const maxCharacters = clampInteger(args.maxCharacters, 1200, 200, 8000);
    const providerResult = await this.withProviderFallback("search", (provider) =>
      this.searchWithProvider(provider, args, query, numResults, maxCharacters)
    );
    const text = formatResults(
      providerResult.results,
      maxCharacters,
      `No results found for ${query}.`,
    );
    return {
      content: [{ type: "text", text }],
      costUSD: providerResult.costUSD,
      provider: providerResult.provider,
      results: providerResult.results,
      success: true,
      query,
      text,
    };
  }

  async fetch(args: Record<string, unknown>): Promise<unknown> {
    const rawUrl = typeof args.url === "string" ? args.url.trim() : "";
    if (!rawUrl) throw new Error("url is required");
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Only http and https URLs are supported");
    }
    assertPublicWebURL(url);
    const maxCharacters = clampInteger(args.maxCharacters, 12_000, 500, 30_000);
    let providerResult: WebProviderResult | null = null;
    try {
      providerResult = await this.directFetch(url, maxCharacters);
    } catch (error) {
      console.warn("Direct web fetch failed; falling back to hosted fetch providers", {
        hostname: url.hostname,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    }
    providerResult ??= await this.withProviderFallback("fetch", (provider) =>
      this.fetchWithProvider(provider, args, url.toString(), maxCharacters)
    );
    const text = formatResults(
      providerResult.results,
      maxCharacters,
      `No content returned for ${url.toString()}.`,
    );
    return {
      content: [{ type: "text", text }],
      costUSD: providerResult.costUSD,
      durationMs: providerResult.durationMs,
      provider: providerResult.provider,
      results: providerResult.results,
      success: true,
      url: url.toString(),
      text,
    };
  }

  private async directFetch(
    initialURL: URL,
    maxCharacters: number,
  ): Promise<WebProviderResult | null> {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), DIRECT_WEB_FETCH_TIMEOUT_MS);
    let currentURL = new URL(initialURL);
    let failureRecorded = false;
    const fail = async (provider: WebResultProvider): Promise<null> => {
      failureRecorded = true;
      await this.options.onProviderFailure?.({
        provider,
        results: [],
        costUSD: 0,
        durationMs: Math.max(0, Date.now() - startedAt),
      });
      return null;
    };
    try {
      let response: Response | undefined;
      for (let redirects = 0; redirects <= DIRECT_WEB_FETCH_MAX_REDIRECTS; redirects += 1) {
        assertPublicWebURL(currentURL);
        response = await globalThis.fetch(currentURL.toString(), {
          headers: {
            accept: "text/markdown, text/html;q=0.9, text/plain;q=0.8, */*;q=0.1",
            "user-agent": DIRECT_WEB_FETCH_USER_AGENT,
          },
          redirect: "manual",
          signal: controller.signal,
        });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location) return await fail("direct");
        if (redirects === DIRECT_WEB_FETCH_MAX_REDIRECTS) return await fail("direct");
        currentURL = new URL(location, currentURL);
        if (currentURL.protocol !== "http:" && currentURL.protocol !== "https:") {
          return await fail("direct");
        }
      }
      if (!response?.ok) {
        await response?.body?.cancel();
        return await fail("direct");
      }

      const contentType = response.headers.get("content-type") || "";
      const potentiallyTextual = /^text\//i.test(contentType) ||
        /(?:json|xml|yaml|javascript|xhtml)/i.test(contentType);
      if (!potentiallyTextual) {
        await response.body?.cancel();
        return await fail("direct");
      }
      const contentLength = Number(response.headers.get("content-length") || "0");
      if (Number.isFinite(contentLength) && contentLength > DIRECT_WEB_FETCH_MAX_BYTES) {
        await response.body?.cancel();
        return await fail("direct");
      }
      const { text: body, truncated } = await readResponseTextLimited(response, DIRECT_WEB_FETCH_MAX_BYTES);
      if (truncated) return await fail("direct");
      if (!isLikelyHTML(contentType, body)) {
        if (!isUsableDirectText(body)) return await fail("direct");
        const markdown = fitMarkdown(normalizeMarkdown(body), maxCharacters);
        if (!isUsableConvertedMarkdown(markdown)) return await fail("direct");
        return {
          provider: "direct",
          results: [{ url: currentURL.toString(), text: markdown }],
          costUSD: 0,
          durationMs: Math.max(0, Date.now() - startedAt),
        };
      }
      if (isLikelyBlockPage(body)) return await fail("direct");

      try {
        const extracted = await extractReadableMarkdown(body, currentURL, maxCharacters);
        if (extracted) {
          return {
            provider: "direct",
            results: [{
              url: currentURL.toString(),
              text: extracted.text,
              title: extracted.title,
              author: extracted.author,
            }],
            costUSD: 0,
            durationMs: Math.max(0, Date.now() - startedAt),
          };
        }
      } catch (error) {
        console.warn("Local web content extraction failed", {
          hostname: currentURL.hostname,
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
      }

      return await fail("direct");
    } catch (error) {
      if (!failureRecorded) await fail("direct");
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private providerBaseURL(provider: WebProvider): string {
    switch (provider) {
      case "cloudflare":
        return "";
      case "firecrawl":
        return (this.env.FIRECRAWL_BASE_URL || "https://api.firecrawl.dev").replace(/\/+$/, "");
      case "parallel":
        return (this.env.PARALLEL_BASE_URL || "https://api.parallel.ai").replace(/\/+$/, "");
      case "exa":
        return (this.env.EXA_BASE_URL || "https://api.exa.ai").replace(/\/+$/, "");
    }
  }

  private providerAPIKey(provider: WebProvider): string {
    switch (provider) {
      case "cloudflare":
        return "";
      case "firecrawl":
        return (this.env.FIRECRAWL_API_KEY || "").trim();
      case "parallel":
        return (this.env.PARALLEL_API_KEY || "").trim();
      case "exa":
        return (this.env.EXA_API_KEY || "").trim();
    }
  }

  private async withProviderFallback(
    operation: "search" | "fetch",
    call: (provider: WebProvider) => Promise<WebProviderResult>,
  ): Promise<WebProviderResult> {
    const configuredProviderOrder = (
      this.env.WEB_PROVIDER_ORDER ||
      this.env.CHIRIDION_WEB_PROVIDER_ORDER ||
      ""
    ).trim();
    const configuredOrder = configuredProviderOrder
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter((value): value is SearchProvider => value === "firecrawl" || value === "parallel" || value === "exa");
    const defaultOrder = operation === "fetch"
      ? WEB_FETCH_PROVIDER_DEFAULT_ORDER
      : WEB_SEARCH_PROVIDER_DEFAULT_ORDER;
    // Fetch is deterministic and independent of search tuning: Cloudflare Browser Run's
    // Content Quick Action gets the first rendered try, followed by Exa, Firecrawl, and Parallel.
    // Search keeps its configured order and round-robin behavior because
    // Browser Run is a page fetcher, not a search index.
    const preferred: WebProvider[] = operation === "fetch"
      ? [...WEB_FETCH_PROVIDER_DEFAULT_ORDER]
      : configuredOrder.length > 0
        ? [...configuredOrder]
        : [...defaultOrder];
    for (const provider of defaultOrder) {
      if (!preferred.includes(provider)) preferred.push(provider);
    }
    const providers: WebProvider[] = [];
    for (const provider of preferred) {
      const available = provider === "cloudflare"
        ? Boolean(this.env.BROWSER)
        : this.providerAPIKey(provider) !== "";
      if (!providers.includes(provider) && available) providers.push(provider);
    }
    if (operation === "search" && providers.length > 1) {
      let start = 0;
      try {
        const raw = await this.env.APP_KV.get(WEB_PROVIDER_ROUND_ROBIN_KEY);
        const parsed = Number.parseInt(raw || "0", 10);
        start = Number.isFinite(parsed) ? parsed % providers.length : 0;
        await this.env.APP_KV.put(WEB_PROVIDER_ROUND_ROBIN_KEY, String(start + 1));
      } catch (error) {
        console.warn("Failed to update web provider round robin index", error);
      }
      providers.splice(0, providers.length, ...providers.slice(start), ...providers.slice(0, start));
    }
    if (providers.length === 0) {
      throw new Error("no web provider API keys are configured");
    }
    const failures: string[] = [];
    for (const provider of providers) {
      try {
        const result = await call(provider);
        if (operation === "fetch" && result.results.length === 0) {
          throw new Error("returned no usable content");
        }
        return result;
      } catch (error) {
        failures.push(`${provider}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new Error(`${operation} failed for all web providers: ${failures.join("; ")}`);
  }

  private async json(
    provider: WebProvider,
    target: string,
    headers: Record<string, string>,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), WEB_PROVIDER_TIMEOUT_MS);
    try {
      const response = await fetch(target, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...headers,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const raw = await response.text();
      let payload: Record<string, unknown> = {};
      if (raw.trim()) {
        try {
          payload = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          payload = { message: raw.slice(0, 4096) };
        }
      }
      if (!response.ok) {
        throw new Error(`${provider} request failed with HTTP ${response.status}: ${payloadMessage(payload)}`);
      }
      if (payload.success === false) {
        throw new Error(`${provider} request failed: ${payloadMessage(payload)}`);
      }
      return payload;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async searchWithProvider(
    provider: WebProvider,
    args: Record<string, unknown>,
    query: string,
    numResults: number,
    maxCharacters: number,
  ): Promise<WebProviderResult> {
    switch (provider) {
      case "cloudflare":
        throw new Error("Cloudflare Browser Run does not provide web search");
      case "firecrawl":
        return this.firecrawlSearch(args, query, numResults, maxCharacters);
      case "parallel":
        return this.parallelSearch(args, query, numResults, maxCharacters);
      case "exa":
        return this.exaSearch(args, query, numResults, maxCharacters);
    }
  }

  private async fetchWithProvider(
    provider: WebProvider,
    args: Record<string, unknown>,
    targetURL: string,
    maxCharacters: number,
  ): Promise<WebProviderResult> {
    switch (provider) {
      case "cloudflare":
        return this.cloudflareFetch(targetURL, maxCharacters);
      case "firecrawl":
        return this.firecrawlFetch(targetURL, maxCharacters);
      case "parallel":
        return this.parallelFetch(args, targetURL, maxCharacters);
      case "exa":
        return this.exaFetch(args, targetURL, maxCharacters);
    }
  }

  private async cloudflareFetch(
    targetURL: string,
    maxCharacters: number,
  ): Promise<WebProviderResult> {
    if (this.options.cloudflareFetch) {
      return await this.options.cloudflareFetch(targetURL, maxCharacters);
    }
    if (!this.env.BROWSER) {
      throw new Error("Cloudflare Browser Run binding is unavailable");
    }

    const browserRun = this.env.BROWSER as Fetcher & {
      quickAction?: (
        action: "content" | "markdown",
        options: Record<string, unknown>,
      ) => Promise<Response>;
    };
    if (typeof browserRun.quickAction !== "function") {
      throw new Error("Cloudflare Browser Run Quick Actions are unavailable");
    }

    const startedAt = Date.now();
    let deadlineId: ReturnType<typeof setTimeout> | undefined;
    let response: Response;
    try {
      response = await Promise.race([
        browserRun.quickAction("content", {
          url: targetURL,
          gotoOptions: {
            waitUntil: "domcontentloaded",
            timeout: CLOUDFLARE_BROWSER_GOTO_TIMEOUT_MS,
          },
          actionTimeout: CLOUDFLARE_BROWSER_ACTION_TIMEOUT_MS,
          rejectResourceTypes: ["stylesheet", "image", "media", "font"],
          // Quick Actions follow redirects internally. Keep the same local/private
          // destinations blocked throughout navigation, not only for the initial URL.
          rejectRequestPattern: WEB_FETCH_REJECT_REQUEST_PATTERNS,
          bestAttempt: true,
          cacheTTL: 300,
        }),
        new Promise<never>((_resolve, reject) => {
          deadlineId = setTimeout(
            () => reject(new Error(`Cloudflare Browser Run timed out after ${CLOUDFLARE_BROWSER_DEADLINE_MS}ms`)),
            CLOUDFLARE_BROWSER_DEADLINE_MS,
          );
        }),
      ]);
    } catch (error) {
      await this.options.onProviderFailure?.({
        provider: "cloudflare",
        results: [],
        costUSD: 0,
        durationMs: Math.max(0, Date.now() - startedAt),
      });
      throw error;
    } finally {
      if (deadlineId !== undefined) clearTimeout(deadlineId);
    }
    const durationMs = numberValue(response.headers.get("X-Browser-Ms-Used")) ??
      Math.max(0, Date.now() - startedAt);
    let raw: string;
    try {
      const limited = await readResponseTextLimited(response, BROWSER_WEB_FETCH_MAX_BYTES);
      if (limited.truncated) {
        throw new Error("Cloudflare Browser Run response exceeded the size limit");
      }
      raw = limited.text;
    } catch (error) {
      await this.options.onProviderFailure?.({
        provider: "cloudflare",
        results: [],
        costUSD: 0,
        durationMs,
      });
      throw error;
    }
    let payload: Record<string, unknown> = {};
    if (raw.trim()) {
      try {
        payload = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        await this.options.onProviderFailure?.({
          provider: "cloudflare",
          results: [],
          costUSD: 0,
          durationMs,
        });
        throw new Error("Cloudflare Browser Run returned an invalid response");
      }
    }
    if (!response.ok || payload.success !== true) {
      await this.options.onProviderFailure?.({
        provider: "cloudflare",
        results: [],
        costUSD: 0,
        durationMs,
      });
      throw new Error(
        `Cloudflare Browser Run request failed with HTTP ${response.status}: ${payloadMessage(payload)}`,
      );
    }
    const result = typeof payload.result === "string" ? payload.result.trim() : "";
    if (!result || isLikelyBlockPage(result)) {
      await this.options.onProviderFailure?.({
        provider: "cloudflare",
        results: [],
        costUSD: 0,
        durationMs,
      });
      throw new Error("page contained no readable content");
    }
    let extracted: { text: string; title?: string; author?: string } | null = null;
    const looksLikeHTML = /^\s*(?:<!doctype\s+html|<html\b)/i.test(result) ||
      /<(?:body|main|article|section|div|table)\b/i.test(result.slice(0, 8_000));
    if (looksLikeHTML) {
      try {
        extracted = await extractReadableMarkdown(result, new URL(targetURL), maxCharacters);
      } catch (error) {
        console.warn("Rendered web content extraction failed", {
          hostname: new URL(targetURL).hostname,
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
      }
    } else {
      const markdown = fitMarkdown(normalizeMarkdown(result), maxCharacters);
      if (isUsableConvertedMarkdown(markdown)) extracted = { text: markdown };
    }
    if (!extracted) {
      await this.options.onProviderFailure?.({
        provider: "cloudflare",
        results: [],
        costUSD: 0,
        durationMs,
      });
      throw new Error("page contained no readable content after extraction");
    }
    return {
      provider: "cloudflare",
      results: [{
        url: targetURL,
        text: extracted.text,
        title: extracted.title,
        author: extracted.author,
      }],
      // Quick Actions expose browser-time headers, not a per-request dollar meter.
      // Provider and cost remain internal telemetry and are stripped from js_exec.
      costUSD: 0,
      durationMs,
    };
  }

  private async firecrawlSearch(
    args: Record<string, unknown>,
    query: string,
    numResults: number,
    maxCharacters: number,
  ): Promise<WebProviderResult> {
    const includeDomains = normalizeDomains(args.includeDomains);
    const excludeDomains = normalizeDomains(args.excludeDomains);
    const category = String(args.category ?? "").trim();
    const queryParts = [query];
    if (category === "pdf") queryParts.push("filetype:pdf");
    if (includeDomains.length === 1) queryParts.push(`site:${includeDomains[0]}`);
    for (const domain of excludeDomains) queryParts.push(`-site:${domain}`);
    const body: Record<string, unknown> = {
      query: queryParts.join(" "),
      limit: numResults,
      sources: category === "news" ? ["web", "news"] : ["web"],
      ignoreInvalidURLs: true,
      timeout: 30000,
    };
    switch (category) {
      case "github":
        body.categories = ["github"];
        break;
      case "pdf":
        body.categories = ["pdf"];
        break;
      case "research paper":
        body.categories = ["research"];
        break;
    }
    const startDate = dateOnly(args.startPublishedDate);
    const endDate = dateOnly(args.endPublishedDate);
    if (startDate || endDate) {
      const tbs = ["cdr:1"];
      if (startDate) tbs.push(`cd_min:${firecrawlDate(startDate)}`);
      if (endDate) tbs.push(`cd_max:${firecrawlDate(endDate)}`);
      body.tbs = tbs.join(",");
    }
    const payload = await this.json("firecrawl", `${this.providerBaseURL("firecrawl")}/v2/search`, {
      authorization: `Bearer ${this.providerAPIKey("firecrawl")}`,
    }, body);
    const results = firecrawlEntries(payload)
      .map((entry) => normalizeFirecrawlResult(entry, false))
      .filter((result): result is WebResult => result !== null);
    return {
      provider: "firecrawl",
      results: truncateResults(filterDomains(results, includeDomains, excludeDomains), numResults, maxCharacters),
      costUSD: 0.005,
    };
  }

  private async firecrawlFetch(
    targetURL: string,
    maxCharacters: number,
  ): Promise<WebProviderResult> {
    const payload = await this.json("firecrawl", `${this.providerBaseURL("firecrawl")}/v2/scrape`, {
      authorization: `Bearer ${this.providerAPIKey("firecrawl")}`,
    }, {
      url: targetURL,
      formats: ["markdown"],
      onlyMainContent: true,
      timeout: 30000,
      maxAge: 172800000,
    });
    const data = payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)
      ? { ...(payload.data as Record<string, unknown>), url: targetURL }
      : { ...payload, url: targetURL };
    const result = normalizeFirecrawlResult(data, true);
    return {
      provider: "firecrawl",
      results: result ? truncateResults([result], 1, maxCharacters) : [],
      costUSD: 0.001,
    };
  }

  private async parallelSearch(
    args: Record<string, unknown>,
    query: string,
    numResults: number,
    maxCharacters: number,
  ): Promise<WebProviderResult> {
    const includeDomains = normalizeDomains(args.includeDomains);
    const excludeDomains = normalizeDomains(args.excludeDomains);
    const sourcePolicy: Record<string, unknown> = {};
    if (includeDomains.length) sourcePolicy.include_domains = includeDomains;
    if (excludeDomains.length) sourcePolicy.exclude_domains = excludeDomains;
    const afterDate = dateOnly(args.startPublishedDate);
    if (afterDate) sourcePolicy.after_date = afterDate;
    const advanced: Record<string, unknown> = { max_results: numResults };
    if (Object.keys(sourcePolicy).length) advanced.source_policy = sourcePolicy;
    const payload = await this.json("parallel", `${this.providerBaseURL("parallel")}/v1/search`, {
      "x-api-key": this.providerAPIKey("parallel"),
    }, {
      objective: query,
      search_queries: [query],
      mode: String(args.searchType ?? "").trim() === "fast" ? "basic" : "advanced",
      max_chars_total: Math.max(1000, numResults * maxCharacters),
      session_id: this.sessionId,
      advanced_settings: advanced,
    });
    const costUSD = parallelUsageCostUSD(payload) || 0.005;
    return {
      provider: "parallel",
      results: truncateResults(
        filterDomains(normalizeParallelResults(payload.results, false), includeDomains, excludeDomains),
        numResults,
        maxCharacters,
      ),
      costUSD,
    };
  }

  private async parallelFetch(
    args: Record<string, unknown>,
    targetURL: string,
    maxCharacters: number,
  ): Promise<WebProviderResult> {
    const objective = stringParam(args, "query") || `Extract the main content from ${targetURL}.`;
    const payload = await this.json("parallel", `${this.providerBaseURL("parallel")}/v1/extract`, {
      "x-api-key": this.providerAPIKey("parallel"),
    }, {
      urls: [targetURL],
      objective,
      max_chars_total: maxCharacters,
      session_id: this.sessionId,
      advanced_settings: {
        fetch_policy: {
          max_age_seconds: 172800,
          timeout_seconds: 30,
          disable_cache_fallback: false,
        },
        excerpt_settings: { max_chars_per_result: Math.max(1000, Math.min(maxCharacters, 30000)) },
        full_content: { max_chars_per_result: maxCharacters },
      },
    });
    const results = normalizeParallelResults(payload.results, true);
    if (results.length === 0 && Array.isArray(payload.errors) && payload.errors.length > 0) {
      throw new Error("parallel extract returned errors");
    }
    return {
      provider: "parallel",
      results: truncateResults(results, 1, maxCharacters),
      costUSD: parallelUsageCostUSD(payload) || 0.001,
    };
  }

  private async exaSearch(
    args: Record<string, unknown>,
    query: string,
    numResults: number,
    maxCharacters: number,
  ): Promise<WebProviderResult> {
    const body: Record<string, unknown> = {
      query,
      type: stringParam(args, "searchType") || "auto",
      numResults,
    };
    for (const key of ["category", "startPublishedDate", "endPublishedDate"] as const) {
      const value = stringParam(args, key);
      if (value) body[key] = value;
    }
    const includeDomains = normalizeDomains(args.includeDomains);
    const excludeDomains = normalizeDomains(args.excludeDomains);
    if (includeDomains.length) body.includeDomains = includeDomains;
    if (excludeDomains.length) body.excludeDomains = excludeDomains;
    const payload = await this.json("exa", `${this.providerBaseURL("exa")}/search`, {
      "x-api-key": this.providerAPIKey("exa"),
    }, body);
    return {
      provider: "exa",
      results: truncateResults(normalizeExaResults(payload.results, false), numResults, maxCharacters),
      costUSD: exaCostUSD(payload) || 0.007,
    };
  }

  private async exaFetch(
    args: Record<string, unknown>,
    targetURL: string,
    maxCharacters: number,
  ): Promise<WebProviderResult> {
    const body: Record<string, unknown> = {
      urls: [targetURL],
      livecrawl: "fallback",
      livecrawlTimeout: 15000,
    };
    switch (stringParam(args, "content")) {
      case "highlights": {
        const highlights: Record<string, unknown> = { numSentences: 4, highlightsPerUrl: 5 };
        const query = stringParam(args, "query");
        if (query) highlights.query = query;
        body.highlights = highlights;
        break;
      }
      case "summary": {
        const query = stringParam(args, "query");
        body.summary = query ? { query } : {};
        break;
      }
      default:
        body.text = { maxCharacters };
    }
    const payload = await this.json("exa", `${this.providerBaseURL("exa")}/contents`, {
      "x-api-key": this.providerAPIKey("exa"),
    }, body);
    return {
      provider: "exa",
      results: truncateResults(normalizeExaResults(payload.results, true), 1, maxCharacters),
      costUSD: exaCostUSD(payload) || 0.001,
    };
  }
}
