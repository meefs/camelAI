export function prepareCodeModeUserCode(userCode: string): string {
  if (!userCode.trim() || /\breturn\b/.test(userCode)) return userCode;

  const trailingWhitespace = userCode.match(/\s*$/)?.[0] ?? "";
  const body = userCode.slice(0, userCode.length - trailingWhitespace.length);
  const lines = body.split("\n");
  const lastCodeLineIndex = lines.findLastIndex((line) => {
    const trimmed = line.trim();
    return trimmed !== "" && !trimmed.startsWith("//");
  });
  if (lastCodeLineIndex < 0) return userCode;

  const lastLine = lines[lastCodeLineIndex];
  const expression = lastLine.trim().replace(/;$/, "").trim();
  if (
    !expression ||
    expression.endsWith("}") ||
    /^(?:break|case|catch|class|const|continue|debugger|default|do|else|export|finally|for|function|if|import|let|return|switch|throw|try|var|while|with)\b/.test(expression)
  ) {
    return userCode;
  }

  const indent = lastLine.match(/^\s*/)?.[0] ?? "";
  lines[lastCodeLineIndex] = `${indent}return ${expression};`;
  return `${lines.join("\n")}${trailingWhitespace}`;
}

export function codeModeWorkerModule(userCode: string): string {
  const executableUserCode = prepareCodeModeUserCode(userCode);
  return `${String.raw`
import { WorkerEntrypoint } from "cloudflare:workers";

const store = new Map();

function stringifyOutput(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function stringifyConsoleArg(value) {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack || value.message;
  return stringifyOutput(value);
}

function createOutputConsole(output) {
  const originalConsole = globalThis.console || {};
  const capture = (...args) => {
    output.push(args.map(stringifyConsoleArg).join(" "));
  };
  return Object.freeze({
    ...originalConsole,
    log: capture,
    info: capture,
    warn: capture,
    error: capture,
  });
}

function hardenTimingSurface() {
  globalThis.performance = undefined;
  globalThis.SharedArrayBuffer = undefined;
  globalThis.Atomics = undefined;

  const NativeDate = Date;
  const coarseNow = () => Math.floor(NativeDate.now() / 1000) * 1000;
  function CoarseDate(...args) {
    if (new.target) {
      return args.length === 0 ? new NativeDate(coarseNow()) : new NativeDate(...args);
    }
    return new NativeDate(coarseNow()).toString();
  }
  Object.setPrototypeOf(CoarseDate, NativeDate);
  CoarseDate.prototype = NativeDate.prototype;
  Object.defineProperty(CoarseDate, "now", { value: coarseNow });
  Object.defineProperty(CoarseDate, "parse", { value: NativeDate.parse });
  Object.defineProperty(CoarseDate, "UTC", { value: NativeDate.UTC });
  globalThis.Date = CoarseDate;
}

const TOOL_CATEGORY_DESCRIPTIONS = Object.freeze({
  workspace: "Read, edit, search, and run commands in the workspace.",
  user_interaction: "Ask the user questions or update visible chat state.",
  communication: "Send external channel messages. These are side-effecting delivery actions.",
  apps: "Inspect deployed apps, previews, visibility, and logs.",
  schedules: "Manage scheduled prompts.",
  workflows: "Manage deterministic JavaScript workflows.",
  integrations: "List, create, and set up workspace integrations.",
  domains: "Manage custom domains for apps.",
  web: "Search or fetch public web content.",
  agents: "Run focused subagents.",
  connections: "Inspect and call workspace connections through env.CONNECTIONS.",
  runtime: "Helpers that exist only inside js_exec.",
  ai_media: "AI and media helpers exposed through env.AI and env.CAMELAI.",
});

const TOOL_HELP_DEFINITION = Object.freeze({
  name: "help",
  description:
    "Show js_exec tool and runtime help. Call await tools.help() for expandable categories, await tools.help(\"communication\") for one category, or await tools.help(\"send_email\") for one tool.",
  parameters: {
    type: "object",
    properties: {
      category: { type: "string", description: "Exact category name to expand." },
      tool: { type: "string", description: "Exact tool name to inspect." },
      runtime: { type: "string", description: "Exact runtime helper name such as env.CAMELAI." },
    },
    additionalProperties: false,
  },
  category: "runtime",
  examples: [
    "await tools.help()",
    "await tools.help(\"communication\")",
    "await tools.help(\"send_email\")",
    "await tools.help({ runtime: \"env.CAMELAI\" })",
  ],
  sideEffect: false,
  externalDelivery: false,
});

const RUNTIME_HELP_ENTRIES = Object.freeze([
  Object.freeze({
    name: "env.WORKSPACE",
    category: "workspace",
    kind: "runtime_binding",
    description:
      "Current workspace metadata helpers, including the inbound email address users can send mail to when configured.",
    examples: [
      "await env.WORKSPACE.info()",
      "await env.WORKSPACE.emailAddress()",
    ],
    methods: [
      {
        name: "info",
        usage: "await env.WORKSPACE.info()",
        returns: "{ id, name, email_address }",
      },
      {
        name: "emailAddress",
        usage: "await env.WORKSPACE.emailAddress()",
        returns: "The workspace email address string, or null when unavailable.",
      },
    ],
  }),
  Object.freeze({
    name: "env.CONNECTIONS",
    category: "connections",
    kind: "runtime_binding",
    description:
      "Virtual Worker binding for listing workspace connections and method catalogs.",
    examples: [
      "await env.CONNECTIONS.list()",
      "await env.CONNECTIONS.methods()",
      "const entry = await env.CONNECTIONS.find(\"clickhouse\")",
    ],
    methods: [
      { name: "list", usage: "await env.CONNECTIONS.list()" },
      { name: "methods", usage: "await env.CONNECTIONS.methods()" },
      { name: "find", usage: "await env.CONNECTIONS.find(\"provider-or-type\")" },
      { name: "test", usage: "await env.CONNECTIONS.test(\"provider-or-type\")" },
      { name: "get", usage: "await env.CONNECTIONS.get(\"connection-id-or-name\")" },
      { name: "tools", usage: "await env.CONNECTIONS.tools(\"connection-id-or-name\")" },
    ],
  }),
  Object.freeze({
    name: "connections",
    category: "connections",
    kind: "runtime_facade",
    description:
      "Convenience facade for calling connection methods after resolving an alias from env.CONNECTIONS.find().",
    examples: [
      "const entry = await env.CONNECTIONS.find(\"clickhouse\"); await connections[entry.alias].query({ query: \"SELECT 1 AS ok\" })",
    ],
  }),
  Object.freeze({
    name: "env.AI",
    category: "ai_media",
    kind: "runtime_binding",
    description:
      "Virtual AI binding. Use run() with model tiers cheap, fast, auto, smart, or an OpenRouter model id.",
    examples: [
      "await env.AI.run(\"auto\", { messages: [{ role: \"user\", content: \"hello\" }] })",
    ],
    methods: [
      { name: "run", usage: "await env.AI.run(\"auto\", { messages })" },
    ],
  }),
  Object.freeze({
    name: "env.CAMELAI",
    category: "ai_media",
    kind: "runtime_binding",
    description:
      "camelAI media helpers for image generation and audio transcription.",
    examples: [
      "await env.CAMELAI.generateImage(\"A product screenshot style hero image\")",
      "await env.CAMELAI.transcribeAudio({ path: \"/mnt/user-uploads/audio.ogg\" })",
      "await env.CAMELAI.help()",
    ],
    methods: [
      {
        name: "generateImage",
        usage: "await env.CAMELAI.generateImage(\"prompt\")",
        parameters: "{ prompt: string, referenceImageUrl?: string } or a prompt string",
        returns: "{ text, imageDataUrl, images }",
      },
      {
        name: "transcribeAudio",
        usage: "await env.CAMELAI.transcribeAudio({ path })",
        parameters: "{ path?: string, base64?: string, mediaType?: string }",
        returns: "{ text }",
      },
      {
        name: "help",
        usage: "await env.CAMELAI.help()",
        returns: "This env.CAMELAI capability catalog.",
      },
    ],
  }),
  Object.freeze({
    name: "text/store/load",
    category: "runtime",
    kind: "runtime_helper",
    description:
      "Use text(value) to append output and store(key, value)/load(key) for per-runner scratch state.",
    examples: [
      "text({ ok: true })",
      "store(\"lastResult\", result); load(\"lastResult\")",
    ],
  }),
]);

function categoryDescription(category) {
  return TOOL_CATEGORY_DESCRIPTIONS[category] || "No category description available.";
}

function cloneHelpValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeHelpInput(input) {
  if (input === undefined || input === null) return {};
  if (typeof input === "string") {
    return { key: input };
  }
  if (typeof input === "object" && !Array.isArray(input)) {
    return input;
  }
  throw new Error("tools.help expects no arguments, a category/tool string, or { category?, tool?, runtime? }");
}

function createToolHelp(allTools) {
  const toolsByName = new Map(allTools.map((tool) => [tool.name.toLowerCase(), tool]));
  const runtimeByName = new Map(RUNTIME_HELP_ENTRIES.map((entry) => [entry.name.toLowerCase(), entry]));
  const categories = new Map();
  for (const tool of allTools) {
    const category = tool.category || "workspace";
    if (!categories.has(category)) {
      categories.set(category, { tools: [], runtimes: [] });
    }
    categories.get(category).tools.push(tool);
  }
  for (const entry of RUNTIME_HELP_ENTRIES) {
    const category = entry.category || "runtime";
    if (!categories.has(category)) {
      categories.set(category, { tools: [], runtimes: [] });
    }
    categories.get(category).runtimes.push(entry);
  }

  function categorySummary() {
    return [...categories.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, entry]) => ({
        name,
        description: categoryDescription(name),
        tool_count: entry.tools.length,
        runtime_count: entry.runtimes.length,
        expand: "await tools.help(" + JSON.stringify(name) + ")",
      }));
  }

  return (input) => {
    const request = normalizeHelpInput(input);
    const requestedKey = typeof request.key === "string" ? request.key.trim().toLowerCase() : "";
    const requestedTool = typeof request.tool === "string" ? request.tool.trim().toLowerCase() : "";
    const requestedCategory = typeof request.category === "string" ? request.category.trim().toLowerCase() : "";
    const requestedRuntime = typeof request.runtime === "string" ? request.runtime.trim().toLowerCase() : "";

    if (!requestedKey && !requestedTool && !requestedCategory && !requestedRuntime) {
      return {
        usage: "Expand a category with await tools.help(\"communication\") or inspect one tool with await tools.help(\"send_email\").",
        categories: categorySummary(),
      };
    }

    const toolKey = requestedTool || requestedKey;
    if (toolKey && toolsByName.has(toolKey)) {
      return { tool: cloneHelpValue(toolsByName.get(toolKey)) };
    }

    const runtimeKey = requestedRuntime || requestedKey;
    if (runtimeKey && runtimeByName.has(runtimeKey)) {
      return { runtime: cloneHelpValue(runtimeByName.get(runtimeKey)) };
    }

    const categoryKey = requestedCategory || requestedKey;
    if (categoryKey && categories.has(categoryKey)) {
      const entry = categories.get(categoryKey);
      return {
        category: categoryKey,
        description: categoryDescription(categoryKey),
        tools: cloneHelpValue(entry.tools),
        runtimes: cloneHelpValue(entry.runtimes),
      };
    }

    return {
      error: "No exact js_exec help entry matched " + JSON.stringify(requestedKey || requestedTool || requestedCategory || requestedRuntime) + ".",
      usage: "Use await tools.help() to list categories, then expand one exact category or tool name.",
      categories: categorySummary(),
    };
  };
}

function createCamelAiFacade(binding) {
  const helpEntry = RUNTIME_HELP_ENTRIES.find((entry) => entry.name === "env.CAMELAI");
  return Object.freeze({
    help: () => cloneHelpValue(helpEntry),
    generateImage: (...args) => binding.generateImage.call(binding, ...args),
    transcribeAudio: (...args) => binding.transcribeAudio.call(binding, ...args),
  });
}

function createWorkspaceFacade(callTool) {
  const info = () => callTool("workspace_info", {});
  return Object.freeze({
    info,
    emailAddress: async () => {
      const workspace = await info();
      return workspace && typeof workspace === "object" ? workspace.email_address || null : null;
    },
  });
}

function createConnectionsFacade(binding) {
  const legacyInvokeMethod = ["_", "_", "invoke"].join("");
  const invokeConnectionMethod = (request) => {
    if (typeof binding.invoke === "function") {
      return binding.invoke(request);
    }
    if (typeof binding[legacyInvokeMethod] === "function") {
      return binding[legacyInvokeMethod](request);
    }
    throw new Error("CONNECTIONS method invocation is not configured");
  };

  function responseFromFetchPayload(payload) {
    if (!payload || typeof payload !== "object" || typeof payload.status !== "number") {
      return payload;
    }
    const headers = new Headers(payload.headers || {});
    if (payload.truncated) headers.set("x-camelai-truncated", "true");
    return new Response(payload.bodyText || "", {
      status: payload.status,
      statusText: payload.statusText || "",
      headers,
    });
  }

  async function serializeFetchInput(input) {
    if (input instanceof Request) {
      return {
        input: input.url,
        init: {
          method: input.method,
          headers: Object.fromEntries(input.headers.entries()),
          body: input.method === "GET" || input.method === "HEAD" ? undefined : await input.text(),
        },
      };
    }
    return { input: String(input), init: {} };
  }

  function serializeFetchInit(init) {
    if (!init || typeof init !== "object") return {};
    const output = { ...init };
    if (init.headers) {
      output.headers = Object.fromEntries(new Headers(init.headers).entries());
    }
    return output;
  }

  return new Proxy({}, {
    get(_target, connectionName) {
      if (connectionName === "then") return undefined;
      if (connectionName === "$methods") return () => binding.methods();
      if (connectionName === "$find") return (query) => binding.find(query);
      if (connectionName === "$test") return (query) => binding.test(query);
      if (connectionName === "$list") return () => binding.list();
      if (connectionName === "$get") return (connection) => binding.get(connection);
      if (connectionName === "$tools") return (connection) => binding.tools(connection);
      if (typeof connectionName !== "string") return binding[connectionName];
      if ([
        "list",
        "get",
        "tools",
        "methods",
        "find",
        "test",
        "invoke",
        legacyInvokeMethod,
      ].includes(connectionName)) {
        const value = binding[connectionName];
        return typeof value === "function" ? (...args) => value.apply(binding, args) : value;
      }

      return new Proxy({}, {
        get(_connectionTarget, methodName) {
          if (methodName === "then") return undefined;
          if (typeof methodName !== "string") return undefined;
          return async (...args) => {
            let input = args[0] ?? {};
            if (methodName === "fetch") {
              const serialized = await serializeFetchInput(args[0] ?? "");
              input = {
                ...serialized,
                init: {
                  ...serialized.init,
                  ...serializeFetchInit(args[1]),
                },
              };
            }
            const result = await invokeConnectionMethod({
              connection: connectionName,
              method: methodName,
              input,
            });
            return methodName === "fetch" ? responseFromFetchPayload(result) : result;
          };
        },
      });
    },
  });
}

function createToolBackedConnectionsBinding(callTool) {
  return Object.freeze({
    list: () => callTool("connections_list", {}),
    get: (connection) => callTool("connections_get", { connection }),
    tools: (connection) => callTool("connections_tools", { connection }),
    methods: () => callTool("connections_methods", {}),
    find: (query) => callTool("connections_find", { query }),
    test: (query) => callTool("connections_test", { query }),
    invoke: (request) => callTool("connections_invoke", request),
  });
}

async function runUserCode(tools, CONNECTIONS, connections, env, context, ALL_TOOLS, text, store, load) {
  "use strict";
`}${executableUserCode}${String.raw`
}

export class CodeModeRunner extends WorkerEntrypoint {
  async run() {
    hardenTimingSurface();
    const output = [];
    globalThis.console = createOutputConsole(output);
    const registeredTools = Object.freeze((await this.env.TOOLS.listTools()).map((tool) => Object.freeze({
      ...tool,
      parameters: tool.parameters,
      examples: Array.isArray(tool.examples) ? tool.examples : [],
      sideEffect: Boolean(tool.sideEffect),
      externalDelivery: Boolean(tool.externalDelivery),
    })));
    const allTools = Object.freeze([
      TOOL_HELP_DEFINITION,
      ...registeredTools,
    ]);
    const callTool = (name, args = {}) => this.env.TOOLS.callTool(name, args);
    const help = createToolHelp(allTools);
    const toolEntries = registeredTools.map((tool) => [tool.name, (args = {}) => callTool(tool.name, args)]);
    const tools = Object.freeze(Object.fromEntries([
      ["help", help],
      ...toolEntries,
    ]));
    const CONNECTIONS_BINDING = createToolBackedConnectionsBinding(callTool);
    const connections = createConnectionsFacade(CONNECTIONS_BINDING);
    const CONNECTIONS = connections;
    const AI = this.env.AI;
    const CAMELAI = createCamelAiFacade(this.env.CAMELAI);
    const WORKSPACE = createWorkspaceFacade(callTool);
    const env = Object.freeze({ CONNECTIONS, AI, CAMELAI, WORKSPACE });
    const context = Object.freeze({ cloudflare: Object.freeze({ env, connections }) });
    const text = (value) => {
      output.push(stringifyOutput(value));
    };
    const load = (key) => {
      if (typeof key !== "string" || !key) throw new Error("load key must be a non-empty string");
      return store.get(key);
    };
    const save = (key, value) => {
      if (typeof key !== "string" || !key) throw new Error("store key must be a non-empty string");
      store.set(key, value);
    };

    const result = await runUserCode(
      tools,
      CONNECTIONS,
      connections,
      env,
      context,
      allTools,
      text,
      save,
      load,
    );
    if (result !== undefined) output.push(stringifyOutput(result));
    return { text: output.join("\n") };
  }
}
`}`;
}
