/** Inlined into dynamic js_exec workers — keep aligned with `generate-image.ts`. */
const JS_EXEC_GENERATE_IMAGE_RUNTIME = String.raw`
function buildGenerateImageMessages(input) {
  const options = typeof input === "string" ? { prompt: input } : input;
  const prompt = options.prompt?.trim();
  if (!prompt) throw new Error("generateImage requires a non-empty prompt");
  const referenceImageUrl = options.referenceImageUrl?.trim();
  if (!referenceImageUrl) return [{ role: "user", content: prompt }];
  return [{
    role: "user",
    content: [
      { type: "image_url", image_url: { url: referenceImageUrl } },
      { type: "text", text: prompt },
    ],
  }];
}

function extractGeneratedImageDataUrl(item) {
  if (!item || typeof item !== "object") return null;
  const imageUrl = item.image_url;
  if (!imageUrl || typeof imageUrl !== "object") return null;
  const url = imageUrl.url;
  return typeof url === "string" && url.trim() ? url.trim() : null;
}

function parseGenerateImageResponse(payload) {
  const empty = { text: null, imageDataUrl: null, images: [] };
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return empty;
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) return empty;
  const firstChoice = choices[0];
  if (!firstChoice || typeof firstChoice !== "object") return empty;
  const message = firstChoice.message;
  if (!message || typeof message !== "object") return empty;
  const text = typeof message.content === "string" && message.content.trim()
    ? message.content.trim()
    : null;
  const images = [];
  const rawImages = message.images;
  if (Array.isArray(rawImages)) {
    for (const [fallbackIndex, item] of rawImages.entries()) {
      const dataUrl = extractGeneratedImageDataUrl(item);
      if (!dataUrl) continue;
      const index = item && typeof item === "object" && typeof item.index === "number"
        ? item.index
        : fallbackIndex;
      images.push({ dataUrl, index });
    }
  }
  images.sort((a, b) => a.index - b.index);
  return {
    text,
    imageDataUrl: images[0]?.dataUrl ?? null,
    images,
  };
}

async function generateImage(ai, input) {
  const messages = buildGenerateImageMessages(input);
  const raw = await ai.run("auto_image", { messages });
  if (raw instanceof ReadableStream) {
    throw new Error("generateImage does not support streaming responses");
  }
  return parseGenerateImageResponse(raw);
}
`;

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

`}${JS_EXEC_GENERATE_IMAGE_RUNTIME}${String.raw`

function createConnectionsFacade(binding) {
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
      if (typeof connectionName !== "string") return undefined;

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
            const result = await binding.__invoke({
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

async function runUserCode(tools, CONNECTIONS, connections, env, context, ALL_TOOLS, text, store, load, generateImage) {
  "use strict";
`}${executableUserCode}${String.raw`
}

export class CodeModeRunner extends WorkerEntrypoint {
  async run() {
    hardenTimingSurface();
    const output = [];
    globalThis.console = createOutputConsole(output);
    const allTools = Object.freeze((await this.env.TOOLS.listTools()).map((tool) => Object.freeze({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })));
    const callTool = (name, args = {}) => this.env.TOOLS.callTool(name, args);
    const tools = Object.freeze(Object.fromEntries(allTools.map((tool) => [tool.name, (args = {}) => callTool(tool.name, args)])));
    const CONNECTIONS = this.env.CONNECTIONS;
    const connections = createConnectionsFacade(CONNECTIONS);
    const AI = this.env.AI;
    const env = Object.freeze({ CONNECTIONS, AI });
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
      generateImage,
    );
    if (result !== undefined) output.push(stringifyOutput(result));
    return { text: output.join("\n") };
  }
}
`}`;
}
