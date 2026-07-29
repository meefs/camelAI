import type { WorkspaceCronDO } from "./workspace-cron";
import { applyTextEdits } from "./text-edit";

export const AUTOMATIONS_VIRTUAL_ROOT = "/workspace/.camelai/automations";

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
  if (!snapshot) throw new Error(`Workflow "${automationId}" not found`);
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
      `Workflow "${automationId}" not found. Create it with create_workflow first.`,
    );
  }
  return {
    text: `Updated workflow ${automationId} to source version ${updated.source_version}`,
    content: [
      {
        type: "text",
        text: `Updated workflow ${automationId} to source version ${updated.source_version}`,
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
  if (!snapshot) throw new Error(`Workflow "${automationId}" not found`);
  const applied = applyTextEdits(snapshot.source, input.edits, input.path);
  const updated = await input.cronStub.updateDeterministicAutomation({
    workspaceId: input.workspaceId,
    id: automationId,
    source: applied.after,
    expectedSourceVersion: snapshot.source_version,
  });
  if (!updated) throw new Error(`Workflow "${automationId}" not found`);
  const text =
    `Successfully replaced ${input.edits.length} block(s) in ${input.path}; ` +
    `updated workflow ${automationId} to source version ${updated.source_version}.`;
  return {
    text,
    content: [{ type: "text", text }],
    details: {
      path: `${AUTOMATIONS_VIRTUAL_ROOT}/${automationId}.js`,
      source: "deterministic_automation",
      automation_id: automationId,
      source_version: updated.source_version,
      replacementCount: input.edits.length,
      usedFuzzyMatch: applied.usedFuzzyMatch,
      diff: applied.diff,
      patch: applied.patch,
      firstChangedLine: applied.firstChangedLine,
    },
  };
}
