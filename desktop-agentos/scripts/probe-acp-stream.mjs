import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import commonSoftware from "@rivet-dev/agent-os-common";
import AgentOsPi from "@rivet-dev/agent-os-pi";
import { AgentOs, createHostDirBackend } from "@rivet-dev/agent-os-core";
import AgentOsPiLocal from "../backend/agentos-pi-local.ts";
import {
  agentOsProvider,
  buildAgentOsPiSettings,
  readHostPiAuthFileContents,
} from "../backend/agentos.ts";

const DEFAULT_MODEL = "claude-sonnet-4-20250514";
const DEFAULT_THOUGHT_LEVEL = "medium";
const DEFAULT_PROMPT =
  'Before using any tool, first tell me exactly: Checking now. Then use the ls tool in the current directory. After the tool finishes, tell me exactly: Done checking.';
const VM_WORKSPACE_PATH = "/workspace";
const VM_PI_HOME_PATH = "/home/user/.pi";

function getPiAgentSoftware(adapter) {
  return adapter === "upstream" ? AgentOsPi : AgentOsPiLocal;
}

function normalizeTimestamp(value) {
  return typeof value === "number" ? Math.trunc(value) : 0;
}

function createNormalizedHostDirBackend(options) {
  const backend = createHostDirBackend(options);
  const normalizeStat = (stat) => {
    const record = stat;
    return {
      ...record,
      atimeMs: normalizeTimestamp(record.atimeMs),
      mtimeMs: normalizeTimestamp(record.mtimeMs),
      ctimeMs: normalizeTimestamp(record.ctimeMs),
      birthtimeMs: normalizeTimestamp(record.birthtimeMs),
    };
  };

  return {
    ...backend,
    async stat(path) {
      return normalizeStat(await backend.stat(path));
    },
    async lstat(path) {
      return normalizeStat(await backend.lstat(path));
    },
  };
}

function getSessionUpdate(event) {
  const params = event?.params && typeof event.params === "object"
    ? event.params
    : null;
  if (!params) {
    return null;
  }
  const update =
    params.update && typeof params.update === "object"
      ? params.update
      : params;
  return update && typeof update === "object" ? update : null;
}

function summarizeUpdate(update) {
  if (!update || typeof update !== "object") {
    return null;
  }

  const content = update.content;
  let text = null;
  if (content && typeof content === "object" && content.type === "text") {
    text = typeof content.text === "string" ? content.text : null;
  } else if (Array.isArray(content)) {
    text = content
      .map((entry) => {
        if (entry?.type === "content" && entry.content?.type === "text") {
          return typeof entry.content.text === "string" ? entry.content.text : "";
        }
        return "";
      })
      .join("") || null;
  }

  return {
    sessionUpdate:
      typeof update.sessionUpdate === "string" ? update.sessionUpdate : null,
    text,
    toolCallId:
      typeof update.toolCallId === "string" ? update.toolCallId : null,
    title: typeof update.title === "string" ? update.title : null,
    status: typeof update.status === "string" ? update.status : null,
  };
}

function getProbeOptions(options = {}) {
  return {
    model: options.model ?? process.env.DESKTOP_AGENTOS_MODEL?.trim() ?? DEFAULT_MODEL,
    thoughtLevel:
      options.thoughtLevel ??
      process.env.DESKTOP_AGENTOS_THOUGHT_LEVEL?.trim() ??
      DEFAULT_THOUGHT_LEVEL,
    prompt: options.prompt ?? process.env.DESKTOP_AGENTOS_ACP_PROMPT?.trim() ?? DEFAULT_PROMPT,
    workspaceDirectory: resolve(
      options.workspaceDirectory ??
        process.env.DESKTOP_AGENTOS_WORKSPACE_DIR ??
        process.cwd(),
    ),
    adapter:
      options.adapter ??
      process.env.DESKTOP_AGENTOS_PI_ADAPTER?.trim() ??
      "local",
    keepRuntime:
      options.keepRuntime ??
      process.env.DESKTOP_AGENTOS_KEEP_PROBE_RUNTIME === "1",
  };
}

export async function runAgentOsAcpProbe(options = {}) {
  const probeOptions = getProbeOptions(options);
  const runtimeDirectory = mkdtempSync(
    join(tmpdir(), "camelai-agentos-acp-probe-"),
  );
  const piHomeDirectory = resolve(runtimeDirectory, "pi-home", ".pi");
  const piAgentDirectory = resolve(piHomeDirectory, "agent");
  const piAuthPath = resolve(piAgentDirectory, "auth.json");
  const piSettingsPath = resolve(piAgentDirectory, "settings.json");
  mkdirSync(piAgentDirectory, { recursive: true });

  const hostPiAuth = readHostPiAuthFileContents();
  if (hostPiAuth) {
    writeFileSync(piAuthPath, hostPiAuth, "utf8");
  }
  writeFileSync(
    piSettingsPath,
    `${JSON.stringify(buildAgentOsPiSettings(probeOptions.model, probeOptions.thoughtLevel), null, 2)}\n`,
    "utf8",
  );

  const vm = await AgentOs.create({
    moduleAccessCwd: process.cwd(),
    mounts: [
      {
        path: VM_WORKSPACE_PATH,
        driver: createNormalizedHostDirBackend({
          hostPath: probeOptions.workspaceDirectory,
          readOnly: false,
        }),
      },
      {
        path: VM_PI_HOME_PATH,
        driver: createNormalizedHostDirBackend({
          hostPath: piHomeDirectory,
          readOnly: false,
        }),
      },
    ],
    software: [...commonSoftware, getPiAgentSoftware(probeOptions.adapter)],
  });

  const start = Date.now();
  const events = [];

  try {
    const created = await vm.createSession("pi", {
      cwd: VM_WORKSPACE_PATH,
      env: agentOsProvider.buildSessionEnv(probeOptions.model),
    });

    const sessionId = created.sessionId;
    const unsubscribeSessionEvents = vm.onSessionEvent(sessionId, (event) => {
      const update = getSessionUpdate(event);
      events.push({
        t: Date.now() - start,
        type: "runtime_event",
        update: summarizeUpdate(update),
      });
    });
    const unsubscribePermissions = vm.onPermissionRequest(sessionId, (request) => {
      events.push({
        t: Date.now() - start,
        type: "permission_request",
        request: {
          permissionId: request.permissionId,
          description: request.description,
        },
      });
      void vm.respondPermission(sessionId, request.permissionId, "once");
    });

    const result = await vm.prompt(sessionId, probeOptions.prompt);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));

    unsubscribeSessionEvents();
    unsubscribePermissions();

    return {
      ok: true,
      workspaceDirectory: probeOptions.workspaceDirectory,
      runtimeDirectory,
      model: probeOptions.model,
      thoughtLevel: probeOptions.thoughtLevel,
      prompt: probeOptions.prompt,
      adapter: probeOptions.adapter,
      resultText: result.text,
      error: result.response?.error ?? null,
      events,
    };
  } finally {
    await vm.dispose().catch(() => undefined);
    if (!probeOptions.keepRuntime) {
      rmSync(runtimeDirectory, { recursive: true, force: true });
    }
  }
}

async function main() {
  const result = await runAgentOsAcpProbe();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
