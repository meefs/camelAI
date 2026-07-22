// pi_core → ai-chat render-mirror machinery for ChatThreadDO, extracted as a
// collaborator: the high-water-mark top-up backfill, the legacy time heal, the
// user render-skeleton builder, and the wipe-and-rebuild resync core. All state
// lives in the DO's SQLite/KV storage and ai-chat's durable render history; the
// class itself is stateless and is cached for the owning DO's lifetime with
// closures over its live deps (ChatThreadDO keeps thin same-named private delegates
// as its internal API, and the public RPCs getUiMessages /
// resyncUiMessagesFromPiCore stay on the DO as thin orchestrators). ai-chat
// base-class internals (`this.messages`, `persistMessages`, the private
// `_persistedMessageCache`) are reached only through the operation-shaped deps
// callbacks. Sibling-method calls route back through the deps callbacks — i.e.
// through the DO's delegates — so dynamic dispatch (and every
// `ChatThreadDO.prototype['method'].call(fake)` test seam that stubs a sibling
// on the fake) behaves exactly as it did when the bodies lived on the DO.
import type { UIMessage } from "ai";
import { messageToUiMessage, uiMessageCreatedAtMs } from "../../../../src/lib/ui-message-adapter";
import {
  parseMessageAuthor,
  resolveMessageAuthorDisplayName,
} from "../../../../src/lib/message-author";
import {
  PI_STEER_MARKER_PART,
  piSteerMarkerPartId,
} from "../../../../src/lib/pi-chunk-encoder";
import type { ContentBlock, Message } from "../../../../src/types";
import type { PiActiveTurnMarker, SyncKvStorage } from "./pi-turn-journal";
import type { PiCoreRevision } from "./pi-core-store";
import type { AgentEvalParsedMessage, ChatContextState } from "./types";

// High-water mark for the pi_core → ai-chat render-history top-up backfill
// (see topUpUiMessagesFromPiCore). The value is the count of parsed render
// messages already mirrored into cf_ai_chat_agent_messages; toolResult rows
// merge into their assistant message and internal/empty rows drop, so a parsed
// count (not the raw SQL idx) is the stable high-water unit for the deterministic
// array-index-based render ids. Every pi_core rewrite invalidates the mark;
// replacePiCoreMessages re-pins or rebuilds it per its uiRender option.
export const UI_MESSAGES_PI_CORE_HIGH_WATER_KEY = "uiMessagesPiCoreHighWaterIdx";
// Raw pi_core generation/count paired with the parsed high-water mark. Unlike
// the parsed count this can be read without selecting or parsing payload rows.
export const UI_MESSAGES_PI_CORE_REVISION_KEY = "uiMessagesPiCoreRevisionV1";
// Last explicit created_at (ms) written by the backfill, persisted so successive
// top-ups keep strictly increasing timestamps even across DO wakes.
const UI_MESSAGES_PI_CORE_LAST_CREATED_AT_KEY = "uiMessagesPiCoreLastCreatedAtMs";
// One-shot marker for healLegacyUiMessageTimes (rows persisted before the
// pi.createdAtMs / pi.completedAtMs stamps existed render epoch 0 — "4:00 PM"
// in Pacific — until healed from the row's created_at column).
const UI_MESSAGES_TIME_HEAL_KEY = "uiMessagesTimeHealDone";
const UI_MESSAGES_AUTHOR_ATTRIBUTION_HEAL_KEY =
  "uiMessagesAuthorAttributionHealV1";

function normalizedMetadataString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.trim() || null;
}

// SQLite `current_timestamp` yields "YYYY-MM-DD HH:MM:SS" (UTC, 1s resolution).
// ai-chat orders render history by that column, so backfilled rows format their
// explicit created_at the same way but with milliseconds ("...:SS.mmm"): the
// millisecond suffix sorts lexicographically right after the whole-second live
// rows, keeping backfilled history correctly interleaved with live turns.
function formatAiChatCreatedAt(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace("Z", "");
}

export interface ChatThreadUiMirrorDeps {
  sql(): SqlStorage;
  kv(): SyncKvStorage;
  chatContext(): ChatContextState | null;
  // ai-chat base-class internals, exposed as operations (never the DO itself):
  /** AIChatAgent's in-memory render list (`this.messages`), read side. */
  getRenderMessages(): UIMessage[];
  /** Replace AIChatAgent's in-memory render list (`this.messages = ...`). */
  setRenderMessages(messages: UIMessage[]): void;
  /** AIChatAgent#persistMessages: sanitize, upsert by id, refresh, broadcast. */
  persistRenderMessages(messages: UIMessage[]): Promise<void>;
  /** Clear AIChatAgent's private serialized-upsert cache (`_persistedMessageCache`). */
  clearPersistedRenderCache(): void;
  // Sibling routing back through the owning DO's same-named delegates, so a
  // stubbed sibling on a fake (or a subclass override) is honored exactly as
  // it was when these methods lived on ChatThreadDO itself.
  readPiActiveTurn(): PiActiveTurnMarker | null;
  activePiStreamTurnId(): string | null;
  getPiCoreRevision(): PiCoreRevision;
  getPiCoreParsedMessages(threadId: string): Promise<AgentEvalParsedMessage[]>;
  reloadAiChatMessagesOrdered(): void;
  topUpUiMessagesFromPiCore(options?: { force?: boolean }): Promise<void>;
  withMemoryPhase<T>(operation: string, fn: () => Promise<T>): Promise<T>;
  recordChatThreadObservabilityEvent(
    event: string,
    details?: {
      operation?: string;
      status?: string;
      count?: number;
      durationMs?: number;
    },
  ): void;
}

export class ChatThreadUiMirror {
  constructor(private readonly deps: ChatThreadUiMirrorDeps) {}

  /**
   * Build a native user render bubble for the linear ai-chat history (commit 3b).
   * Uses the client-supplied message id when present so the client's optimistic
   * echo and the durable row share an id.
   */
  buildUserUiSkeleton(args: {
    rawContent: string;
    clientMessageId?: string;
    authorDisplayName?: string | null;
    messageSource?: string | null;
    channelHistory?: boolean;
    piCoreMessageKey?: number | string;
    sentDuringStreaming?: boolean;
  }): UIMessage {
    const metadata: Record<string, unknown> = {};
    const authorDisplayName = resolveMessageAuthorDisplayName(
      args.authorDisplayName,
      null,
    );
    const messageSource = normalizedMetadataString(args.messageSource);
    if (authorDisplayName) metadata.authorDisplayName = authorDisplayName;
    if (messageSource) metadata.source = messageSource;
    if (args.channelHistory) metadata.channelHistory = true;
    if (args.sentDuringStreaming) metadata.sentDuringStreaming = true;
    // Stamp the pi_core timestamp of the row Pi commits for this same user
    // message so the top-up backfill can recognize the live-written skeleton and
    // skip re-converting the pi_core row into a duplicate (topUpUiMessagesFromPiCore).
    if (args.piCoreMessageKey !== undefined && args.piCoreMessageKey !== null) {
      metadata.piCoreMessageKey = String(args.piCoreMessageKey);
    }
    return {
      id:
        args.clientMessageId && args.clientMessageId.trim()
          ? args.clientMessageId.trim()
          : crypto.randomUUID(),
      role: "user",
      parts: [{ type: "text", text: args.rawContent, state: "done" }],
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    } as UIMessage;
  }

  /**
   * One-shot lazy migration: rows persisted before the time stamps shipped
   * (the backfill's `pi.createdAtMs` and the encoder's `pi.completedAtMs`,
   * both from the ai-chat streaming migration) carry no recoverable creation
   * time, so the client renders epoch 0 — a fixed "4:00 PM" in Pacific.
   * Recover the time from the row's own `created_at` column (insert time —
   * within a turn of the truth for legacy rows) and stamp it durably. Gated
   * off while a turn is in flight (the streaming row legitimately has no
   * metadata yet and must not be stamped with an insert-time heal); the
   * marker is only written once a quiet pass completes.
   */
  async healLegacyUiMessageTimes(): Promise<void> {
    if (this.deps.kv().get<boolean>(UI_MESSAGES_TIME_HEAL_KEY)) return;
    if (this.deps.readPiActiveTurn() || this.deps.activePiStreamTurnId() !== null) return;
    const missing = this.deps.getRenderMessages().filter(
      (message) => uiMessageCreatedAtMs(message) === undefined,
    );
    if (missing.length > 0) {
      const rows = this.deps.sql()
        .exec<{ id: string; created_at: string }>(
          "SELECT id, created_at FROM cf_ai_chat_agent_messages",
        )
        .toArray();
      const createdById = new Map(rows.map((row) => [row.id, row.created_at]));
      let changed = false;
      const healed = this.deps.getRenderMessages().map((message) => {
        if (uiMessageCreatedAtMs(message) !== undefined) return message;
        const raw = createdById.get(message.id);
        // Column format is SQLite UTC "YYYY-MM-DD HH:MM:SS(.mmm)".
        const ms = raw ? Date.parse(`${raw.replace(" ", "T")}Z`) : Number.NaN;
        if (!Number.isFinite(ms) || ms <= 0) return message;
        const metadata = (message.metadata ?? {}) as Record<string, unknown>;
        const pi = (metadata.pi && typeof metadata.pi === "object"
          ? { ...(metadata.pi as Record<string, unknown>) }
          : {}) as Record<string, unknown>;
        pi.createdAtMs = ms;
        changed = true;
        return { ...message, metadata: { ...metadata, pi } } as UIMessage;
      });
      if (changed) {
        await this.deps.persistRenderMessages(healed);
        this.deps.recordChatThreadObservabilityEvent("pi_ui_message_times_healed", {
          operation: "heal_legacy_ui_message_times",
          status: "healed",
          count: missing.length,
        });
      }
    }
    this.deps.kv().put(UI_MESSAGES_TIME_HEAL_KEY, true);
  }

  /**
   * One-shot lazy repair for raw user render rows created before structured
   * author metadata shipped. The render-message id is the authoritative join;
   * piCoreMessageKey is only a fallback when its timestamp identifies exactly
   * one canonical Pi user row. Only metadata is merged into the raw UI message,
   * so ids, visible parts, timestamps, and unknown metadata stay intact.
   */
  async healLegacyUiMessageAuthors(): Promise<void> {
    if (
      this.deps.kv().get<boolean>(
        UI_MESSAGES_AUTHOR_ATTRIBUTION_HEAL_KEY,
      )
    ) {
      return;
    }
    if (
      this.deps.readPiActiveTurn() ||
      this.deps.activePiStreamTurnId() !== null
    ) {
      return;
    }

    const renderMessages = this.deps.getRenderMessages();
    const candidates = renderMessages.filter((message) => {
      if (message.role !== "user") return false;
      const metadata = (message.metadata ?? {}) as Record<string, unknown>;
      return (
        !normalizedMetadataString(metadata.authorDisplayName) &&
        typeof metadata.piCoreMessageKey === "string"
      );
    });

    let changedCount = 0;
    if (candidates.length > 0) {
      const threadId = this.deps.chatContext()?.threadId ?? "";
      const parsedPiMessages = await this.deps.getPiCoreParsedMessages(threadId);
      // The Pi read above can yield. If a turn started in that window, leave the
      // repair unmarked so a later quiet history read can retry safely.
      if (
        this.deps.readPiActiveTurn() ||
        this.deps.activePiStreamTurnId() !== null
      ) {
        return;
      }
      const piUsersByRenderMessageId = new Map<
        string,
        AgentEvalParsedMessage
      >();
      const piUsersByTimestamp = new Map<
        string,
        AgentEvalParsedMessage[]
      >();
      for (const message of parsedPiMessages) {
        if (message.role !== "user") continue;
        const renderMessageId = normalizedMetadataString(
          message.renderMessageId,
        );
        if (renderMessageId) {
          piUsersByRenderMessageId.set(renderMessageId, message);
        }
        const timestamp = String(message.created_at);
        const timestampMatches = piUsersByTimestamp.get(timestamp) ?? [];
        timestampMatches.push(message);
        piUsersByTimestamp.set(timestamp, timestampMatches);
      }

      const candidateIds = new Set(candidates.map((message) => message.id));
      const healed = renderMessages.map((message) => {
        if (!candidateIds.has(message.id)) return message;
        const metadata = (message.metadata ?? {}) as Record<string, unknown>;
        const piCoreMessageKey = metadata.piCoreMessageKey;
        if (typeof piCoreMessageKey !== "string") return message;
        const exact = piUsersByRenderMessageId.get(message.id);
        const timestampMatches =
          piUsersByTimestamp.get(piCoreMessageKey) ?? [];
        const canonical =
          exact ??
          (timestampMatches.length === 1 ? timestampMatches[0] : undefined);
        if (!canonical) return message;

        const canonicalContent = canonical.content;
        const parsed = typeof canonicalContent === "string"
          ? parseMessageAuthor(canonicalContent)
          : Array.isArray(canonicalContent)
            ? parseMessageAuthor(canonicalContent as ContentBlock[])
            : null;
        if (!parsed) return message;

        const authorDisplayName = parsed.author?.displayName ?? null;
        const source = normalizedMetadataString(parsed.source);
        const existingSource = normalizedMetadataString(metadata.source);
        if (!authorDisplayName && (!source || existingSource)) return message;

        changedCount += 1;
        return {
          ...message,
          metadata: {
            ...metadata,
            ...(authorDisplayName ? { authorDisplayName } : {}),
            ...(!existingSource && source ? { source } : {}),
          },
        } as UIMessage;
      });

      if (changedCount > 0) {
        await this.deps.persistRenderMessages(healed);
        this.deps.recordChatThreadObservabilityEvent(
          "pi_ui_message_authors_healed",
          {
            operation: "heal_legacy_ui_message_authors",
            status: "healed",
            count: changedCount,
          },
        );
      }
    }

    this.deps.kv().put(UI_MESSAGES_AUTHOR_ATTRIBUTION_HEAL_KEY, true);
  }

  /**
   * Wipe the ai-chat render mirror and rebuild it from pi_core. Shared by the
   * admin resync RPC and every history-invalidating pi_core rewrite.
   */
  async rebuildUiMessagesFromPiCore(): Promise<void> {
    this.deps.sql().exec("DELETE FROM cf_ai_chat_agent_messages");
    this.deps.kv().delete(UI_MESSAGES_PI_CORE_HIGH_WATER_KEY);
    this.deps.kv().delete(UI_MESSAGES_PI_CORE_REVISION_KEY);
    this.deps.kv().delete(UI_MESSAGES_PI_CORE_LAST_CREATED_AT_KEY);
    this.deps.setRenderMessages([]);
    // ai-chat's persistMessages skips upserts whose serialized form matches its
    // in-memory persisted cache; after wiping the table those entries are stale
    // and would silently drop unchanged rows from the rebuild. The framework's
    // own chat-clear handler clears this cache the same way.
    this.deps.clearPersistedRenderCache();
    await this.deps.topUpUiMessagesFromPiCore({ force: true });
  }

  /**
   * High-water-mark top-up: convert pi_core render messages beyond the mark into
   * native UIMessages and persist them into ai-chat's durable render history. The
   * mark is the count of parsed render messages already mirrored; deterministic
   * ids (forkEntryId / pi item ids from the shared adapter) make the upsert
   * idempotent, and explicit monotonic created_at keeps ai-chat's `order by
   * created_at` load stable (its default per-row timestamp is 1s-resolution insert
   * time, so a burst of backfilled rows would otherwise tie and shuffle).
   */
  async topUpUiMessagesFromPiCore(
    options: { force?: boolean } = {},
  ): Promise<void> {
    // While a Pi turn is in flight (or awaiting recovery), pi_core rows beyond
    // the mark belong to that turn: they stream into the live turnId render row
    // (or its recovery continuation), so converting them here would churn the
    // live message mid-stream. The turn's terminal paths clear the marker; the
    // next top-up reconciles. Ordering beyond the marker doesn't matter for
    // correctness: stamped rows convert under the SAME id the live stream
    // persists (uiMetadata.renderMessageId), so whichever writer runs first,
    // the other's upsert converges on one row. `force` bypasses the gate for
    // explicit rebuild flows (admin resync, fork seeding).
    const startedAt = Date.now();
    const preflight = await this.deps.withMemoryPhase(
      "pi_topup_preflight",
      async () => {
        if (!options.force && this.deps.readPiActiveTurn()) return null;
        const revision = this.deps.getPiCoreRevision();
        const revisionToken = `${revision.generation}:${revision.count}`;
        if (
          !options.force &&
          this.deps.kv().get<string>(UI_MESSAGES_PI_CORE_REVISION_KEY) === revisionToken
        ) {
          return null;
        }
        return {
          revisionToken,
          threadId: this.deps.chatContext()?.threadId ?? "",
        };
      },
    );
    if (!preflight) return;
    const parsed = await this.deps.withMemoryPhase("pi_topup_read", () =>
      this.deps.getPiCoreParsedMessages(preflight.threadId),
    );
    await this.deps.withMemoryPhase("pi_topup_convert", () =>
      this.convertPiCoreTopUp(parsed, preflight.revisionToken, startedAt),
    );
  }

  private async convertPiCoreTopUp(
    parsed: AgentEvalParsedMessage[],
    revisionToken: string,
    startedAt: number,
  ): Promise<void> {
    const mark = this.deps.kv().get<number>(
      UI_MESSAGES_PI_CORE_HIGH_WATER_KEY,
    ) ?? 0;
    if (parsed.length <= mark) {
      this.deps.kv().put(UI_MESSAGES_PI_CORE_REVISION_KEY, revisionToken);
      return;
    }

    const newParsed = parsed.slice(mark);
    let lastCreatedAtMs =
      this.deps.kv().get<number>(
        UI_MESSAGES_PI_CORE_LAST_CREATED_AT_KEY,
      ) ?? 0;
    // Dedup against rows the live paths already wrote:
    //  - STAMPED assistant rows (uiMetadata.renderMessageId, every commit since
    //    stamping shipped) convert under exactly the live stream's message id,
    //    so a plain id-existence check is the whole dedup — and when neither
    //    row exists yet, whichever writer runs first, the other upserts the
    //    same id and converges.
    //  - user rows match by the exact pi timestamp stamped on their skeleton
    //    (metadata.piCoreMessageKey).
    //  - LEGACY unstamped assistant rows (committed before stamping shipped,
    //    e.g. a turn that straddled the deploy) fall back to the old content
    //    heuristics: fork-id and tool-call identity against existing messages.
    //    Delete this fallback once pre-stamp in-flight turns are gone.
    // The high-water mark still advances past skipped rows.
    const existingIds = new Set<string>(this.deps.getRenderMessages().map((m) => m.id));
    const existingForkEntryIds = new Set<string>();
    const existingUserIdsByKey = new Map<string, string>();
    const existingToolCallIds = new Set<string>();
    for (const existing of this.deps.getRenderMessages()) {
      const metadata = (existing as { metadata?: Record<string, unknown> })
        .metadata;
      if (metadata && typeof metadata === "object") {
        const pi = metadata.pi as
          | { forkEntryId?: unknown; forkEntryIds?: unknown }
          | undefined;
        if (pi && typeof pi.forkEntryId === "string" && pi.forkEntryId) {
          existingForkEntryIds.add(pi.forkEntryId);
        }
        if (pi && Array.isArray(pi.forkEntryIds)) {
          for (const id of pi.forkEntryIds) {
            if (typeof id === "string" && id) existingForkEntryIds.add(id);
          }
        }
        if (typeof metadata.piCoreMessageKey === "string" && metadata.piCoreMessageKey) {
          existingUserIdsByKey.set(metadata.piCoreMessageKey, existing.id);
        }
      }
      const parts = (existing as { parts?: unknown }).parts;
      if (existing.role === "assistant" && Array.isArray(parts)) {
        for (const part of parts) {
          const toolCallId = (part as { toolCallId?: unknown } | null)?.toolCallId;
          if (typeof toolCallId === "string" && toolCallId) {
            existingToolCallIds.add(toolCallId);
          }
        }
      }
    }
    const parsedAssistantToolCallIds = (content: unknown): string[] => {
      if (!Array.isArray(content)) return [];
      const ids: string[] = [];
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const record = block as Record<string, unknown>;
        if (record.type === "tool_use" && typeof record.id === "string" && record.id) {
          ids.push(record.id);
        }
      }
      return ids;
    };

    const convertedByIndex = new Map<number, UIMessage>();
    const convertAt = (index: number): UIMessage => {
      const cached = convertedByIndex.get(index);
      if (cached) return cached;
      const row = newParsed[index];
      let converted = messageToUiMessage(row as unknown as Message);
      // User pi_core rows are stamped with the id of their live skeleton. A
      // rebuild must preserve it so a synthetic steer marker can consume the
      // rebuilt bubble by the same-content-same-id invariant.
      if (
        row.role === "user" &&
        typeof row.renderMessageId === "string" &&
        row.renderMessageId
      ) {
        converted = { ...converted, id: row.renderMessageId } as UIMessage;
      }
      convertedByIndex.set(index, converted);
      return converted;
    };
    const resolvedUserIdAt = (index: number): string => {
      const row = newParsed[index];
      const existingId = existingUserIdsByKey.get(String(row.created_at));
      if (existingId) return existingId;
      if (
        typeof row.renderMessageId === "string" &&
        row.renderMessageId
      ) {
        return row.renderMessageId;
      }
      // The deterministic row-derived id is also the id assigned when this
      // user is converted during the same pass. If its bubble is unavailable,
      // the client safely joins around the unmatched marker.
      return convertAt(index).id;
    };

    // A multi-SDK-turn run commits one pi_core assistant row per SDK turn, all
    // stamped with the ONE live render id. Steered user rows break contiguity,
    // so fold by stamp across the whole pass and insert a marker for every user
    // row between assistant commits. This prevents a later same-id upsert from
    // clobbering the pre-steer half during a full rebuild.
    const assistantIndexesByStamp = new Map<string, number[]>();
    for (let index = 0; index < newParsed.length; index += 1) {
      const row = newParsed[index];
      if (
        row.role !== "assistant" ||
        typeof row.renderMessageId !== "string" ||
        !row.renderMessageId
      ) {
        continue;
      }
      const indexes = assistantIndexesByStamp.get(row.renderMessageId) ?? [];
      indexes.push(index);
      assistantIndexesByStamp.set(row.renderMessageId, indexes);
    }

    const stampedAssistantIndexes = new Set<number>();
    const foldedAssistantByFirstIndex = new Map<number, UIMessage>();
    for (const [renderMessageId, indexes] of assistantIndexesByStamp) {
      for (const index of indexes) stampedAssistantIndexes.add(index);
      // The live stream already persisted the complete marked row. Every
      // assistant commit sharing its id is covered by that one exact-id skip.
      if (existingIds.has(renderMessageId)) continue;

      const firstIndex = indexes[0];
      const parts: UIMessage["parts"] = [];
      let previousAssistantIndex = firstIndex;
      for (let offset = 0; offset < indexes.length; offset += 1) {
        const assistantIndex = indexes[offset];
        if (offset > 0) {
          for (
            let between = previousAssistantIndex + 1;
            between < assistantIndex;
            between += 1
          ) {
            const interposed = newParsed[between];
            if (interposed.role !== "user") continue;
            const steerMessageId = resolvedUserIdAt(between);
            const acceptedAtMs =
              typeof interposed.created_at === "number" &&
              Number.isFinite(interposed.created_at)
                ? interposed.created_at
                : Date.now();
            parts.push({
              type: PI_STEER_MARKER_PART,
              id: piSteerMarkerPartId(steerMessageId),
              data: { steerMessageId, acceptedAtMs },
            } as UIMessage["parts"][number]);
          }
        }
        parts.push(...convertAt(assistantIndex).parts);
        previousAssistantIndex = assistantIndex;
      }

      const rows = indexes.map((index) => newParsed[index]);
      const forkEntryIds = rows
        .map((row) => row.forkEntryId)
        .filter((id): id is string => typeof id === "string" && !!id);
      const pi: Record<string, unknown> = forkEntryIds.length > 0
        ? {
            forkEntryId: forkEntryIds[forkEntryIds.length - 1],
            forkEntryIds,
          }
        : {};
      const firstCreatedAt = (
        convertAt(firstIndex).metadata as
          | { pi?: { createdAtMs?: unknown } }
          | undefined
      )?.pi?.createdAtMs;
      if (typeof firstCreatedAt === "number") pi.createdAtMs = firstCreatedAt;
      foldedAssistantByFirstIndex.set(firstIndex, {
        id: renderMessageId,
        role: "assistant",
        parts,
        metadata: { pi },
      } as UIMessage);
    }

    const uiMessages: UIMessage[] = [];
    const createdAtById = new Map<string, number>();
    for (let index = 0; index < newParsed.length; index += 1) {
      const first = newParsed[index];
      let ui: UIMessage;

      if (stampedAssistantIndexes.has(index)) {
        const folded = foldedAssistantByFirstIndex.get(index);
        if (!folded) continue;
        ui = folded;
      } else if (first.role === "assistant") {
        // Legacy unstamped assistant row: old content heuristics.
        if (
          typeof first.forkEntryId === "string" &&
          existingForkEntryIds.has(first.forkEntryId)
        ) {
          continue;
        }
        const toolCallIds = parsedAssistantToolCallIds(first.content);
        if (toolCallIds.some((id) => existingToolCallIds.has(id))) {
          continue;
        }
        ui = convertAt(index);
      } else if (
        first.role === "user" &&
        existingUserIdsByKey.has(String(first.created_at))
      ) {
        continue;
      } else {
        ui = convertAt(index);
        if (existingIds.has(ui.id)) continue;
      }

      const baseMs =
        typeof first.created_at === "number" && Number.isFinite(first.created_at)
          ? first.created_at
          : Date.now();
      const createdAtMs = Math.max(baseMs, lastCreatedAtMs + 1);
      lastCreatedAtMs = createdAtMs;
      createdAtById.set(ui.id, createdAtMs);
      uiMessages.push(ui);
    }

    if (uiMessages.length > 0) {
      // persistMessages sanitizes, upserts (idempotent by id), refreshes the
      // in-memory list, and broadcasts — but stamps created_at with the insert-
      // time default, so overwrite it with the monotonic values and reload the
      // in-memory order to match a fresh wake's `order by created_at`.
      await this.deps.persistRenderMessages([...this.deps.getRenderMessages(), ...uiMessages]);
      for (const [id, createdAtMs] of createdAtById) {
        this.deps.sql().exec(
          "UPDATE cf_ai_chat_agent_messages SET created_at = ? WHERE id = ?",
          formatAiChatCreatedAt(createdAtMs),
          id,
        );
      }
      this.deps.reloadAiChatMessagesOrdered();
      this.deps.kv().put(
        UI_MESSAGES_PI_CORE_LAST_CREATED_AT_KEY,
        lastCreatedAtMs,
      );
      this.deps.recordChatThreadObservabilityEvent("pi_ui_messages_backfilled", {
        operation: "topup_ui_messages",
        status: "converted",
        count: uiMessages.length,
        durationMs: Date.now() - startedAt,
      });
    }
    this.deps.kv().put(UI_MESSAGES_PI_CORE_HIGH_WATER_KEY, parsed.length);
    this.deps.kv().put(UI_MESSAGES_PI_CORE_REVISION_KEY, revisionToken);
  }

  /**
   * Reload the in-memory ai-chat message list from SQLite ordered by created_at,
   * matching ai-chat's own load semantics (used after a direct created_at UPDATE
   * that persistMessages' in-memory refresh predates).
   */
  reloadAiChatMessagesOrdered(): void {
    const rows = this.deps.sql()
      .exec<{ id: string; message: string }>(
        "SELECT id, message FROM cf_ai_chat_agent_messages ORDER BY created_at",
      )
      .toArray();
    const messages: UIMessage[] = [];
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.message) as UIMessage;
        if (
          parsed &&
          typeof parsed.id === "string" &&
          typeof parsed.role === "string" &&
          Array.isArray(parsed.parts)
        ) {
          messages.push(parsed);
        }
      } catch {
        // A row that fails to parse is skipped, matching ai-chat's loader.
      }
    }
    this.deps.setRenderMessages(messages);
  }
}
