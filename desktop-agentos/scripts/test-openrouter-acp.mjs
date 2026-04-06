import { runAgentOsAcpProbe } from "./probe-acp-stream.mjs";

const OPENROUTER_MODEL = "openai/gpt-5.1-codex";
const OPENROUTER_PROMPT = "Reply with exactly pong.";

function summarizeProbeResult(adapter, probe) {
  const messageChunks = probe.events.filter(
    (event) => event.type === "runtime_event" &&
      event.update?.sessionUpdate === "agent_message_chunk",
  );
  const thoughtChunks = probe.events.filter(
    (event) => event.type === "runtime_event" &&
      event.update?.sessionUpdate === "agent_thought_chunk",
  );

  const chunkText = messageChunks
    .map((event) => typeof event.update?.text === "string" ? event.update.text : "")
    .join("");
  const visibleText = typeof probe.resultText === "string" ? probe.resultText : "";
  const combinedText = `${chunkText}${visibleText}`.toLowerCase();

  return {
    adapter,
    model: probe.model,
    ok: probe.ok === true &&
      probe.error == null &&
      (messageChunks.length > 0 || visibleText.length > 0) &&
      combinedText.includes("pong"),
    resultText: probe.resultText,
    error: probe.error,
    messageChunkCount: messageChunks.length,
    thoughtChunkCount: thoughtChunks.length,
    firstMessageChunkAtMs: messageChunks[0]?.t ?? null,
    firstThoughtChunkAtMs: thoughtChunks[0]?.t ?? null,
  };
}

async function main() {
  if (!process.env.OPENROUTER_API_KEY?.trim()) {
    throw new Error("OPENROUTER_API_KEY is required to run the OpenRouter ACP probe.");
  }

  const adapters = process.env.DESKTOP_AGENTOS_OPENROUTER_ADAPTER?.trim() === "upstream"
    ? ["upstream"]
    : process.env.DESKTOP_AGENTOS_OPENROUTER_ADAPTER?.trim() === "local"
      ? ["local"]
      : ["local", "upstream"];

  const summaries = [];
  for (const adapter of adapters) {
    const probe = await runAgentOsAcpProbe({
      model: OPENROUTER_MODEL,
      prompt: OPENROUTER_PROMPT,
      adapter,
    });
    summaries.push(summarizeProbeResult(adapter, probe));
  }

  process.stdout.write(`${JSON.stringify({ ok: summaries.every((summary) => summary.ok), summaries }, null, 2)}\n`);

  if (!summaries.every((summary) => summary.ok)) {
    process.exitCode = 1;
  }
}

await main();
