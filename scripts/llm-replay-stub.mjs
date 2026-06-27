#!/usr/bin/env node
/**
 * Tiny LLM record/replay stub for deterministic E2E.
 *
 * Point a model's baseUrl here via TEST_LLM_REPLAY_URL (handled in
 * chat-thread-do.ts resolvePiModel). Cassettes are keyed by
 *   sha256(first user message) + "-" + (number of assistant turns so far)
 * which is read straight from each request body. That ordinal key:
 *   - needs no canonicalization (date/id drift in the body doesn't matter),
 *   - is stateless (no per-session counter), so concurrent tests can't collide,
 *   - replays the REAL recorded responses (full fidelity), not fabricated ones.
 *
 * Env:
 *   REPLAY_MODE=replay|record   (default replay)
 *   REPLAY_DIR=e2e/cassettes     where .sse cassettes live
 *   REPLAY_PORT=8788
 *   REPLAY_UPSTREAM=<real base>  required in record mode (e.g. https://openrouter.ai/api/v1)
 */
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const MODE = process.env.REPLAY_MODE || "replay";
const DIR = process.env.REPLAY_DIR || "e2e/cassettes";
const UPSTREAM = (process.env.REPLAY_UPSTREAM || "").replace(/\/+$/, "");
const PORT = Number(process.env.REPLAY_PORT || 8788);
// Inter-event delay (ms) when replaying SSE, so the consumer sees deltas arrive
// over time rather than as one burst (some specs assert streaming timing).
const DELAY_MS = Number(process.env.REPLAY_DELAY_MS || 25);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cassetteKey(bodyText) {
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    body = {};
  }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const firstUser = messages.find((m) => m && m.role === "user");
  const firstUserText = firstUser ? JSON.stringify(firstUser.content) : "";
  // Stabilize keys for prompts that embed timestamps/ids (e.g.
  // `Test message ${Date.now()}` in the E2E suite): collapse long digit runs so
  // a once-recorded cassette still matches on later runs.
  const normalized = firstUserText.replace(/\d{6,}/g, "N");
  const turn = messages.filter((m) => m && m.role === "assistant").length;
  const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return `${hash}-${turn}`;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function contentTypeFor(buf) {
  const head = buf.toString("utf8", 0, 8);
  return head.startsWith("data:") || head.startsWith("event:")
    ? "text/event-stream"
    : "application/json";
}

const server = createServer(async (req, res) => {
  // Health check for Playwright's webServer readiness probe.
  if (req.method === "GET") {
    res.writeHead(200, { "content-type": "text/plain" }).end(`ok (${MODE})`);
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405).end("Method not allowed");
    return;
  }
  const bodyText = await readBody(req);
  const key = cassetteKey(bodyText);
  const file = path.join(DIR, `${key}.sse`);
  console.log(`${MODE} ${req.method} ${req.url} -> key ${key} (${existsSync(file) ? "hit" : "miss"})`);

  if (MODE === "record") {
    if (!UPSTREAM) {
      res.writeHead(500).end("REPLAY_UPSTREAM required in record mode");
      return;
    }
    const upstream = await fetch(UPSTREAM + req.url, {
      method: "POST",
      headers: { ...req.headers, host: new URL(UPSTREAM).host },
      body: bodyText,
    });
    const buf = Buffer.from(await upstream.arrayBuffer());
    await mkdir(DIR, { recursive: true });
    await writeFile(file, buf);
    res.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") || contentTypeFor(buf),
    });
    res.end(buf);
    return;
  }

  // replay
  if (!existsSync(file)) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(
      `llm-replay-stub: no cassette ${key}.sse (key = sha256(first user msg) + assistant-turn). Re-record with REPLAY_MODE=record.`,
    );
    return;
  }
  const data = await readFile(file);
  const ctype = contentTypeFor(data);
  res.writeHead(200, { "content-type": ctype, "cache-control": "no-cache" });
  if (ctype === "text/event-stream" && DELAY_MS > 0) {
    // Replay one SSE event at a time with pacing so streaming-timing assertions
    // (e.g. first vs last delta spacing) hold instead of collapsing to a burst.
    const events = data.toString("utf8").split("\n\n").filter((e) => e.length);
    for (const ev of events) {
      res.write(`${ev}\n\n`);
      await sleep(DELAY_MS);
    }
    res.end();
  } else {
    res.end(data);
  }
});

server.listen(PORT, () => {
  console.log(`llm-replay-stub: ${MODE} on :${PORT} (dir=${DIR})`);
});
