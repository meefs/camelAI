# AI Apps

Read this reference only when the app uses model calls, conversational state, agent tools, or image generation.

## Choose the Foundation

Use `template: "ai-chat"` when conversation or model interaction is the primary product. Keep `crud` for stateful products that merely add an AI-assisted action, then declare the virtual `AI` binding.

The `ai-chat` scaffold already contains a server-rendered message form and a route action that calls `context.cloudflare.env.AI.run`. Extend that working path rather than rebuilding it.

## Virtual AI Binding

Declare the binding in `wrangler.jsonc`:

```jsonc
{ "ai": { "binding": "AI" } }
```

Use `run()` in deployed app code:

```ts
const result = await context.cloudflare.env.AI.run("auto", {
  messages: [
    { role: "system", content: "Answer using the product context." },
    { role: "user", content: message },
  ],
});
```

Model tiers are `cheap`, `fast`, `auto`, and `smart`; default to `auto`. Do not set `max_tokens` without a real output constraint because reasoning tokens share that budget.

## Persistent Chat Agents

Use Cloudflare Agents only when the product needs durable conversation history, resumable streaming, or server-side agent state. Keep these invariants:

- Pass a unique `name` to every `useAgent` call; otherwise all users share the `default` Durable Object instance.
- Generate session identity in a loader or another server-controlled path, not during component render.
- `useAgentChat` does not provide `input`, `setInput`, or `handleSubmit`; manage form input with React state and call `sendMessage`.

```tsx
const agent = useAgent({ agent: "Chat", name: sessionId });
const [input, setInput] = useState("");
const { messages, sendMessage, status, error } = useAgentChat({ agent });
```

Export the agent class from the Worker entry and keep its binding and SQLite migration aligned in `wrangler.jsonc`.

## Tool-Orchestrating Agents

Use codemode when the model needs multiple data or side-effect tools. Plain tool calling is acceptable for one trivial tool.

- Expose data-access and side-effect tools, not formatting/pass-through tools.
- Give tools output schemas so generated code is typed.
- Define a discriminated result shape such as `{ type: "chart", ... }` for the frontend.
- Set a generous step limit for multi-step execution.
- Defensively default optional parameters with `??`.

The codemode UI part uses `type === "tool-codemode"`, completed state `output-available`, and the returned value at `part.output.result`.

## Image Generation

Use the virtual CAMELAI service instead of calling an image provider directly:

```ts
const image = await context.cloudflare.env.CAMELAI.generateImage(
  "Editorial illustration of ...",
);
```

On camelAI deploys, virtual bindings are rewritten to workspace-scoped platform services. Do not embed provider credentials.
