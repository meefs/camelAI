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

## Tools Example

```typescript
import { tool, streamText, stepCountIs } from "ai";
import { z } from "zod";

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
  stopWhen: stepCountIs(10),
});
```

> **Note:** AI SDK v6 replaced `maxSteps` with `stopWhen: stepCountIs(N)`. Import `stepCountIs` from `"ai"`.

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

## Codemode (Tool Orchestration)

`@cloudflare/codemode` lets the LLM write TypeScript code that orchestrates multiple tools in a single turn, instead of calling them one-by-one. This is pre-configured in the starter template.

### How It Works

1. You define tools with `outputSchema` so the generated code gets proper types
2. `createCodeTool` wraps your tools into a single "code" tool the LLM can call
3. `DynamicWorkerExecutor` runs the LLM-generated code in an ephemeral Worker isolate
4. The LLM writes code like `const sum = await add({ a: 5, b: 3 }); await multiply({ a: sum, b: 10 });`

### Setup

The starter template already includes `worker_loaders` and `SELF` bindings in `wrangler.jsonc`. To use codemode:

```typescript
import { tool, generateText, stepCountIs } from "ai";
import { z } from "zod";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { createCodeTool } from "@cloudflare/codemode/ai";

// Define tools with outputSchema for typed code generation
const myTools = {
  add: tool({
    description: "Add two numbers",
    parameters: z.object({ a: z.number(), b: z.number() }),
    outputSchema: z.number(),
    execute: async ({ a, b }) => a + b,
  }),
  formatCurrency: tool({
    description: "Format a number as currency",
    parameters: z.object({ amount: z.number(), currency: z.string() }),
    outputSchema: z.string(),
    execute: async ({ amount, currency }) =>
      new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount),
  }),
};

// Create executor and code tool
const executor = new DynamicWorkerExecutor({
  loader: env.LOADER,
});
const codeTool = createCodeTool({ tools: myTools, executor });

const { text } = await generateText({
  model: workersai("auto", {}),
  tools: { codemode: codeTool },
  stopWhen: stepCountIs(10),
  prompt: "Add 100 and 50, then format the result as EUR currency",
});
```

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

1. Use `workersai("auto", {})` as the default model selection.
2. Keep system prompts explicit and task-scoped.
3. Avoid `max_tokens` unless a hard cap is required; reasoning tokens count toward it.
4. Stream responses for chat UX.
5. Use Zod for tool parameter validation.
6. Use `MarkdownRenderer` for assistant output.
7. Use `outputSchema` on tools when using codemode for proper type generation.
8. Use `stopWhen: stepCountIs(N)` instead of the deprecated `maxSteps`.
