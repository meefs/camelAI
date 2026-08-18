/**
 * Storage instrumentation for the working-set invariants suite.
 *
 * WHERE IT MEASURES, AND WHY THAT MATTERS. This wraps `ctx.storage.sql` on a
 * REAL Durable Object instance, so every read the DO performs is counted no
 * matter which helper issued it — `PiCoreMessageStore`, the derive pager, the
 * ai-chat base class's tagged-template `sql`, the resumable-stream buffer, or a
 * raw `ctx.storage.sql.exec` written tomorrow by someone who never read this
 * file. There is no app-level seam to route around, which is the whole point: a
 * counter that lives on a wrapper (a `recordReadOperation` callback, a mocked
 * store) measures the paths that remembered to call it, and the four historical
 * OOMs were all paths that did not.
 *
 * WHAT IT MEASURES. Bytes are counted when rows are MATERIALIZED into JS
 * (`toArray`, `one`, iteration), not when the statement is issued — a cursor
 * that is never consumed allocates nothing, and a lazily-consumed one allocates
 * when it is consumed. That is the actual allocator these budgets are about.
 *
 * Four numbers, because "bounded" means different things per surface:
 *   - `bytesMaterialized` / `rowsRead`: cumulative work. The bound for anything
 *     that serves a page or a window.
 *   - `maxBytesPerQuery`: the biggest single materialization. This is what
 *     catches "one SELECT for the whole table" — the shape of every historical
 *     bug — even in a path that is legitimately allowed to walk the thread.
 *   - `maxBytesBetweenRenderWrites`: bytes read since the last durable render
 *     write. In a read-batch → persist-batch loop this is the peak residency
 *     proxy: a bounded pager keeps it at one batch, a "materialize everything
 *     then persist once" implementation keeps it at the whole thread.
 */

export interface StorageUsage {
  execCalls: number;
  rowsRead: number;
  bytesMaterialized: number;
  maxRowsPerQuery: number;
  maxBytesPerQuery: number;
  maxBytesBetweenRenderWrites: number;
  /** Per-table split, keyed by the table names these budgets care about. */
  piCoreRowsRead: number;
  /**
   * Rows from pi_core queries that materialized NO string column — the
   * `length(payload)` metadata probes the bounded readers use to size a batch
   * before paying for it. Counted apart from `piCoreRowsRead` on purpose: a
   * metadata probe is two numbers per row and is the CURE, not the disease, so
   * folding it into the payload-row budget would penalise the bounded readers
   * for being careful.
   */
  piCoreMetadataRowsRead: number;
  piCoreBytesMaterialized: number;
  renderRowsRead: number;
  renderBytesMaterialized: number;
  streamRowsRead: number;
  streamBytesMaterialized: number;
}

export function emptyUsage(): StorageUsage {
  return {
    execCalls: 0,
    rowsRead: 0,
    bytesMaterialized: 0,
    maxRowsPerQuery: 0,
    maxBytesPerQuery: 0,
    maxBytesBetweenRenderWrites: 0,
    piCoreRowsRead: 0,
    piCoreMetadataRowsRead: 0,
    piCoreBytesMaterialized: 0,
    renderRowsRead: 0,
    renderBytesMaterialized: 0,
    streamRowsRead: 0,
    streamBytesMaterialized: 0,
  };
}

/** JS chars a materialized row occupies in its string columns. */
function rowChars(row: unknown): number {
  if (!row || typeof row !== "object") return 0;
  let chars = 0;
  for (const value of Object.values(row as Record<string, unknown>)) {
    if (typeof value === "string") chars += value.length;
  }
  return chars;
}

type Meter = (rows: readonly unknown[]) => void;

function wrapCursor(cursor: any, meter: Meter): any {
  const wrapped: any = {
    toArray() {
      const rows = cursor.toArray();
      meter(rows);
      return rows;
    },
    one() {
      const row = cursor.one();
      meter([row]);
      return row;
    },
    raw() {
      const raw = cursor.raw();
      return {
        [Symbol.iterator]() {
          return this;
        },
        next() {
          const step = raw.next();
          if (!step.done) meter([step.value]);
          return step;
        },
      };
    },
    next() {
      const step = cursor.next();
      if (!step.done) meter([step.value]);
      return step;
    },
    [Symbol.iterator]() {
      const iterator = cursor[Symbol.iterator]();
      return {
        [Symbol.iterator]() {
          return this;
        },
        next() {
          const step = iterator.next();
          if (!step.done) meter([step.value]);
          return step;
        },
      };
    },
  };
  Object.defineProperty(wrapped, "columnNames", {
    get: () => cursor.columnNames,
  });
  Object.defineProperty(wrapped, "rowsRead", { get: () => cursor.rowsRead });
  Object.defineProperty(wrapped, "rowsWritten", {
    get: () => cursor.rowsWritten,
  });
  return wrapped;
}

const PI_CORE_TABLE = "pi_core_messages";
const RENDER_TABLE = "cf_ai_chat_agent_messages";
const STREAM_TABLE = "cf_ai_chat_stream_chunks";

function isWrite(sql: string): boolean {
  const head = sql.trimStart().slice(0, 8).toLowerCase();
  return (
    head.startsWith("insert") ||
    head.startsWith("update") ||
    head.startsWith("delete") ||
    head.startsWith("replace")
  );
}

export interface StorageMeter {
  /** Run `fn` and return everything the DO's storage did while it ran. */
  measure<T>(fn: () => T | Promise<T>): Promise<{ result: T; usage: StorageUsage }>;
  /** Cumulative usage since install (or since the last `reset`). */
  readonly total: StorageUsage;
  reset(): void;
  uninstall(): void;
}

/**
 * Install the wrapper on a live DO instance. Idempotent per instance, and
 * removable (`uninstall`) so one instance can be reused across cases.
 */
export function instrumentDurableObjectStorage(instance: any): StorageMeter {
  const storage = instance.ctx.storage;
  const existing = storage.__workingSetMeter as StorageMeter | undefined;
  if (existing) return existing;

  const realSql = storage.sql;
  const realExec = realSql.exec.bind(realSql);
  let total = emptyUsage();
  let scope: StorageUsage | null = null;
  let bytesSinceRenderWrite = 0;

  const record = (
    sql: string,
    rows: readonly unknown[],
  ): void => {
    let chars = 0;
    for (const row of rows) chars += rowChars(row);
    const targets: StorageUsage[] = scope ? [total, scope] : [total];
    const piCore = sql.includes(PI_CORE_TABLE);
    const render = sql.includes(RENDER_TABLE);
    const stream = sql.includes(STREAM_TABLE);
    bytesSinceRenderWrite += chars;
    for (const usage of targets) {
      usage.rowsRead += rows.length;
      usage.bytesMaterialized += chars;
      usage.maxRowsPerQuery = Math.max(usage.maxRowsPerQuery, rows.length);
      usage.maxBytesPerQuery = Math.max(usage.maxBytesPerQuery, chars);
      usage.maxBytesBetweenRenderWrites = Math.max(
        usage.maxBytesBetweenRenderWrites,
        bytesSinceRenderWrite,
      );
      if (piCore) {
        if (chars > 0) usage.piCoreRowsRead += rows.length;
        else usage.piCoreMetadataRowsRead += rows.length;
        usage.piCoreBytesMaterialized += chars;
      }
      if (render) {
        usage.renderRowsRead += rows.length;
        usage.renderBytesMaterialized += chars;
      }
      if (stream) {
        usage.streamRowsRead += rows.length;
        usage.streamBytesMaterialized += chars;
      }
    }
  };

  const wrappedSql: any = {
    exec(query: string, ...bindings: unknown[]) {
      total.execCalls += 1;
      if (scope) scope.execCalls += 1;
      // A durable render write closes a read/persist batch: everything read
      // since the previous one was resident together to produce it.
      if (isWrite(query) && query.includes(RENDER_TABLE)) {
        bytesSinceRenderWrite = 0;
      }
      const cursor = realExec(query, ...bindings);
      return wrapCursor(cursor, (rows) => record(query, rows));
    },
  };
  Object.defineProperty(wrappedSql, "databaseSize", {
    get: () => realSql.databaseSize,
  });
  for (const key of ["Cursor", "Statement", "prepare", "ingest", "setMaxPageCountForTest"]) {
    if (typeof (realSql as any)[key] === "function") {
      wrappedSql[key] = (realSql as any)[key].bind(realSql);
    } else if ((realSql as any)[key] !== undefined) {
      wrappedSql[key] = (realSql as any)[key];
    }
  }

  // `ctx.storage.sql` is a native accessor; an own data property shadows it.
  // Fall back to replacing `storage` on `ctx` if the runtime refuses.
  let restore: () => void;
  try {
    Object.defineProperty(storage, "sql", {
      value: wrappedSql,
      configurable: true,
      writable: true,
    });
    restore = () => {
      delete (storage as any).sql;
    };
  } catch {
    const proxyStorage = new Proxy(storage, {
      get(target, property, receiver) {
        if (property === "sql") return wrappedSql;
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    Object.defineProperty(instance.ctx, "storage", {
      value: proxyStorage,
      configurable: true,
      writable: true,
    });
    restore = () => {
      Object.defineProperty(instance.ctx, "storage", {
        value: storage,
        configurable: true,
        writable: true,
      });
    };
  }

  const meter: StorageMeter = {
    async measure<T>(fn: () => T | Promise<T>) {
      const previous = scope;
      const usage = emptyUsage();
      scope = usage;
      bytesSinceRenderWrite = 0;
      try {
        const result = await fn();
        return { result, usage };
      } finally {
        scope = previous;
      }
    },
    get total() {
      return total;
    },
    reset() {
      total = emptyUsage();
      bytesSinceRenderWrite = 0;
    },
    uninstall() {
      restore();
      delete (storage as any).__workingSetMeter;
    },
  };
  Object.defineProperty(storage, "__workingSetMeter", {
    value: meter,
    configurable: true,
  });
  return meter;
}
