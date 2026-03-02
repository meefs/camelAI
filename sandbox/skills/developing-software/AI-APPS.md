# Building AI Apps and Agents

The starter template includes pre-configured AI chat scaffolding with the Vercel AI SDK and Cloudflare Workers AI.

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

## Chat DO Example

```typescript
import { AIChatAgent } from "@cloudflare/ai-chat";
import { createWorkersAI } from "workers-ai-provider";
import {
  streamText,
  createUIMessageStream,
  createUIMessageStreamResponse,
  convertToModelMessages,
} from "ai";

export class Chat extends AIChatAgent<Env> {
  async onChatMessage(onFinish, options) {
    const workersai = createWorkersAI({ binding: this.env.AI });

    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        const result = streamText({
          model: workersai("auto", {}),
          messages: await convertToModelMessages(this.messages),
          system: "You are a helpful AI assistant.",
          onFinish,
          abortSignal: options?.abortSignal,
        });

        writer.merge(result.toUIMessageStream());
      },
    });

    return createUIMessageStreamResponse({ stream });
  }
}
```

## OpenAI-Compatible Local Proxy (Container Path)

For scripts/services running inside the camelAI container, use:

- `OPENAI_BASE_URL`
- `OPENAI_API_KEY=proxy`

Example:

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

### Codemode (Default for Agents with Tools)

```typescript
import { tool, streamText, stepCountIs } from "ai";
import { z } from "zod";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { createCodeTool } from "@cloudflare/codemode/ai";

const myTools = {
  getWeather: tool({
    description: "Get weather for a city",
    parameters: z.object({ city: z.string() }),
    outputSchema: z.object({ city: z.string(), temperature: z.number() }),
    execute: async ({ city }) => ({ city, temperature: 72 }),
  }),
  formatReport: tool({
    description: "Format a weather report",
    parameters: z.object({ city: z.string(), temperature: z.number() }),
    outputSchema: z.string(),
    execute: async ({ city, temperature }) => `It's ${temperature}°F in ${city}.`,
  }),
};

const executor = new DynamicWorkerExecutor({ loader: env.LOADER });
const codeTool = createCodeTool({ tools: myTools, executor });

const result = streamText({
  model: workersai("auto", {}),
  messages: await convertToModelMessages(this.messages),
  tools: { codemode: codeTool },
  stopWhen: stepCountIs(100),
});
```

With codemode, the LLM can chain tools in one step: `const weather = await getWeather({ city: "Paris" }); return await formatReport(weather);` — instead of making separate round-trips for each tool call. It can also run tools in parallel (`Promise.all`), add conditional logic, handle errors with try/catch, and iterate over collections — all things that are impossible or extremely brittle with plain tool calling.

### Plain Tool Calling (Escape Hatch Only)

> **Avoid unless the agent has a single trivially simple tool.** If there are 2+ tools, or any chance of chaining, use codemode instead.

```typescript
const result = streamText({
  model: workersai("auto", {}),
  messages: await convertToModelMessages(this.messages),
  tools: {
    getWeather: tool({
      description: "Get weather for a city",
      parameters: z.object({ city: z.string() }),
      execute: async ({ city }) => ({ city, temperature: 72 }),
    }),
  },
  stopWhen: stepCountIs(100),

});
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

`@cloudflare/codemode` is pre-configured in the starter template (`worker_loaders` + `SELF` bindings in `wrangler.jsonc`). See the [Tools and Agents](#tools-and-agents) section above for usage examples.

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

1. **Always use codemode for tool-calling agents** — this is the single most impactful pattern. Codemode lets the LLM chain, branch, and parallelize tool calls in one turn instead of slow sequential round-trips. Only skip codemode for agents with a single trivially simple tool.
2. **Add `outputSchema` to every tool** — generates real TypeScript types in codemode, making LLM-generated code more reliable.
3. Use `workersai("auto", {})` as the default model selection.
4. Keep system prompts explicit and task-scoped.
5. Avoid `max_tokens` unless a hard cap is required; reasoning tokens count toward it.
6. Stream responses for chat UX.
7. Use Zod for tool parameter validation.
8. Use `MarkdownRenderer` for assistant output.

