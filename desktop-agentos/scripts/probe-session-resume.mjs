import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const TURN_TIMEOUT_MS = Number(process.env.DESKTOP_RESUME_PROBE_TIMEOUT_MS || 420000);
const CODEWORD = process.env.DESKTOP_RESUME_PROBE_CODEWORD || "VELVET-ANCHOR-472";
const FIRST_PROMPT =
  process.env.DESKTOP_RESUME_PROBE_FIRST_PROMPT ||
  `Remember this exact codeword for later in this chat: ${CODEWORD}. Reply with exactly stored.`;
const SECOND_PROMPT =
  process.env.DESKTOP_RESUME_PROBE_SECOND_PROMPT ||
  "What codeword did I ask you to remember earlier in this chat? Reply with only the codeword.";
const probeUserDataDir =
  process.env.DESKTOP_AGENTOS_USER_DATA_DIR ||
  mkdtempSync(join(tmpdir(), "camelai-agentos-probe-resume-"));

process.env.DESKTOP_AGENTOS_WORKSPACE_DIR =
  process.env.DESKTOP_AGENTOS_WORKSPACE_DIR || resolve(process.cwd());
process.env.DESKTOP_AGENTOS_USER_DATA_DIR = probeUserDataDir;
process.env.DESKTOP_USER_DATA_DIR = probeUserDataDir;
process.env.DESKTOP_DATA_DIR = resolve(probeUserDataDir, "data");
process.env.DESKTOP_RUNTIME_DIR = resolve(probeUserDataDir, "runtime");

function extractContentText(content) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) => {
      if (!block || typeof block !== "object") {
        return "";
      }
      if (block.type === "text" && typeof block.text === "string") {
        return block.text;
      }
      if (block.type === "tool_result") {
        return extractContentText(block.content);
      }
      return "";
    })
    .join("")
    .trim();
}

function findLatestAssistant(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "assistant") {
      return messages[index];
    }
  }
  return null;
}

function waitForThreadReady(service) {
  const snapshot = service.getSnapshot();
  if (
    snapshot.runtimeStatus?.state === "running" &&
    typeof snapshot.activeThreadId === "string"
  ) {
    return Promise.resolve({
      threadId: snapshot.activeThreadId,
      snapshot,
    });
  }

  return new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      rejectPromise(
        new Error(`Timed out waiting for AgentOS runtime readiness after ${TURN_TIMEOUT_MS}ms.`),
      );
    }, TURN_TIMEOUT_MS);

    const unsubscribe = service.subscribe((event) => {
      if (event.type !== "snapshot") {
        return;
      }

      if (event.snapshot.runtimeStatus?.state === "error") {
        clearTimeout(timeout);
        unsubscribe();
        rejectPromise(new Error(event.snapshot.runtimeStatus.detail));
        return;
      }

      if (
        event.snapshot.runtimeStatus?.state === "running" &&
        typeof event.snapshot.activeThreadId === "string"
      ) {
        clearTimeout(timeout);
        unsubscribe();
        resolvePromise({
          threadId: event.snapshot.activeThreadId,
          snapshot: event.snapshot,
        });
      }
    });
  });
}

function waitForAssistantMessage(service, threadId, baselineAssistantId) {
  const existing = service.getSnapshot().messagesByThread?.[threadId] ?? [];
  const currentAssistant = findLatestAssistant(existing);
  if (
    currentAssistant?.status === "done" &&
    currentAssistant.id !== baselineAssistantId &&
    extractContentText(currentAssistant.content)
  ) {
    return Promise.resolve({
      message: currentAssistant,
      snapshot: service.getSnapshot(),
    });
  }

  return new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      rejectPromise(
        new Error(`Timed out waiting for assistant completion after ${TURN_TIMEOUT_MS}ms.`),
      );
    }, TURN_TIMEOUT_MS);

    const unsubscribe = service.subscribe((event) => {
      if (event.type === "error" && event.threadId === threadId) {
        clearTimeout(timeout);
        unsubscribe();
        rejectPromise(new Error(event.message));
        return;
      }

      if (event.type !== "snapshot") {
        return;
      }

      const messages = event.snapshot.messagesByThread?.[threadId] ?? [];
      const latestAssistant = findLatestAssistant(messages);
      if (latestAssistant?.status === "error") {
        clearTimeout(timeout);
        unsubscribe();
        rejectPromise(new Error("Assistant message finished with error status."));
        return;
      }

      if (
        latestAssistant?.status === "done" &&
        latestAssistant.id !== baselineAssistantId &&
        extractContentText(latestAssistant.content)
      ) {
        clearTimeout(timeout);
        unsubscribe();
        resolvePromise({
          message: latestAssistant,
          snapshot: event.snapshot,
        });
      }
    });
  });
}

async function sendTurn(service, threadId, content) {
  const baselineAssistantId =
    findLatestAssistant(service.getSnapshot().messagesByThread?.[threadId] ?? [])?.id ?? null;
  service.handleClientEvent({
    type: "send_message",
    threadId,
    content,
  });
  const result = await waitForAssistantMessage(service, threadId, baselineAssistantId);
  return {
    assistantText: extractContentText(result.message.content),
    snapshot: result.snapshot,
  };
}

async function main() {
  const { createDesktopService } = await import("../backend/electron-service.ts");
  const diagnostics = {
    probeUserDataDir,
    firstPrompt: FIRST_PROMPT,
    secondPrompt: SECOND_PROMPT,
    codeword: CODEWORD,
  };

  const service1 = createDesktopService();
  let service2 = null;

  try {
    const ready1 = await waitForThreadReady(service1);
    const firstTurn = await sendTurn(service1, ready1.threadId, FIRST_PROMPT);
    const firstMessages = firstTurn.snapshot.messagesByThread?.[ready1.threadId] ?? [];

    service1.dispose();

    service2 = createDesktopService();
    const ready2 = await waitForThreadReady(service2);
    const restoredMessages = ready2.snapshot.messagesByThread?.[ready2.threadId] ?? [];
    const secondTurn = await sendTurn(service2, ready2.threadId, SECOND_PROMPT);

    const remembered = secondTurn.assistantText.trim();
    if (!remembered.includes(CODEWORD)) {
      throw new Error(
        `Expected resumed session to remember ${CODEWORD}, got: ${remembered || "(empty response)"}`,
      );
    }

    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          ...diagnostics,
          threadId: ready2.threadId,
          firstAssistantText: firstTurn.assistantText,
          secondAssistantText: secondTurn.assistantText,
          restoredMessageCount: restoredMessages.length,
          firstRunMessageCount: firstMessages.length,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    service2?.dispose();
    service1.dispose();
  }
}

main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify(
      {
        ok: false,
        probeUserDataDir,
        codeword: CODEWORD,
        message: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    )}\n`,
  );
  process.exit(1);
});
