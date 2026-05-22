import type { WorkspaceCronDO } from "./workspace-cron";

export const AUTOMATIONS_VIRTUAL_ROOT = "/home/claude/.camelai/automations";

export function normalizeAutomationVirtualPath(rawPath: string): string | null {
  const trimmed = rawPath.trim();
  if (!trimmed) return null;
  const aliases = [
    AUTOMATIONS_VIRTUAL_ROOT,
    ".camelai/automations",
    "~/.camelai/automations",
  ];
  for (const root of aliases) {
    if (trimmed === root) return "";
    if (trimmed.startsWith(`${root}/`)) {
      return trimmed.slice(root.length + 1).replace(/^\/+/, "");
    }
  }
  return null;
}

function automationIdFromPath(rawPath: string): string | null {
  const normalized = normalizeAutomationVirtualPath(rawPath);
  if (!normalized) return null;
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length !== 1 || !parts[0].endsWith(".js")) return null;
  const id = parts[0].slice(0, -3).trim();
  return id || null;
}

function exactEdits(
  content: string,
  edits: Array<{ oldText: string; newText: string }>,
  path: string,
): string {
  const matches = edits
    .map((edit, index) => {
      if (!edit.oldText) {
        throw new Error(`edits[${index}].oldText must not be empty in ${path}`);
      }
      const first = content.indexOf(edit.oldText);
      if (first === -1) throw new Error(`Could not find edits[${index}] in ${path}`);
      if (content.indexOf(edit.oldText, first + edit.oldText.length) !== -1) {
        throw new Error(`Found multiple occurrences of edits[${index}] in ${path}`);
      }
      return {
        start: first,
        end: first + edit.oldText.length,
        newText: edit.newText,
      };
    })
    .sort((a, b) => a.start - b.start);

  for (let i = 1; i < matches.length; i += 1) {
    if (matches[i - 1].end > matches[i].start) {
      throw new Error(`Automation edits overlap in ${path}`);
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

export async function readAutomationVirtualFile(input: {
  cronStub: DurableObjectStub<WorkspaceCronDO>;
  workspaceId: string;
  path: string;
}): Promise<Record<string, unknown> | null> {
  const automationId = automationIdFromPath(input.path);
  if (!automationId) return null;
  const snapshot = await input.cronStub.getDeterministicAutomationSource(
    input.workspaceId,
    automationId,
  );
  if (!snapshot) {
    throw new Error(`Deterministic automation "${automationId}" not found`);
  }
  return {
    text: snapshot.source,
    content: [{ type: "text", text: snapshot.source }],
    details: {
      path: `${AUTOMATIONS_VIRTUAL_ROOT}/${automationId}.js`,
      size: snapshot.source.length,
      encoding: "utf8",
      source: "deterministic_automation",
      automation_id: automationId,
      source_version: snapshot.source_version,
    },
  };
}

export async function listAutomationVirtualFiles(input: {
  cronStub: DurableObjectStub<WorkspaceCronDO>;
  workspaceId: string;
  path?: string;
}): Promise<Record<string, unknown> | null> {
  if (normalizeAutomationVirtualPath(input.path ?? AUTOMATIONS_VIRTUAL_ROOT) !== "") {
    return null;
  }
  const automations = await input.cronStub.listDeterministicAutomations(
    input.workspaceId,
  );
  const files = automations.map((automation) => `${automation.id}.js`).sort();
  return {
    text: files.length ? files.join("\n") : "(empty directory)",
    content: [{ type: "text", text: files.length ? files.join("\n") : "(empty directory)" }],
    details: {
      path: AUTOMATIONS_VIRTUAL_ROOT,
      files,
      source: "deterministic_automation",
    },
  };
}

export async function writeAutomationVirtualFile(input: {
  cronStub: DurableObjectStub<WorkspaceCronDO>;
  workspaceId: string;
  path: string;
  content: string;
}): Promise<Record<string, unknown> | null> {
  const automationId = automationIdFromPath(input.path);
  if (!automationId) return null;
  const updated = await input.cronStub.updateDeterministicAutomation({
    workspaceId: input.workspaceId,
    id: automationId,
    source: input.content,
  });
  if (!updated) {
    throw new Error(
      `Deterministic automation "${automationId}" not found. Create it with create_deterministic_automation first.`,
    );
  }
  return {
    text: `Updated deterministic automation ${automationId} to source version ${updated.source_version}`,
    content: [
      {
        type: "text",
        text: `Updated deterministic automation ${automationId} to source version ${updated.source_version}`,
      },
    ],
    details: {
      path: `${AUTOMATIONS_VIRTUAL_ROOT}/${automationId}.js`,
      source: "deterministic_automation",
      automation_id: automationId,
      source_version: updated.source_version,
    },
  };
}

export async function editAutomationVirtualFile(input: {
  cronStub: DurableObjectStub<WorkspaceCronDO>;
  workspaceId: string;
  path: string;
  edits: Array<{ oldText: string; newText: string }>;
}): Promise<Record<string, unknown> | null> {
  const automationId = automationIdFromPath(input.path);
  if (!automationId) return null;
  const snapshot = await input.cronStub.getDeterministicAutomationSource(
    input.workspaceId,
    automationId,
  );
  if (!snapshot) throw new Error(`Deterministic automation "${automationId}" not found`);
  const next = exactEdits(snapshot.source, input.edits, input.path);
  return writeAutomationVirtualFile({
    cronStub: input.cronStub,
    workspaceId: input.workspaceId,
    path: input.path,
    content: next,
  });
}
