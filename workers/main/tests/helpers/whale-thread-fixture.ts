/**
 * The whale thread every working-set budget is measured against.
 *
 * Shaped after the production threads that killed Durable Objects this month
 * (Salix and its neighbours): thousands of committed pi_core rows, tens of
 * megabytes of stored payload, NO durable compaction row (so nothing bounds a
 * naive read), stamped multi-commit assistant folds, tool calls with their
 * answers, interposed steer messages, and a handful of inline screenshots.
 *
 * Every parameter is explicit so a suite can dial the shape it needs — but the
 * DEFAULT is the one that matters: it is big enough that any O(thread) read
 * blows a budget by an order of magnitude, which is what makes the budgets a net
 * rather than a decoration.
 */

export interface WhaleFixtureOptions {
  /** Approximate committed pi_core rows (rounded up to whole turns). */
  rows?: number;
  /** Approximate total stored payload chars across those rows. */
  totalChars?: number;
  /** Inline base64 images distributed through the thread. */
  images?: number;
  /** Chars of base64 per inline image. */
  imageChars?: number;
  /** Every Nth turn commits its assistant twice around a steer user row. */
  steerEvery?: number;
  /** Every Nth turn is an unstamped legacy turn (position-derived render ids). */
  legacyEvery?: number;
  startTimestamp?: number;
  /**
   * Append to whatever is already stored instead of replacing it, continuing
   * from `MAX(idx) + 1`. What a thread GROWING looks like — the shape stage 2e
   * is measured against, since a fixture that replaces the table can only ever
   * describe a thread that arrived fully formed.
   */
  append?: boolean;
}

export interface WhaleFixture {
  /** Rows in the table after this call (not just the ones it wrote). */
  rows: number;
  /** Stored chars THIS CALL wrote; with `append` the table holds more. */
  totalChars: number;
  turns: number;
  images: number;
  /**
   * Stored chars of the newest `count` rows THIS CALL wrote — what a
   * tail-shaped bound admits.
   */
  tailChars(count: number): number;
  /**
   * Stored chars of the first `count` rows THIS CALL wrote — what a
   * prefix-shaped bound admits.
   */
  prefixChars(count: number): number;
}

const PI_CORE_INSERT =
  "INSERT INTO pi_core_messages (idx, payload, created_at) VALUES (?, ?, ?)";

type AnyRecord = Record<string, unknown>;

/**
 * Seed a whale thread into a REAL DO's SQLite. Rows are inserted through
 * `ctx.storage.sql` directly rather than through the append path: the append
 * path is itself one of the surfaces under budget, and a fixture that used it
 * would spend minutes and measure itself.
 */
export function buildWhaleThreadFixture(
  instance: any,
  options: WhaleFixtureOptions = {},
): WhaleFixture {
  const targetRows = Math.max(8, Math.floor(options.rows ?? 6_000));
  const totalChars = Math.max(1_000, Math.floor(options.totalChars ?? 40_000_000));
  const imageCount = Math.max(0, Math.floor(options.images ?? 12));
  const imageChars = Math.max(1_000, Math.floor(options.imageChars ?? 200_000));
  const steerEvery = Math.max(0, Math.floor(options.steerEvery ?? 7));
  const legacyEvery = Math.max(0, Math.floor(options.legacyEvery ?? 11));
  let timestamp = options.startTimestamp ?? 1_700_000_000_000;

  instance.ensurePiCoreTables();
  if (!options.append) {
    instance.ctx.storage.sql.exec("DELETE FROM pi_core_messages");
    instance.ctx.storage.sql.exec("DELETE FROM pi_core_compaction");
  }
  const startIdx = options.append
    ? Math.max(
        0,
        Number(
          (instance.ctx.storage.sql
            .exec("SELECT COALESCE(MAX(idx) + 1, 0) AS next_idx FROM pi_core_messages")
            .toArray()[0] as { next_idx: number } | undefined)?.next_idx ?? 0,
        ),
      )
    : 0;

  // Rows per turn: user, assistant(+toolCall), toolResult, assistant — plus a
  // steer user and a second assistant commit on steered turns.
  const rowsPerTurn = 4;
  const turns = Math.ceil(targetRows / rowsPerTurn);
  const imageBudget = imageCount * imageChars;
  const textBudget = Math.max(0, totalChars - imageBudget);
  const fillChars = Math.max(64, Math.floor(textBudget / Math.max(1, targetRows)));
  const filler = "x".repeat(fillChars);
  const imageEvery = imageCount > 0 ? Math.max(1, Math.floor(turns / imageCount)) : 0;
  const base64 = "A".repeat(imageChars);

  const charsByIdx: number[] = [];
  let idx = startIdx;
  let imagesWritten = 0;
  const push = (message: AnyRecord): void => {
    const payload = JSON.stringify(message);
    instance.ctx.storage.sql.exec(PI_CORE_INSERT, idx, payload, timestamp);
    charsByIdx.push(payload.length);
    idx += 1;
  };

  for (let turn = 0; turn < turns; turn += 1) {
    const stamped = legacyEvery === 0 || turn % legacyEvery !== 0;
    const turnId = `turn-${turn}`;
    const withImage =
      imageEvery > 0 && imagesWritten < imageCount && turn % imageEvery === 0;

    timestamp += 10;
    push({
      role: "user",
      content: `question ${turn} ${filler}`,
      timestamp,
      ...(stamped ? { uiMetadata: { renderMessageId: `client-user-${turn}` } } : {}),
    });

    timestamp += 10;
    push({
      role: "assistant",
      content: [
        { type: "text", text: `working on ${turn} ${filler}` },
        {
          type: "toolCall",
          id: `call-${turn}`,
          name: withImage ? "take_screenshot" : "read_file",
          arguments: { path: `f${turn}.txt` },
        },
      ],
      timestamp,
      responseId: `resp-${turn}-a`,
      ...(stamped ? { uiMetadata: { renderMessageId: turnId } } : {}),
    });

    timestamp += 10;
    if (withImage) {
      imagesWritten += 1;
      push({
        role: "toolResult",
        toolCallId: `call-${turn}`,
        toolName: "take_screenshot",
        content: [
          { type: "text", text: `screenshot ${turn}` },
          { type: "image", mimeType: "image/png", data: base64 },
        ],
        isError: false,
        timestamp,
      });
    } else {
      push({
        role: "toolResult",
        toolCallId: `call-${turn}`,
        toolName: "read_file",
        content: [{ type: "text", text: `contents of f${turn}.txt ${filler}` }],
        isError: false,
        timestamp,
      });
    }

    if (steerEvery > 0 && turn % steerEvery === 0) {
      timestamp += 10;
      push({
        role: "user",
        content: `steer ${turn}`,
        timestamp,
        sentDuringStreaming: true,
        ...(stamped
          ? { uiMetadata: { renderMessageId: `client-steer-${turn}` } }
          : {}),
      });
      timestamp += 10;
      push({
        role: "assistant",
        content: [{ type: "text", text: `after steer ${turn} ${filler}` }],
        timestamp,
        responseId: `resp-${turn}-steer`,
        ...(stamped ? { uiMetadata: { renderMessageId: turnId } } : {}),
      });
    }

    timestamp += 10;
    push({
      role: "assistant",
      content: [{ type: "text", text: `answer ${turn} part 2 ${filler}` }],
      timestamp,
      responseId: `resp-${turn}-b`,
      ...(stamped ? { uiMetadata: { renderMessageId: turnId } } : {}),
    });
  }

  instance.piCoreStore.markPiCoreChanged(idx);
  const total = charsByIdx.reduce((sum, chars) => sum + chars, 0);
  return {
    rows: idx,
    totalChars: total,
    turns,
    images: imagesWritten,
    tailChars(count: number) {
      return charsByIdx
        .slice(Math.max(0, charsByIdx.length - count))
        .reduce((sum, chars) => sum + chars, 0);
    },
    prefixChars(count: number) {
      return charsByIdx
        .slice(0, Math.max(0, count))
        .reduce((sum, chars) => sum + chars, 0);
    },
  };
}
