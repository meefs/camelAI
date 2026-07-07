export type RuntimeItem = Record<string, unknown>;

export type RuntimeEvidence = {
  commands: string[];
  jsExecCodeBlocks: string[];
  tools: string[];
};

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function runtimeToolName(item: RuntimeItem): string | undefined {
  return asString(item.tool)?.toLowerCase();
}

function isJsExecItem(item: RuntimeItem): boolean {
  const tool = runtimeToolName(item);
  return tool === "js_exec" || tool?.endsWith("__js_exec") === true;
}

function collectRuntimeItems(events: Array<Record<string, unknown>>): RuntimeItem[] {
  const items: RuntimeItem[] = [];
  for (const rawEvent of events) {
    const event = asRecord(rawEvent);
    if (event?.type !== "runtime_event") continue;
    const runtimeEvent = asRecord(event.event);
    if (runtimeEvent?.method !== "item/completed") continue;
    const params = asRecord(runtimeEvent.params);
    const item = asRecord(params?.item);
    if (item) items.push(item);
  }
  return items;
}

export function collectRuntimeEvidence(
  events: Array<Record<string, unknown>>,
): RuntimeEvidence {
  const items = collectRuntimeItems(events);
  const jsExecCodeBlocks = items
    .filter(isJsExecItem)
    .map((item) => asString(asRecord(item.arguments)?.code) ?? "")
    .filter(Boolean);
  const topLevelCommands = items
    .filter((item) => item.type === "commandExecution")
    .map((item) => asString(item.command) ?? "")
    .filter(Boolean);
  const topLevelTools = items
    .map(runtimeToolName)
    .filter((tool): tool is string => Boolean(tool));
  return {
    commands: uniqueStrings(topLevelCommands),
    jsExecCodeBlocks,
    tools: uniqueStrings(topLevelTools),
  };
}

export function jsExecCodeMentionsTool(code: string, toolName: string): boolean {
  const stripped = stripComments(code);
  const escaped = escapeRegex(toolName);
  return [
    new RegExp(`\\btools\\s*\\.\\s*${escaped}\\s*\\(`, "i"),
    new RegExp(`\\btools\\s*\\[\\s*(["'\`])${escaped}\\1\\s*\\]\\s*\\(`, "i"),
    new RegExp(`\\bcallTool\\s*\\(\\s*(["'\`])${escaped}\\1`, "i"),
  ].some((pattern) => pattern.test(stripped));
}

export function usedTool(
  events: Array<Record<string, unknown>>,
  toolName: string,
  extraCodePatterns: RegExp[] = [],
): boolean {
  const expected = toolName.toLowerCase();
  const evidence = collectRuntimeEvidence(events);
  return (
    evidence.tools.some((tool) => tool === expected || tool.endsWith(`__${expected}`)) ||
    evidence.jsExecCodeBlocks.some((code) =>
      jsExecCodeMentionsTool(code, expected) ||
      extraCodePatterns.some((pattern) => pattern.test(stripComments(code)))
    )
  );
}

export function runtimeToolMentionOrder(
  events: Array<Record<string, unknown>>,
  toolNames: string[],
): string[] {
  const expected = toolNames.map((toolName) => toolName.toLowerCase());
  const ordered: string[] = [];
  for (const item of collectRuntimeItems(events)) {
    const tool = runtimeToolName(item);
    if (tool && expected.some((name) => tool === name || tool.endsWith(`__${name}`))) {
      ordered.push(tool.includes("__") ? tool.slice(tool.lastIndexOf("__") + 2) : tool);
    }
    if (!isJsExecItem(item)) continue;
    const code = asString(asRecord(item.arguments)?.code) ?? "";
    const stripped = stripComments(code);
    const matches = expected.flatMap((toolName) => {
      const escaped = escapeRegex(toolName);
      const patterns = [
        new RegExp(`\\btools\\s*\\.\\s*${escaped}\\s*\\(`, "gi"),
        new RegExp(`\\btools\\s*\\[\\s*(["'\`])${escaped}\\1\\s*\\]\\s*\\(`, "gi"),
        new RegExp(`\\bcallTool\\s*\\(\\s*(["'\`])${escaped}\\1`, "gi"),
      ];
      return patterns.flatMap((pattern) =>
        [...stripped.matchAll(pattern)].map((match) => ({
          index: match.index ?? Number.MAX_SAFE_INTEGER,
          toolName,
        })),
      );
    });
    matches
      .sort((left, right) => left.index - right.index)
      .forEach((match) => ordered.push(match.toolName));
  }
  return ordered;
}

export function legacyDeployPathEvidence(
  events: Array<Record<string, unknown>>,
): string[] {
  const evidence = collectRuntimeEvidence(events);
  const failures: string[] = [];
  const legacyTools = ["vm_exec", "clone_project"].filter((tool) =>
    usedTool(events, tool),
  );
  if (legacyTools.length) {
    failures.push(`used legacy project tool(s): ${legacyTools.join(", ")}`);
  }

  const topLevelDeployCommands = evidence.commands.filter((command) =>
    /\b(create-worker|bun\s+run\s+deploy|wrangler\s+deploy|wrangler\s+init|npm\s+create\s+cloudflare|pnpm\s+create\s+cloudflare|yarn\s+create\s+cloudflare)\b/i
      .test(command),
  );
  if (topLevelDeployCommands.length) {
    failures.push(
      `used legacy deploy command(s): ${topLevelDeployCommands.join(", ")}`,
    );
  }

  const jsExecLegacyDeploy = evidence.jsExecCodeBlocks.some((code) => {
    const stripped = stripComments(code);
    const callsShell =
      jsExecCodeMentionsTool(stripped, "bash") ||
      jsExecCodeMentionsTool(stripped, "vm_exec") ||
      /\bvm\s*\.\s*exec\s*\(/i.test(stripped) ||
      /\bVM\s*\.\s*exec\s*\(/.test(stripped);
    return callsShell &&
      /\b(create-worker|bun\s+run\s+deploy|wrangler\s+deploy|wrangler\s+init|npm\s+create\s+cloudflare|pnpm\s+create\s+cloudflare|yarn\s+create\s+cloudflare)\b/i
        .test(stripped);
  });
  if (jsExecLegacyDeploy) {
    failures.push("used shell/vm legacy scaffold or deploy command inside js_exec");
  }

  return failures;
}

export async function fetchWithRetry(
  url: string,
  init?: RequestInit,
  attempts = 8,
): Promise<Response> {
  let lastError: unknown;
  const method = (init?.method ?? "GET").toUpperCase();
  const canRetryResponse = method === "GET" || method === "HEAD";
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, init);
      const shouldRetryStatus =
        response.status === 404 ||
        response.status === 408 ||
        response.status === 425 ||
        response.status === 429 ||
        response.status >= 500;
      if (!canRetryResponse || !shouldRetryStatus || attempt === attempts - 1) {
        return response;
      }
      lastError = new Error(`HTTP ${response.status}`);
      try {
        await response.body?.cancel();
      } catch {
        // Best effort: avoid leaking retried response bodies in the eval harness.
      }
    } catch (error) {
      lastError = error;
      if (attempt === attempts - 1) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 750 * (attempt + 1)));
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
