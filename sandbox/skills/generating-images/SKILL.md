---
name: generating-images
description: Generate images using AI. Use this skill when the user asks to create, generate, or produce images, illustrations, avatars, thumbnails, or any visual content using AI models. Covers both deployed workers (env.AI) and local container scripts (OpenAI proxy).
license: Complete terms in LICENSE.txt
---

# Generating Images with AI

The `auto_image` model route generates images from text prompts. It supports both pure image generation and mixed text+image responses.

## How It Works

The platform routes `auto_image` requests to a multimodal model that can return both text and images in a single response. Images are returned as base64 PNG data URLs in the `choices[0].message.images` array.

## Response Shape

Both the deployed worker path and the container proxy path return the same OpenAI-compatible response structure:

```json
{
  "id": "gen-...",
  "model": "google/gemini-3.1-flash-image-preview",
  "choices": [{
    "message": {
      "role": "assistant",
      "content": "Here is the image you requested.",
      "images": [{
        "type": "image_url",
        "image_url": {
          "url": "data:image/png;base64,iVBORw0KGgo..."
        },
        "index": 0
      }]
    },
    "finish_reason": "stop"
  }],
  "usage": { "prompt_tokens": 10, "completion_tokens": 1400, "total_tokens": 1410 }
}
```

Key fields:
- `choices[0].message.content` — Text response (may be empty for image-only prompts)
- `choices[0].message.images` — Array of generated images
- `choices[0].message.images[0].image_url.url` — Base64 data URL (`data:image/png;base64,...`)

## Important: workers-ai-provider Limitation

The `workers-ai-provider` package (`createWorkersAI`) does **not** surface the `images` array from the response. Calling `generateText({ model: workersai("auto_image", {}) })` will only return the text portion — images are silently dropped.

**Use `env.AI.run()` directly** to access generated images in deployed workers, or the OpenAI SDK in container scripts.

## Deployed Workers (env.AI.run Path)

Call `env.AI.run("auto_image", ...)` directly. This returns the full response including the `images` array. Do not use `generateText()` with `workersai("auto_image")`.

### Basic Image Generation

```typescript
import { data } from "react-router";
import type { Route } from "./+types/api.generate-image";

export async function action({ request, context }: Route.ActionArgs) {
  const { prompt } = await request.json();
  const env = context.cloudflare.env;

  const result = await env.AI.run("auto_image", {
    messages: [{ role: "user", content: prompt }],
  }) as {
    choices: Array<{
      message: {
        content: string;
        images?: Array<{ image_url: { url: string } }>;
      };
    }>;
  };

  const message = result.choices[0].message;
  const imageDataUrl = message.images?.[0]?.image_url?.url;

  return data({
    text: message.content || null,
    imageDataUrl: imageDataUrl || null,
  });
}
```

### Rendering in React

```tsx
function ImageResult({ text, imageDataUrl }: { text: string | null; imageDataUrl: string | null }) {
  return (
    <div>
      {text && <p>{text}</p>}
      {imageDataUrl && <img src={imageDataUrl} alt="Generated image" />}
    </div>
  );
}
```

### Extracting Raw PNG Bytes

To store the image in R2 or serve it as a file:

```typescript
function dataUrlToBytes(dataUrl: string): { bytes: Uint8Array; mimeType: string } {
  const [header, base64Data] = dataUrl.split(",");
  const mimeType = header.match(/data:(.*?);/)?.[1] ?? "image/png";
  const bytes = Uint8Array.from(atob(base64Data), (c) => c.charCodeAt(0));
  return { bytes, mimeType };
}

// Store in R2
const { bytes, mimeType } = dataUrlToBytes(imageDataUrl);
await env.MY_BUCKET.put(`images/${crypto.randomUUID()}.png`, bytes, {
  httpMetadata: { contentType: mimeType },
});
```

## Container Scripts (OpenAI Proxy Path)

For scripts running inside the camelAI container, use the OpenAI SDK with `model: "auto_image"`.

### Basic Image Generation

```typescript
import OpenAI from "openai";
import { writeFile } from "fs/promises";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY ?? "proxy",
  baseURL: process.env.OPENAI_BASE_URL,
});

const resp = await client.chat.completions.create({
  model: "auto_image",
  messages: [{ role: "user", content: "A watercolor painting of a mountain lake at sunset" }],
});

const message = resp.choices[0].message;
console.log("Text:", message.content);

// Access images from the raw response
const images = (message as any).images as Array<{ image_url: { url: string } }> | undefined;

if (images?.[0]) {
  const dataUrl = images[0].image_url.url;
  const base64Data = dataUrl.split(",")[1];
  const buffer = Buffer.from(base64Data, "base64");
  await writeFile("output.png", buffer);
  console.log("Saved output.png");
}
```

### Saving Multiple Images

```typescript
import OpenAI from "openai";
import { writeFile, mkdir } from "fs/promises";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY ?? "proxy",
  baseURL: process.env.OPENAI_BASE_URL,
});

async function generateImage(prompt: string, outputPath: string) {
  const resp = await client.chat.completions.create({
    model: "auto_image",
    messages: [{ role: "user", content: prompt }],
  });

  const images = (resp.choices[0].message as any).images as
    Array<{ image_url: { url: string } }> | undefined;

  if (!images?.[0]) {
    console.error("No image returned for:", prompt);
    return null;
  }

  const base64Data = images[0].image_url.url.split(",")[1];
  await writeFile(outputPath, Buffer.from(base64Data, "base64"));
  console.log(`Saved: ${outputPath}`);
  return outputPath;
}

// Generate a batch of images
await mkdir("./generated", { recursive: true });

await generateImage("A red fox in a snowy forest", "./generated/fox.png");
await generateImage("A vintage map of a fantasy world", "./generated/map.png");
await generateImage("A minimalist logo for a coffee shop called 'Brew'", "./generated/logo.png");
```

### Python (Container)

```python
import openai
import base64
import os

client = openai.OpenAI(
    api_key=os.environ.get("OPENAI_API_KEY", "proxy"),
    base_url=os.environ.get("OPENAI_BASE_URL"),
)

resp = client.chat.completions.create(
    model="auto_image",
    messages=[{"role": "user", "content": "A cute cartoon cat wearing a top hat"}],
)

message = resp.choices[0].message
print("Text:", message.content)

# Access images from raw response
images = getattr(message, "images", None) or resp.model_extra.get("choices", [{}])[0].get("message", {}).get("images")
if images:
    data_url = images[0]["image_url"]["url"]
    base64_data = data_url.split(",")[1]
    with open("cat.png", "wb") as f:
        f.write(base64.b64decode(base64_data))
    print("Saved cat.png")
```

## Chat Agent with Image Generation

For a chat DO that supports both text and image responses, use `env.AI.run()` for image requests and fall back to `streamText()` for normal text:

```typescript
import { AIChatAgent } from "@cloudflare/ai-chat";
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
} from "ai";

export class Chat extends AIChatAgent<Env> {
  async onChatMessage(onFinish, options) {
    const lastMessage = this.messages[this.messages.length - 1];
    const isImageRequest = this.detectImageRequest(lastMessage);

    if (isImageRequest) {
      return this.handleImageGeneration(lastMessage, onFinish);
    }

    // Fall back to normal text streaming for non-image requests
    // ... (use streamText with workersai("auto", {}) as usual)
  }

  private detectImageRequest(message: any): boolean {
    const text = typeof message.content === "string"
      ? message.content
      : message.content?.map((p: any) => p.text).join(" ") ?? "";
    return /\b(generate|create|draw|make|design)\b.*\b(image|picture|illustration|avatar|logo|icon)\b/i.test(text);
  }

  private async handleImageGeneration(message: any, onFinish: any) {
    const prompt = typeof message.content === "string"
      ? message.content
      : message.content?.map((p: any) => p.text).join(" ") ?? "";

    const result = await this.env.AI.run("auto_image", {
      messages: [{ role: "user", content: prompt }],
    }) as any;

    const msg = result.choices[0].message;
    const imageDataUrl = msg.images?.[0]?.image_url?.url;

    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        if (msg.content) {
          writer.write({ type: "text", text: msg.content });
        }
        if (imageDataUrl) {
          // Send as markdown image the client can render
          writer.write({ type: "text", text: `\n\n![Generated image](${imageDataUrl})` });
        }
      },
    });

    return createUIMessageStreamResponse({ stream });
  }
}
```

## Best Practices

1. **Use `env.AI.run("auto_image", ...)` directly** for image generation in deployed workers — do not use `generateText()` with `workersai("auto_image")` as it drops images.
2. **Use `auto_image` only when images are needed** — it routes to a specialized model that is slower and more expensive than `auto`.
3. **Extract base64 data for storage** — Convert data URLs to raw bytes before storing in R2 or writing to disk.
4. **Handle missing images gracefully** — The model may return text-only responses even with image prompts. Always check `images` before accessing.
5. **Keep prompts descriptive** — Image quality improves with specific prompts (style, subject, composition, colors).
6. **Consider response size** — Generated images are ~1-2MB as base64. Avoid returning them directly in SSR loaders; use API routes instead.
