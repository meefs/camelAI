// Privacy-safe memory accounting for ChatThreadDO. This module deliberately
// operates on SQLite aggregate scalars only: transcript rows are never selected,
// parsed, logged, or serialized in JavaScript.
export type ChatMemoryStore = "render" | "pi" | "journal" | "stream";

export interface ChatMemoryStoreStats {
  rows: number;
  bytes: number;
  maxRowBytes: number;
}

export interface ChatMemoryStats {
  totalRows: number;
  totalBytes: number;
  maxRowBytes: number;
  stores: Record<ChatMemoryStore, ChatMemoryStoreStats>;
}

const EMPTY_STORE: ChatMemoryStoreStats = { rows: 0, bytes: 0, maxRowBytes: 0 };

const STORE_QUERIES: Record<
  ChatMemoryStore,
  { table: string; column: string }
> = {
  render: { table: "cf_ai_chat_agent_messages", column: "message" },
  pi: { table: "pi_core_messages", column: "payload" },
  journal: { table: "pi_turn_journal", column: "payload" },
  stream: { table: "cf_ai_chat_stream_chunks", column: "body" },
};

function finiteNonNegative(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

/** Cheap aggregate reads; missing/legacy tables are represented by zeroes. */
export function collectChatMemoryStats(sql: SqlStorage): ChatMemoryStats {
  const stores = {} as Record<ChatMemoryStore, ChatMemoryStoreStats>;
  for (const store of Object.keys(STORE_QUERIES) as ChatMemoryStore[]) {
    const { table, column } = STORE_QUERIES[store];
    try {
      const row = sql
        .exec<{ rows: number; bytes: number; max_row_bytes: number }>(
          `SELECT COUNT(*) AS rows,
                COALESCE(SUM(length(CAST(${column} AS BLOB))), 0) AS bytes,
                COALESCE(MAX(length(CAST(${column} AS BLOB))), 0) AS max_row_bytes
           FROM ${table}`,
        )
        .one();
      stores[store] = {
        rows: finiteNonNegative(row.rows),
        bytes: finiteNonNegative(row.bytes),
        maxRowBytes: finiteNonNegative(row.max_row_bytes),
      };
    } catch {
      // Tables are created lazily by the owning SDKs. Missing telemetry must
      // never make a chat operation fail or cause a table to be created.
      stores[store] = { ...EMPTY_STORE };
    }
  }
  const values = Object.values(stores);
  return {
    totalRows: values.reduce((sum, value) => sum + value.rows, 0),
    totalBytes: values.reduce((sum, value) => sum + value.bytes, 0),
    maxRowBytes: values.reduce(
      (max, value) => Math.max(max, value.maxRowBytes),
      0,
    ),
    stores,
  };
}
