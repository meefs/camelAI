---
name: generating-images
description: Generate images using AI. Use this skill when the user asks to create, generate, or produce images, illustrations, avatars, thumbnails, or any visual content using AI models. Covers deployed workers through env.AI.
license: Complete terms in LICENSE.txt
---

# Generating Images with AI

The `auto_image` model route generates images from text prompts. It supports both pure image generation and mixed text+image responses.

## How It Works

The platform routes `auto_image` requests to a multimodal model that can return both text and images in a single response. Images are returned as base64 PNG data URLs in the `choices[0].message.images` array.

## Transparency Limitation

The current image model does **not** support alpha channels or true transparent backgrounds. Even when the user asks for a transparent PNG, the generated image will have an opaque background.

When you need an asset that will later be used with transparency, such as a website graphic, icon, sticker, or cutout illustration:

- Prompt the model to place the subject on a **solid, high-contrast background** that does not appear in the subject itself.
- Prefer explicit colors like bright green (`#00FF00`-style chroma key), pure magenta, or another flat backdrop that clearly separates foreground and background.
- Ask for **clean edges, no shadows blending into the background, and no background texture or gradients** so post-processing is easier.

Example prompt pattern:

```text
Create a flat vector-style robot mascot centered on a solid bright green background.
Use crisp edges, no ground shadow, no background texture, and keep the robot colors away from green.
The background should be a single uniform color so it can be removed in post-processing.
```

Treat background removal as a separate post-processing step after generation.

## Style Consistency

When you generate multiple images for the same project, keep the style prompt consistent across all of them.

- Reuse the same core art-direction language each time: medium, rendering style, color palette, lighting, camera angle, line treatment, level of detail, and background treatment.
- Keep a short "style anchor" phrase and repeat it verbatim across prompts.
- Change only the subject or composition details that need to vary between images.
- If you already have one successful image, describe its style explicitly in the next prompt instead of starting from scratch.
- You can also pass a reference image as an `image_url` input alongside your text prompt and ask for a new image in the same style.

Example style anchor:

```text
Clean flat vector illustration, limited pastel palette, soft geometric shapes, minimal shading, subtle grain, centered composition.
```

Minimal multimodal prompt shape:

```json
{
  "role": "user",
  "content": [
    {
      "type": "image_url",
      "image_url": { "url": "data:image/png;base64,..." }
    },
    {
      "type": "text",
      "text": "Generate a new image in the same visual style as this reference, but with a different subject."
    }
  ]
}
```

## Response Shape

The deployed worker path returns an OpenAI-compatible response structure:

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

**Use `env.AI.run()` directly** to access generated images in deployed workers.

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
5. **Do not promise transparency from the model** — If the user needs transparency, generate on a flat high-contrast background and remove it afterward.
6. **Keep prompts descriptive** — Image quality improves with specific prompts (style, subject, composition, colors).
7. **Consider response size** — Generated images are ~1-2MB as base64. Avoid returning them directly in SSR loaders; use API routes instead.

## Simple Background Removal

If you generated an image on a solid chroma-key background, remove that background in a post-processing step.

### ImageMagick

Use ImageMagick for the post-processing step:

```bash
magick input.png -fuzz 12% -transparent "%[pixel:p{0,0}]" output.png
```

This samples the top-left pixel and makes similar colors transparent, which is more reliable than assuming the model used an exact hex value.

Use `-fuzz` to tolerate small variations in the generated background color. This works best when you prompted for a uniform solid background and kept that color out of the subject itself.
