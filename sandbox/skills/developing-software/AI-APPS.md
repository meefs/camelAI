# Building AI Apps and Agents

The starter template includes pre-configured AI chat scaffolding with the Vercel AI SDK and Cloudflare Workers AI. See `workers/chat.ts` for the Chat DO and `app/routes/chat.tsx` for the frontend — just uncomment to enable.

## Runtime Model

There are two supported AI paths in camelAI:

1. **Deployed workers**: use native `env.AI` (virtualized by the platform).
2. **Container/runtime scripts**: use the OpenAI-compatible local proxy (`OPENAI_BASE_URL` + `OPENAI_API_KEY=proxy`).

Use `env.AI` in worker code whenever possible.

## Enable AI Chat in the Starter

1. In `wrangler.jsonc`, uncomment/add:
   - Chat Durable Object binding
   - Chat migration
   - `"ai": { "binding": "AI" }`
2. In `workers/app.ts`, uncomment `routeAgentRequest` and `export { Chat }`.
3. In `app/routes.ts`, add `route("chat", "routes/chat.tsx")`.

## Workers AI Provider (Recommended)

Use `workers-ai-provider` with the AI SDK:

```typescript
import { createWorkersAI } from "workers-ai-provider";
import { streamText, convertToModelMessages } from "ai";

const workersai = createWorkersAI({ binding: this.env.AI });

const result = streamText({
  model: workersai("auto", {}),
  messages: await convertToModelMessages(this.messages),
  system: "You are a helpful AI assistant.",
});
```

Notes:
- `"auto"` is the default model hint to use.
- The platform may override/route model hints.
- Do not set `max_tokens` by default. Thinking/reasoning tokens consume that same budget and can truncate completions prematurely.
- If you must use `max_tokens`, leave substantial headroom for both thinking and final output.

## OpenAI-Compatible Local Proxy (Container Path)

For scripts/services running inside the camelAI container, use `OPENAI_BASE_URL` + `OPENAI_API_KEY=proxy`:

```typescript
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY ?? "proxy",
  baseURL: process.env.OPENAI_BASE_URL,
});

const resp = await client.chat.completions.create({
  model: "auto",
  messages: [{ role: "user", content: "Hello" }],
});
```

## Tools and Agents

> **IMPORTANT: Always use codemode for tool-calling agents.** Codemode is the **strongly recommended default** for any agent that uses tools. It lets the LLM orchestrate multiple tools in a single turn by writing TypeScript code — calling tools sequentially, in parallel, with conditionals, loops, and error handling — all within one step. This is dramatically faster, more reliable, and more capable than plain tool calling, which forces one-tool-at-a-time round-trips with the model.
>
> **Only fall back to plain tool calling** if the agent has a single, trivially simple tool with no chaining needs. In every other case, **use codemode.**

### Why Codemode Over Plain Tool Calling

| | Codemode | Plain Tool Calling |
|---|---|---|
| **Tools per turn** | Unlimited — chain, branch, loop | One at a time, sequential round-trips |
| **Latency** | One LLM call orchestrates many tools | N tools = N+ LLM round-trips |
| **Logic** | Full TypeScript: conditionals, loops, try/catch | Model must "reason" across turns |
| **Reliability** | Code executes deterministically | Model may lose track of multi-step plans |
| **Type safety** | `outputSchema` → real TS types in generated code | Tool outputs are untyped `unknown` |

### Codemode Setup

The starter template has codemode pre-configured (commented out in `workers/chat.ts`). Uncomment and customize:

1. Define tools with `outputSchema` for typed code generation
2. Create executor: `new DynamicWorkerExecutor({ loader: this.env.LOADER })`
3. Create code tool: `createCodeTool({ tools: myTools, executor })`
4. Pass to streamText: `tools: { codemode: codeTool }`
5. Always set `stopWhen: stepCountIs(100)` for multi-step tool use

### Codemode Tool Design — Only Provide Data Tools

Do **NOT** create "pass-through" or "formatting" tools (e.g., a `createVisualization` tool that just echoes inputs into a chart config). Only wrap tools that **access data** or **perform side effects**. The LLM handles all data transformation and output shaping in its generated code.

### Codemode Return Type Convention

Define a discriminated return type convention in your `createCodeTool` description so the frontend knows how to render each result. Use a `type` field as the discriminator. Include the `{{types}}` placeholder so the LLM sees the tool type definitions, and provide concrete examples:

```typescript
const codemode = createCodeTool({
  tools: dataTools,
  executor,
  description: `Execute code to query and analyze data. You have access to these tools via the \`codemode\` object:

{{types}}

IMPORTANT: Your code MUST return a result object with a "type" field indicating what to render:

1. For CHARTS — return:
   { type: "chart", chartType: "bar"|"line"|"area"|"pie", title: string, data: Array<Record<string, any>>, xKey: string, yKeys: string[], xLabel?: string, yLabel?: string }

2. For TABLES — return:
   { type: "table", companies: Array<...>, total: number, showing: number }

3. For RAW STATS (no visual) — return:
   { type: "stats", stats: Array<{ label: string, value: number }>, groupBy: string, metric: string }

Examples:

// Bar chart
async () => {
  const result = await codemode.aggregateStats({ groupBy: "category", metric: "count", limit: 10 });
  return {
    type: "chart",
    chartType: "bar",
    title: "Top 10 Categories",
    data: result.stats.map(s => ({ label: s.label, value: s.value })),
    xKey: "label",
    yKeys: ["value"],
    xLabel: "Category",
    yLabel: "Count"
  };
}`,
});
```

### Codemode Frontend Rendering — AI SDK UIMessage Part Format

> **This is the #1 source of bugs when integrating codemode.** The AI SDK v5+ uses a different UIMessage part format than what older docs describe.

The starter template's `chat.tsx` has a working implementation. Key differences from older docs:

| Property | Old SDK (pre-v5) | Current SDK (v5+) |
|----------|-------------------|---------------------|
| Part type | `p.type === "tool-invocation"` | `p.type === "tool-{toolName}"` (e.g., `"tool-codemode"`) |
| Completion state | `p.state === "result"` | `p.state === "output-available"` |
| Result data | `p.result` | `p.output` |
| Tool name | `p.toolName` | `undefined` — extract from `p.type.replace("tool-", "")` |
| Error state | N/A | `p.state === "output-error"` |

**Codemode output shape** (what `p.output` contains):
```typescript
{ code: "async () => { ... }", result: { type: "chart", ... }, logs: [] }
```

The frontend reads `p.output.result.type` to decide what to render.

**Key gotchas:**
1. `p.type` is `"tool-codemode"`, NOT `"tool-invocation"` — always use `p.type.startsWith("tool-")`
2. The tool name comes from `p.type`, not `p.toolName` (which is `undefined` in the new SDK)
3. Codemode wraps the LLM's return value — the actual data is in `result.result`, not `result`
4. Use `p.output ?? p.result` to handle both old and new SDK versions
5. Check for `"output-available"` state, not just `"result"`
6. **Blank bubble gap** — The assistant message stream starts before any parts arrive. If your loading indicator only checks `lastMessage.role !== "assistant"`, it will hide too early. Use `hasVisibleContent()` (see `chat.tsx`) before hiding the loading state.

### Zod Parameter Defensive Defaults

Tool parameters validated with Zod may arrive as `undefined` at runtime (Zod v3/v4 compatibility gap with the `ai` package). Always add defensive defaults using `??` (not `||`, which replaces valid falsy values like `0`, `false`, `""`):

```typescript
execute: async (params) => {
  const metric = params.metric ?? "count";
  const groupBy = params.groupBy ?? "industry";
  return computeStats({ metric, groupBy });
},
```

## Stateless Route Example

```typescript
import { data } from "react-router";
import { generateText } from "ai";
import { createWorkersAI } from "workers-ai-provider";

export async function action({ request, context }) {
  const { prompt } = await request.json();
  const workersai = createWorkersAI({ binding: context.cloudflare.env.AI });

  const { text } = await generateText({
    model: workersai("auto", {}),
    prompt,
  });

  return data({ response: text });
}
```

## Codemode Reference

`@cloudflare/codemode` is pre-configured in the starter template (`worker_loaders` + `SELF` bindings in `wrangler.jsonc`). See `workers/chat.ts` for setup.

### How It Works

1. You define tools with `outputSchema` so the generated code gets proper types
2. `createCodeTool` wraps your tools into a single "code" tool the LLM can call
3. `DynamicWorkerExecutor` runs the LLM-generated code in an ephemeral Worker isolate
4. The LLM writes code like `const weather = await getWeather({ city: "Paris" }); return await formatReport(weather);`

### Key Points

- **`outputSchema`** on tools produces real TypeScript types instead of `unknown` in generated code
- **`env.LOADER`** (`worker_loaders` binding) provides the isolate runtime
- The `__filename` define in `vite.config.ts` polyfills a Node.js global needed by the TypeScript compiler

## Model Routes

Three model routes are available. Use them with `workersai(routeName, {})` in deployed workers, or `model: "routeName"` in the container OpenAI-compatible proxy:

| Route | Purpose | When to Use |
|-------|---------|-------------|
| `auto` | Text generation + tool calling | Default for all general-purpose AI features |
| `auto_search` | Google Search grounding with inline citations | App needs real-time info: news, live prices, recent events, fact-checking |
| `auto_image` | Image generation from text prompts | App needs to create images: avatars, illustrations, thumbnails, creative content |

**Always default to `auto`** unless the user's use case clearly requires search grounding or image generation. A single app can use multiple routes for different features (e.g., `auto` for chat, `auto_search` for a "research" mode, `auto_image` for an image creator).

Model selection is supported in both deployed workers (via `env.AI`) and the container OpenAI-compatible proxy. Unknown model names fall back to `auto`.

### Search Grounding Example

```typescript
const result = await generateText({
  model: workersai("auto_search", {}),
  prompt: "What are the latest Cloudflare Workers features?",
});
// Response includes inline citations from Google Search
```

### Image Generation Example

> **Important:** The `workers-ai-provider` does not surface the `images` array from the response. `generateText()` with `workersai("auto_image")` will only return the text portion. Use `env.AI.run()` directly instead.

**See [../generating-images/SKILL.md](../generating-images/SKILL.md) for complete image generation patterns, response handling, and file-saving examples.**

Quick example using `env.AI.run()` in a deployed worker:

```typescript
const result = await env.AI.run("auto_image", {
  messages: [{ role: "user", content: "Generate a watercolor mountain landscape" }],
});
const imageDataUrl = result.choices[0].message.images?.[0]?.image_url?.url;
// imageDataUrl is "data:image/png;base64,..."
```

## Best Practices

1. **Always use codemode for tool-calling agents** — lets the LLM chain, branch, and parallelize tool calls in one turn. Only skip for a single trivially simple tool.
2. **Add `outputSchema` to every tool** — generates real TypeScript types in codemode.
3. **Only wrap data/side-effect tools in codemode** — the LLM constructs output shapes directly in code.
4. **Use a `type` discriminator in codemode return values** — define the convention in your `createCodeTool` description.
5. **Handle the current AI SDK part format** — use `p.type.startsWith("tool-")`, `p.output ?? p.result`, and `state === "output-available"`.
6. **Use `??` for defensive defaults** — Zod params may be `undefined` at runtime. `||` silently replaces valid `0`/`false`/`""`.
7. Use `workersai("auto", {})` as the default model.
8. Avoid `max_tokens` unless a hard cap is required; reasoning tokens count toward it.
9. Stream responses for chat UX.
10. Use `MarkdownRenderer` for assistant output.
