import { describe, expect, it, vi } from "vitest";
import {
  RUNTIME_REQUEST_ID,
  initialRuntimeRequestId,
  runtimeDirectThreadsEnabled,
  startErrorStillCurrent,
} from "@/lib/agent-runtime-shared";

// The runtime's own check (agent-runtime src/client-sessions.ts `validId`).
const RUNTIME_VALID_ID = /^[A-Za-z0-9_-]{1,80}$/;

describe("runtime request ids", () => {
  it("gives a new thread's first message an id the runtime accepts", () => {
    const id = initialRuntimeRequestId("0f8fad5b-d9cb-469f-a165-70867728950e");
    expect(RUNTIME_VALID_ID.test(id)).toBe(true);
    expect(id).toBe("initial_0f8fad5b-d9cb-469f-a165-70867728950e");
  });

  it("accepts exactly what the runtime accepts", () => {
    for (const id of ["client_1790000000000_ab12cd34", "initial_x", "a".repeat(80)]) {
      expect(RUNTIME_REQUEST_ID.test(id)).toBe(RUNTIME_VALID_ID.test(id));
      expect(RUNTIME_REQUEST_ID.test(id)).toBe(true);
    }
    for (const id of ["initial:thread", "", "a".repeat(81), "has space", "slash/id"]) {
      expect(RUNTIME_REQUEST_ID.test(id)).toBe(false);
    }
  });
});

describe("runtimeDirectThreadsEnabled", () => {
  const tenant = { AGENT_RUNTIME_API_TOKEN: "t", AGENT_RUNTIME_TENANT: "x", AGENT_RUNTIME_DEFINITION: "d" };
  it("is on only with the tenant and the switch", () => {
    expect(runtimeDirectThreadsEnabled({ ...tenant, AGENT_RUNTIME_DIRECT_THREADS: "1" })).toBe(true);
    expect(runtimeDirectThreadsEnabled(tenant)).toBe(false);
    expect(runtimeDirectThreadsEnabled({ AGENT_RUNTIME_DIRECT_THREADS: "1" })).toBe(false);
  });
});

describe("startErrorStillCurrent", () => {
  const error = { id: "rt-start:100", error: "LLM usage limit reached.", at: 100 };
  it("keeps a refusal while nothing newer reached the agent, even once the agent exists", () => {
    expect(startErrorStillCurrent(error, [])).toEqual({ id: "rt-start:100", error: "LLM usage limit reached." });
    expect(startErrorStillCurrent(error, [{ message: { role: "user", timestamp: 50 } }])).not.toBeNull();
  });
  it("drops it once a newer message reached the agent", () => {
    expect(startErrorStillCurrent(error, [{ message: { role: "assistant", timestamp: 150 } }])).toBeNull();
    expect(startErrorStillCurrent(null, [])).toBeNull();
  });
});

vi.mock("@/lib/runtime-threads.server", () => ({
  requestWorkspaceId: () => null,
  requireRuntimeThread: vi.fn(async () => { throw new Error("must not reach access checks"); }),
}));
vi.mock("@/lib/wait-until", () => ({ waitUntil: vi.fn() }));
vi.mock("../workers/main/src/agent-runtime/thread-runtime", () => ({ startRuntimeTurn: vi.fn() }));

describe("POST /api/threads/:id/messages", () => {
  it("refuses a client message id the runtime would refuse", async () => {
    const { action } = await import("@/routes/api/threads.$id.messages");
    const response = await action({
      request: new Request("https://camelai.test/api/threads/t1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "hi", clientMessageId: "initial:t1" }),
      }),
      context: {},
      params: { id: "t1" },
    } as never) as Response;
    expect(response.status).toBe(400);
  });
});
