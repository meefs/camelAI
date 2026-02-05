# Building AI Apps and Agents

The template includes pre-configured AI chat capabilities using the Vercel AI SDK with OpenRouter. The AI features are commented out by default—enable them by uncommenting the relevant code.

## CRITICAL: Use MarkdownRenderer for AI Output

**You MUST use the `MarkdownRenderer` component when displaying AI responses.** AI models return markdown-formatted text (code blocks, lists, tables, etc.) that will not render correctly with plain text.

```tsx
import { MarkdownRenderer } from "~/components/markdown-renderer";

// CORRECT - Use MarkdownRenderer for AI responses:
{message.role === "assistant" && (
  <MarkdownRenderer
    content={messageText}
    isStreaming={isStreaming && isLastMessage}
  />
)}

// WRONG - Never use plain text for AI output:
// <p>{messageText}</p>  // Code blocks won't render!
```

The component is pre-installed at `app/components/markdown-renderer.tsx`.

## Key Features

- **Markdown Rendering**: AI responses rendered with code blocks, copy buttons, tables, lists, and more
- **Conversation Continuity**: Full conversation history is automatically passed to the AI on every message
- **Real-time Streaming**: Responses stream in real-time with proper markdown handling during streaming
- **Persistent Storage**: Messages are stored in SQLite via Durable Objects and survive page refreshes

## Enabling AI Chat

1. **wrangler.jsonc** - Add Chat DO binding and migration:
   ```jsonc
   "durable_objects": {
     "bindings": [
       { "name": "Chat", "class_name": "Chat" }
     ]
   },
   "migrations": [
     { "tag": "v1", "new_sqlite_classes": ["Chat"] }
   ]
   ```

2. **workers/app.ts** - Export the Chat class and enable agent routing:
   ```typescript
   import { routeAgentRequest } from "agents";
   export { Chat } from "./chat";

   export default {
     async fetch(request, env, ctx) {
       const agentResponse = await routeAgentRequest(request, env);
       if (agentResponse) return agentResponse;
       // ... rest of handler
     },
   };
   ```

3. **app/routes.ts** - Add the chat route:
   ```typescript
   route("chat", "routes/chat.tsx"),
   ```

4. **API key** - No setup needed! `OPENROUTER_API_KEY` is automatically available in deployed workers via `env.OPENROUTER_API_KEY` and in your bash environment via `$OPENROUTER_API_KEY` for ad hoc scripts.

## nodejs_compat Flag

The AI SDK dependencies require the `nodejs_compat` compatibility flag, which is already configured in the template's `wrangler.jsonc`.

The template's `vite.config.ts` configures the SSR environment to use Cloudflare's worker entry as the rollup input, ensuring Durable Object exports are correctly included in the bundle.

## Markdown Rendering

The chat UI uses the `MarkdownRenderer` component (`app/components/markdown-renderer.tsx`) to render AI responses. It supports:

- **Headings** (h1-h4)
- **Bold**, *italic*, and ~~strikethrough~~ text
- `Inline code` and fenced code blocks with copy buttons
- Bulleted and numbered lists
- Blockquotes
- Tables with GitHub Flavored Markdown syntax
- Links and images
- Horizontal rules

The renderer handles streaming gracefully—unclosed code fences are automatically closed during streaming to prevent layout issues.

## Conversation Continuity

The SDK automatically maintains conversation history:

1. **Automatic persistence**: All messages are stored in SQLite via the Durable Object
2. **Full context on every request**: `convertToModelMessages(this.messages)` passes the complete history
3. **Survives reconnections**: Page refreshes and reconnects restore the full conversation
4. **Clear history**: Use `clearHistory()` from `useAgentChat` to start fresh

```typescript
// In chat.ts - this.messages contains FULL conversation history
const result = streamText({
  model: openrouter("openrouter/auto"),
  messages: await convertToModelMessages(this.messages),  // All messages
  system: "You are a helpful assistant.",
});
```

## Customizing the Chat Agent

Edit `workers/chat.ts` to customize the AI behavior:

```typescript
export class Chat extends AIChatAgent<Env> {
  async onChatMessage(onFinish, options) {
    const openrouter = getOpenRouter(this.env.OPENROUTER_API_KEY);

    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        const result = streamText({
          model: openrouter("openrouter/auto", {
            plugins: [{ id: "web" }],  // Enable web search
          }),
          // Full conversation history is passed automatically
          messages: await convertToModelMessages(this.messages),
          system: "You are a helpful AI assistant.",
          tools: {
            // Add tools here
          },
          maxSteps: 10,  // For multi-step tool use
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

## Adding Tools

Define tools with Zod schemas:

```typescript
import { tool } from "ai";
import { z } from "zod";

const result = streamText({
  model: openrouter("openrouter/auto"),
  messages: this.messages,
  tools: {
    getWeather: tool({
      description: "Get the current weather for a location",
      parameters: z.object({
        location: z.string().describe("The city to get weather for"),
      }),
      execute: async ({ location }) => {
        // Call your weather API
        return { location, temperature: 72, condition: "sunny" };
      },
    }),
    calculate: tool({
      description: "Evaluate a math expression",
      parameters: z.object({
        expression: z.string(),
      }),
      execute: async ({ expression }) => {
        try {
          return { result: Function(`return ${expression}`)() };
        } catch {
          return { error: "Invalid expression" };
        }
      },
    }),
  },
  maxSteps: 10,
});
```

## Web Search Plugin

Enable web search for up-to-date information:

```typescript
const result = streamText({
  model: openrouter("openrouter/auto", {
    plugins: [{ id: "web" }],
  }),
  system: "Search the web to find accurate information. Cite your sources.",
  prompt: question,
});
```

Use web search for:
- Current events or recent information
- Research tasks requiring citations
- Fact-checking

## Structured Output

Use `generateObject` for typed responses:

```typescript
import { generateObject } from "ai";
import { z } from "zod";

const { object } = await generateObject({
  model: openrouter("openrouter/auto"),
  schema: z.object({
    sentiment: z.enum(["positive", "negative", "neutral"]),
    topics: z.array(z.string()),
    summary: z.string(),
  }),
  prompt: `Analyze this text: ${text}`,
});
```

## Stateless API Endpoints

For simple one-shot completions without persistence, use a React Router API route with an `action()`:

```typescript
// app/routes/api.complete.ts
import type { Route } from "./+types/api.complete";
import { data } from "react-router";
import { generateText, streamText } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";

export async function action({ request, context }: Route.ActionArgs) {
  const { prompt, stream } = await request.json();
  const openrouter = createOpenRouter({
    apiKey: context.cloudflare.env.OPENROUTER_API_KEY,
  });

  if (stream) {
    const result = streamText({
      model: openrouter("openrouter/auto"),
      prompt,
    });

    return result.toTextStreamResponse();
  }

  const { text } = await generateText({
    model: openrouter("openrouter/auto"),
    prompt,
  });

  return data({ response: text });
}

// app/routes.ts
// route("api/complete", "routes/api.complete.ts")
```

## When to Use Each Approach

| Approach | Use When |
|----------|----------|
| **Agents SDK** (Chat DO) | Chat apps, persistent conversations, real-time streaming |
| **React Router API routes** | Stateless APIs, one-shot completions, webhooks |

## Common Pitfalls

Watch out for these frequent issues when building AI chat apps:

### 1. `useAgent` uses `name`, not `id`

The `useAgent` hook identifies chat instances by `name`, not `id`:

```tsx
// CORRECT - use 'name' for the unique identifier
const agent = useAgent({ agent: "Chat", name: sessionId });

// WRONG - 'id' is not a valid parameter
const agent = useAgent({ agent: "Chat", id: sessionId });  // Won't work!
```

### 2. Session IDs should be generated server-side

Generate session IDs in loaders to avoid React re-render issues:

```tsx
// CORRECT - generate in loader
export async function loader() {
  return { sessionId: crypto.randomUUID() };
}

export default function ChatPage() {
  const { sessionId } = useLoaderData<typeof loader>();
  const agent = useAgent({ agent: "Chat", name: sessionId });
}

// WRONG - generates new ID on every render
export default function ChatPage() {
  const sessionId = crypto.randomUUID();  // Re-renders create new sessions!
  const agent = useAgent({ agent: "Chat", name: sessionId });
}
```

### 3. AI code is commented out by default

The template has Chat DO code pre-configured but commented out. To enable AI chat:
1. Uncomment the `Chat` binding and migration in `wrangler.jsonc`
2. Uncomment the `Chat` export and agent routing in `workers/app.ts`
3. Add the chat route to `app/routes.ts`

Look for comments like `// Uncomment for AI chat` in the template files.

### 4. Missing MarkdownRenderer for AI output

AI responses are markdown-formatted. Always use `MarkdownRenderer`:

```tsx
// CORRECT
<MarkdownRenderer content={message.content} isStreaming={isStreaming} />

// WRONG - code blocks, lists, etc. won't render
<p>{message.content}</p>
```

## Best Practices

1. **Use `openrouter/auto`** - Let OpenRouter select the best model automatically
2. **Use web plugin for search** - Add `plugins: [{ id: "web" }]` for real-time info
3. **Add timeouts** - Use `abortSignal: AbortSignal.timeout(ms)`
4. **Stream for UX** - Use `streamText` with `toTextStreamResponse()` for real-time output
5. **Validate with Zod** - Use `generateObject` with schemas for structured data
6. **Limit agent steps** - Set reasonable `maxSteps` (10-20) to prevent runaway agents
