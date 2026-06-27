#!/usr/bin/env node
/**
 * Deterministic fake LLM for E2E tests.
 *
 * The worker routes every model call here when `TEST_LLM_REPLAY_URL` is set
 * (see resolvePiModel in chat-thread-do.ts and resolveCloudflareGatewayOrigin in
 * src/lib/cloudflare-ai-gateway.ts). Instead of calling a real model, this server
 * returns a canned response — so chat turns are fully deterministic, offline, and
 * need no credits or API keys. We verify the chat *flow* (send -> stream renders ->
 * turn completes), not real model output, so a scripted reply is enough.
 *
 * It speaks both wire formats, picked per request so each provider's parser is
 * satisfied: the default local model (sonnet) hits the Anthropic Messages API
 * (`/v1/messages`, `event:`-named SSE), while Workers-AI / OpenAI-compat calls
 * hit `/chat/completions` (`data:{choices}` SSE). Non-streamed requests get the
 * matching JSON completion.
 *
 * The reply is lightly prompt-aware: if the last user message says
 * `Reply with: <text>` (or `Reply with exactly: <text>`), it echoes <text>;
 * otherwise it returns a fixed line.
 *
 * Env: FAKE_LLM_PORT (default 8788), FAKE_LLM_DELAY_MS (default 25).
 */
import { createServer } from "node:http";

const PORT = Number(process.env.FAKE_LLM_PORT || 8788);
const DELAY_MS = Number(process.env.FAKE_LLM_DELAY_MS || 25);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function lastUserText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const lastUser = [...messages].reverse().find((m) => m && m.role === "user");
  const c = lastUser?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c))
    return c.map((b) => (typeof b === "string" ? b : (b?.text ?? ""))).join(" ");
  return "";
}

function replyText(body) {
  const content = lastUserText(body);
  const m = content.match(/reply with(?: exactly)?(?: one word)?:?\s*([^\n"]+)/i);
  return m ? m[1].trim() : "Deterministic test reply from the fake LLM.";
}

function words(text) {
  return text.split(" ").map((w, i) => (i ? " " : "") + w);
}

// --- Anthropic Messages API (/v1/messages) ---------------------------------
function anthropicSSE(text) {
  const events = [
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_fake", type: "message", role: "assistant", model: "fake", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
  ];
  for (const w of words(text)) {
    events.push(
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: w } })}\n\n`,
    );
  }
  events.push(
    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
  );
  return events;
}
function anthropicJSON(text) {
  return JSON.stringify({
    id: "msg_fake",
    type: "message",
    role: "assistant",
    model: "fake",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  });
}

// --- OpenAI chat-completions (/chat/completions) ---------------------------
function openaiSSE(text) {
  const events = words(text).map(
    (w, i) =>
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { ...(i === 0 ? { role: "assistant" } : {}), content: w } }] })}\n\n`,
  );
  events.push(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n",
  );
  return events;
}
function openaiJSON(text) {
  return JSON.stringify({
    choices: [
      { index: 0, finish_reason: "stop", message: { role: "assistant", content: text } },
    ],
  });
}

const server = createServer(async (req, res) => {
  if (req.method === "GET") {
    res.writeHead(200, { "content-type": "text/plain" }).end("ok (fake-llm)");
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405).end("Method not allowed");
    return;
  }
  const bodyText = await readBody(req);
  let body = {};
  try {
    body = JSON.parse(bodyText);
  } catch {
    /* ignore */
  }
  const text = replyText(body);
  // Anthropic Messages API: path ends in /messages (vs /chat/completions); the
  // request also carries top-level system/max_tokens with content-block messages.
  const anthropic = /\/messages(?:\?|$)/.test(req.url) && !/chat\/completions/.test(req.url);

  if (body.stream === true) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    for (const ev of anthropic ? anthropicSSE(text) : openaiSSE(text)) {
      res.write(ev);
      await sleep(DELAY_MS);
    }
    res.end();
    return;
  }

  res.writeHead(200, { "content-type": "application/json" });
  res.end(anthropic ? anthropicJSON(text) : openaiJSON(text));
});

server.listen(PORT, () => console.log(`fake-llm on :${PORT}`));
