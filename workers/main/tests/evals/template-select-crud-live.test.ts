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

describe("CRUD template intent selection agent eval", () => {
  maybeIt(
    "chooses the CRUD starter for a stateful operations tool",
    async () => {
      const outcome = await runTemplateSelectionEval(
        testEnv,
        {
          template: "crud",
          projectPrefix: "inventory-ops",
          title: "Inventory operations starter selection",
          prompt:
            "It will be an internal inventory tracker where staff create, edit, complete, and delete restock requests, with records persisted between visits.",
          markerPath: "/app/routes/home.tsx",
          markerText: "Durable CRUD starter",
        },
        SESSION_TIMEOUT_MS,
      );
      emitEvalTranscript(outcome.transcript);
      assertPassFailCriteria(outcome.evaluation);
    },
    SESSION_TIMEOUT_MS + 60_000,
  );
});
