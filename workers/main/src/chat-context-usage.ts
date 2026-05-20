/**
 * Last per-API-call prompt usage captured from stream_event.message_start.
 */
export interface LastMessageStartUsage {
  inputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  model: string | null;
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Extract contextWindow for the captured message_start model.
 * Falls back to the maximum contextWindow across modelUsage entries.
 */
function extractContextWindowForModel(
  sdkEvent: { modelUsage?: unknown },
  model: string | null,
): number {
  if (!sdkEvent.modelUsage || typeof sdkEvent.modelUsage !== "object") return 0;

  const entries = sdkEvent.modelUsage as Record<string, unknown>;

  if (model && entries[model] && typeof entries[model] === "object") {
    const contextWindow = toFiniteNumber(
      (entries[model] as Record<string, unknown>).contextWindow,
    );
    if (contextWindow !== null && contextWindow > 0) {
      return contextWindow;
    }
  }

  let maxContextWindow = 0;
  for (const usage of Object.values(entries)) {
    if (!usage || typeof usage !== "object") continue;
    const contextWindow = toFiniteNumber(
      (usage as Record<string, unknown>).contextWindow,
    );
    if (contextWindow !== null && contextWindow > maxContextWindow) {
      maxContextWindow = contextWindow;
    }
  }
  return maxContextWindow;
}

export function extractContextWindowByModel(sdkEvent: {
  modelUsage?: unknown;
}): Record<string, number> {
  const byModel: Record<string, number> = {};
  if (!sdkEvent.modelUsage || typeof sdkEvent.modelUsage !== "object") {
    return byModel;
  }

  for (const [model, usage] of Object.entries(
    sdkEvent.modelUsage as Record<string, unknown>,
  )) {
    if (!usage || typeof usage !== "object") continue;
    const contextWindow = toFiniteNumber(
      (usage as Record<string, unknown>).contextWindow,
    );
    if (contextWindow !== null && contextWindow > 0) {
      byModel[model] = contextWindow;
    }
  }

  return byModel;
}

export function shallowEqualNumberMaps(
  a: Record<string, number>,
  b: Record<string, number>,
): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;

  for (const key of aKeys) {
    if (a[key] !== b[key]) return false;
  }

  return true;
}

function calculateContextUsedPercent(
  usage: LastMessageStartUsage,
  contextWindow: number,
): number {
  const totalInput =
    usage.inputTokens +
    usage.cacheReadInputTokens +
    usage.cacheCreationInputTokens;
  return Math.max(
    0,
    Math.min(100, Math.round((totalInput / contextWindow) * 100)),
  );
}

export interface ContextUsageTrackingState {
  contextUsedPercent: number | null;
  transientContextUsedPercent: number | null;
  lastMessageStartUsage: LastMessageStartUsage | null;
  usageIsPostCompaction: boolean;
  cachedContextWindowByModel: Record<string, number>;
}

export interface ContextUsageSdkEvent {
  type?: string;
  subtype?: string;
  modelUsage?: unknown;
  event?: {
    type?: string;
    message?: {
      usage?: unknown;
      model?: unknown;
    };
  };
}

export interface ContextUsageTrackingUpdate {
  nextState: ContextUsageTrackingState;
  // `undefined` means "no realtime update to broadcast"; `null` means "clear indicator".
  liveUsedPercent: number | null | undefined;
  finalUsedPercent: number | null;
  contextWindowCacheChanged: boolean;
}

export function applyContextUsageSdkEvent(
  currentState: ContextUsageTrackingState,
  sdkEvent: ContextUsageSdkEvent | undefined,
): ContextUsageTrackingUpdate {
  const nextState: ContextUsageTrackingState = {
    contextUsedPercent: currentState.contextUsedPercent,
    transientContextUsedPercent: currentState.transientContextUsedPercent,
    lastMessageStartUsage: currentState.lastMessageStartUsage,
    usageIsPostCompaction: currentState.usageIsPostCompaction,
    cachedContextWindowByModel: currentState.cachedContextWindowByModel,
  };

  let liveUsedPercent: number | null | undefined = undefined;
  let finalUsedPercent: number | null = null;
  let contextWindowCacheChanged = false;

  if (sdkEvent?.type === "stream_event") {
    const streamEvent = sdkEvent.event;
    if (streamEvent?.type === "message_start" && streamEvent.message?.usage) {
      const usage = streamEvent.message.usage as Record<string, unknown>;
      nextState.lastMessageStartUsage = {
        inputTokens:
          toFiniteNumber(usage.input_tokens) ??
          toFiniteNumber(usage.inputTokens) ??
          0,
        cacheReadInputTokens:
          toFiniteNumber(usage.cache_read_input_tokens) ??
          toFiniteNumber(usage.cacheReadInputTokens) ??
          0,
        cacheCreationInputTokens:
          toFiniteNumber(usage.cache_creation_input_tokens) ??
          toFiniteNumber(usage.cacheCreationInputTokens) ??
          0,
        model:
          typeof streamEvent.message.model === "string"
            ? streamEvent.message.model
            : null,
      };
      nextState.usageIsPostCompaction = true;

      const model = nextState.lastMessageStartUsage.model;
      const contextWindow = model
        ? nextState.cachedContextWindowByModel[model]
        : undefined;
      if (
        contextWindow &&
        contextWindow > 0 &&
        nextState.usageIsPostCompaction
      ) {
        const livePct = calculateContextUsedPercent(
          nextState.lastMessageStartUsage,
          contextWindow,
        );
        nextState.transientContextUsedPercent = livePct;
        liveUsedPercent = livePct;
      } else if (nextState.transientContextUsedPercent !== null) {
        // New call usage arrived for an uncached model; clear stale in-turn value.
        nextState.transientContextUsedPercent = null;
        liveUsedPercent = nextState.contextUsedPercent;
      }
    }
  }

  if (sdkEvent?.type === "system" && sdkEvent.subtype === "compact_boundary") {
    nextState.usageIsPostCompaction = false;
    const hadTransientUsage = nextState.transientContextUsedPercent !== null;
    nextState.transientContextUsedPercent = null;
    if (hadTransientUsage) {
      // Compact boundary invalidates in-turn usage; revert realtime state to canonical (or clear).
      liveUsedPercent = nextState.contextUsedPercent;
    }
  }

  if (sdkEvent?.type === "result") {
    const contextWindowByModel = extractContextWindowByModel(sdkEvent);
    if (Object.keys(contextWindowByModel).length > 0) {
      const mergedContextWindowByModel = {
        ...nextState.cachedContextWindowByModel,
        ...contextWindowByModel,
      };
      if (
        !shallowEqualNumberMaps(
          mergedContextWindowByModel,
          nextState.cachedContextWindowByModel,
        )
      ) {
        nextState.cachedContextWindowByModel = mergedContextWindowByModel;
        contextWindowCacheChanged = true;
      }
    }

    if (nextState.lastMessageStartUsage && nextState.usageIsPostCompaction) {
      let contextWindow = extractContextWindowForModel(
        sdkEvent,
        nextState.lastMessageStartUsage.model,
      );
      if (contextWindow <= 0 && nextState.lastMessageStartUsage.model) {
        const cachedContextWindow =
          nextState.cachedContextWindowByModel[
            nextState.lastMessageStartUsage.model
          ];
        if (
          typeof cachedContextWindow === "number" &&
          cachedContextWindow > 0
        ) {
          contextWindow = cachedContextWindow;
        }
      }

      if (contextWindow > 0) {
        const contextUsedPercent = calculateContextUsedPercent(
          nextState.lastMessageStartUsage,
          contextWindow,
        );
        nextState.contextUsedPercent = contextUsedPercent;
        finalUsedPercent = contextUsedPercent;
      }
    }

    nextState.transientContextUsedPercent = null;
    nextState.lastMessageStartUsage = null;
    nextState.usageIsPostCompaction = true;
  }

  return {
    nextState,
    liveUsedPercent,
    finalUsedPercent,
    contextWindowCacheChanged,
  };
}

export function resolveContextUsageForInit(
  transientContextUsedPercent: number | null,
  contextUsedPercent: number | null,
  chatIsStreaming: boolean,
): number | null {
  if (!chatIsStreaming) {
    return contextUsedPercent;
  }
  return transientContextUsedPercent ?? contextUsedPercent;
}
