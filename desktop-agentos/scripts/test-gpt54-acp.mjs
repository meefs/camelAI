import { runAgentOsAcpProbe } from "./probe-acp-stream.mjs";

function summarizeProbeResult(adapter, probe) {
  const messageChunks = probe.events.filter(
    (event) => event.type === "runtime_event" &&
      event.update?.sessionUpdate === "agent_message_chunk",
  );
  const thoughtChunks = probe.events.filter(
    (event) => event.type === "runtime_event" &&
      event.update?.sessionUpdate === "agent_thought_chunk",
  );

  const hasCheckingChunk = messageChunks.some((event) =>
    typeof event.update?.text === "string" && event.update.text.includes("Checking")
  );
  const hasDoneChunk = messageChunks.some((event) =>
    typeof event.update?.text === "string" && event.update.text.includes("Done")
  );
  const checkingCount = typeof probe.resultText === "string"
    ? probe.resultText.split("Checking now.").length - 1
    : 0;
  const doneCount = typeof probe.resultText === "string"
    ? probe.resultText.split("Done checking.").length - 1
    : 0;

  return {
    adapter,
    model: probe.model,
    ok: probe.ok === true &&
      probe.error == null &&
      typeof probe.resultText === "string" &&
      probe.resultText.length > 0 &&
      messageChunks.length > 0 &&
      hasCheckingChunk &&
      hasDoneChunk &&
      checkingCount === 1 &&
      doneCount === 1,
    resultText: probe.resultText,
    messageChunkCount: messageChunks.length,
    thoughtChunkCount: thoughtChunks.length,
    hasCheckingChunk,
    hasDoneChunk,
    checkingCount,
    doneCount,
    firstMessageChunkAtMs: messageChunks[0]?.t ?? null,
    firstThoughtChunkAtMs: thoughtChunks[0]?.t ?? null,
  };
}

async function main() {
  const adapters = process.env.DESKTOP_AGENTOS_GPT54_ADAPTER?.trim() === "upstream"
    ? ["upstream"]
    : process.env.DESKTOP_AGENTOS_GPT54_ADAPTER?.trim() === "local"
      ? ["local"]
      : ["local", "upstream"];

  const summaries = [];
  for (const adapter of adapters) {
    const probe = await runAgentOsAcpProbe({
      model: "gpt-5.4",
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
