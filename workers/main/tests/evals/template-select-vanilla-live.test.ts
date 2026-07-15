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

describe("vanilla template intent selection agent eval", () => {
  maybeIt(
    "chooses the dependency-light starter for a client-only browser game",
    async () => {
      const outcome = await runTemplateSelectionEval(
        testEnv,
        {
          template: "vanilla",
          projectPrefix: "orbit-quiz",
          title: "Client-only browser game starter selection",
          prompt:
            "It will be a small browser quiz game made with plain HTML, CSS, and JavaScript. Everything runs in the browser, with no accounts, database, shared leaderboard, server records, or multiplayer state.",
          markerPath: "/public/index.html",
          markerText: "Vanilla web starter",
        },
        SESSION_TIMEOUT_MS,
      );
      emitEvalTranscript(outcome.transcript);
      assertPassFailCriteria(outcome.evaluation);
    },
    SESSION_TIMEOUT_MS + 60_000,
  );
});
