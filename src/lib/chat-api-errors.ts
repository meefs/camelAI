import type { LlmModel, LlmProvider } from "@/types";
import { getByokProviderMeta } from "./byok-providers";
import { isLlmModelCoveredByByokProvider } from "./llm-provider-config";

export const CREDIT_SEND_BLOCKED_MESSAGE =
  "Message not sent — top up credits or add an API key to continue.";

export interface ChatApiErrorDetails {
  rawMessage: string;
  status: number | null;
  providerErrorType: string | null;
  providerMessage: string | null;
  isRateLimit: boolean;
}

export interface ChatApiErrorContext {
  billingSource?: "byok" | "hosted" | null;
  llmProvider?: LlmProvider | null;
  threadModel?: LlmModel | null;
}

export type ChatApiErrorPresentation =
  | {
      kind: "byok_rate_limit";
      title: string;
      message: string;
      providerLabel: string | null;
      providerUrl: string | null;
      providerLinkLabel: string | null;
    }
  | {
      kind: "hosted_rate_limit";
      title: string;
      message: string;
    }
  | {
      kind: "generic";
      title?: string;
      message: string;
    };

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function valueToRawMessage(error: unknown): string {
  if (error instanceof Error) {
    return valueToRawMessage(error.message);
  }
  if (typeof error === "string") {
    return error.trim();
  }
  if (error && typeof error === "object") {
    return safeJsonStringify(error).trim();
  }
  if (error == null) {
    return "";
  }
  return String(error).trim();
}

function parseEmbeddedJson(rawMessage: string): unknown | null {
  if (!rawMessage) return null;

  try {
    return JSON.parse(rawMessage) as unknown;
  } catch {
    // Provider SDKs often prefix JSON with status text.
  }

  const jsonStart = rawMessage.indexOf("{");
  const jsonEnd = rawMessage.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd <= jsonStart) {
    return null;
  }

  try {
    return JSON.parse(rawMessage.slice(jsonStart, jsonEnd + 1)) as unknown;
  } catch {
    return null;
  }
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numericStatus(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && /^\d{3}$/.test(value.trim())) {
    return Number(value.trim());
  }
  return null;
}

function extractStatus(rawMessage: string, parsed: unknown): number | null {
  const root = objectRecord(parsed);
  const nestedError = objectRecord(root?.error);
  const candidates = [
    root?.status,
    root?.statusCode,
    root?.httpStatus,
    root?.code,
    nestedError?.status,
    nestedError?.statusCode,
    nestedError?.httpStatus,
    nestedError?.code,
  ];
  for (const candidate of candidates) {
    const status = numericStatus(candidate);
    if (status) return status;
  }

  return /\b429\b/.test(rawMessage) ? 429 : null;
}

function extractProviderErrorType(parsed: unknown): string | null {
  const root = objectRecord(parsed);
  const nestedError = objectRecord(root?.error);
  const candidates = [
    nestedError?.type,
    nestedError?.error_type,
    nestedError?.code,
    root?.type,
    root?.error_type,
    root?.code,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}

function removeErrorPrefix(message: string): string {
  return message.trim().replace(/^Error:\s*/i, "");
}

function extractProviderMessage(parsed: unknown): string | null {
  const root = objectRecord(parsed);
  if (!root) return null;

  const nestedError = objectRecord(root.error);
  const candidates = [
    nestedError?.message,
    nestedError?.error,
    root.error,
    root.message,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return removeErrorPrefix(candidate);
    }
  }
  return null;
}

export function parseChatApiError(error: unknown): ChatApiErrorDetails {
  const rawMessage = valueToRawMessage(error);
  const parsed =
    error && typeof error === "object" && !(error instanceof Error)
      ? error
      : parseEmbeddedJson(rawMessage);
  const status = extractStatus(rawMessage, parsed);
  const providerErrorType = extractProviderErrorType(parsed);
  const providerMessage =
    extractProviderMessage(parsed) ||
    (rawMessage ? removeErrorPrefix(rawMessage) : null);
  const normalized = [
    rawMessage,
    providerErrorType,
    providerMessage,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLowerCase();
  const isRateLimit =
    status === 429 ||
    providerErrorType?.toLowerCase() === "rate_limit_error" ||
    /\brate[- ]?limited?\b/.test(normalized) ||
    normalized.includes("rate limit");

  return {
    rawMessage,
    status,
    providerErrorType,
    providerMessage,
    isRateLimit,
  };
}

function isHostedCreditExhaustedMessage(lowerMessage: string): boolean {
  return lowerMessage.includes("credits are used up");
}

function isBillingOrCreditError(lowerMessage: string): boolean {
  return (
    lowerMessage.includes("credit") ||
    lowerMessage.includes("billing") ||
    lowerMessage.includes("payment required") ||
    lowerMessage.includes("subscription") ||
    lowerMessage.includes("spend limit") ||
    lowerMessage.includes("spending limit") ||
    lowerMessage.includes("usage limit") ||
    lowerMessage.includes("hosted model")
  );
}

function isCurrentTurnByok(context: ChatApiErrorContext): boolean {
  if (context.billingSource === "hosted") return false;
  if (context.billingSource === "byok") return true;
  return isLlmModelCoveredByByokProvider(
    context.threadModel,
    context.llmProvider,
  );
}

function byokRateLimitPresentation(
  provider: LlmProvider | null | undefined,
): Extract<ChatApiErrorPresentation, { kind: "byok_rate_limit" }> {
  const providerMeta = getByokProviderMeta(provider);
  const providerLabel = providerMeta?.label ?? null;
  const providerName = providerLabel ?? "your API provider";

  return {
    kind: "byok_rate_limit",
    providerLabel,
    providerUrl: providerMeta?.getKeyUrl ?? null,
    providerLinkLabel:
      providerMeta?.settingsLinkLabel ?? providerMeta?.getKeyLinkLabel ?? null,
    title: providerLabel
      ? `Your ${providerLabel} API key is rate limited`
      : "Your API key is rate limited",
    message: `${providerName} rejected this request because your account hit an API rate limit. This limit is controlled by ${providerName}, not camelAI. Increase your limits in ${providerName}, reduce current usage, or wait 60 seconds and try again.`,
  };
}

function hostedRateLimitPresentation(): Extract<
  ChatApiErrorPresentation,
  { kind: "hosted_rate_limit" }
> {
  return {
    kind: "hosted_rate_limit",
    title: "The model provider is temporarily rate limiting camelAI",
    message:
      "Wait 60 seconds and try again. If this keeps happening, contact support. Your workspace is saved.",
  };
}

export function getChatApiErrorPresentation(
  error: unknown,
  context: ChatApiErrorContext = {},
): ChatApiErrorPresentation {
  const details = parseChatApiError(error);
  const message = details.providerMessage || "An unknown error occurred";

  if (details.isRateLimit) {
    return isCurrentTurnByok(context)
      ? byokRateLimitPresentation(context.llmProvider)
      : hostedRateLimitPresentation();
  }

  const lowerMessage = message.toLowerCase();
  if (isBillingOrCreditError(lowerMessage)) {
    return {
      kind: "generic",
      message: isHostedCreditExhaustedMessage(lowerMessage)
        ? CREDIT_SEND_BLOCKED_MESSAGE
        : message,
    };
  }

  return {
    kind: "generic",
    message,
  };
}

export function isRateLimitChatApiErrorPresentation(
  presentation: ChatApiErrorPresentation,
): presentation is Extract<
  ChatApiErrorPresentation,
  { kind: "byok_rate_limit" | "hosted_rate_limit" }
> {
  return (
    presentation.kind === "byok_rate_limit" ||
    presentation.kind === "hosted_rate_limit"
  );
}
