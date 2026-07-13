import type { Context } from "@earendil-works/pi-ai";

export interface PiBedrockCall {
  context: Context;
  toolChoice?: "auto" | "any" | "none" | { type: "tool"; name: string };
  maxTokens?: number;
  temperature?: number;
  stream: boolean;
}
