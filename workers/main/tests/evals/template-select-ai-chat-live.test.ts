import { env } from "cloudflare:test";
import { describe, it } from "vitest";

import { assertPassFailCriteria } from "./eval-criteria";
import { emitEvalTranscript } from "./eval-transcript";
import { getEvalTimeoutMs } from "./model-config";
import {
  runTemplateSelectionEval,
  type TemplateSelectionEvalEnv,
} from "./template-selection-eval";

const testEnv = env as unknown as TemplateSelectionEvalEnv;
const maybeIt = testEnv.RUN_AGENT_EVALS === "1" ? it : it.skip;
const SESSION_TIMEOUT_MS = getEvalTimeoutMs(testEnv, 120_000);

describe("AI chat template intent selection agent eval", () => {
  maybeIt(
    "chooses the AI chat starter for a conversational assistant",
    async () => {
      const outcome = await runTemplateSelectionEval(
        testEnv,
        {
          template: "ai-chat",
          projectPrefix: "support-assistant",
          title: "Support assistant starter selection",
          prompt:
            "It will be a customer-support assistant with a message composer, conversation responses, and server-side model calls through the platform's AI capability.",
          markerPath: "/app/routes/home.tsx",
          markerText: "AI starter",
        },
        SESSION_TIMEOUT_MS,
      );
      emitEvalTranscript(outcome.transcript);
      assertPassFailCriteria(outcome.evaluation);
    },
    SESSION_TIMEOUT_MS + 60_000,
  );
});
